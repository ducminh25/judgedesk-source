import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeWindowsVerbatimPath, RESOURCE_ROOT } from "../runtime.js";
import {
  getDownloadedToolchainsDir,
  getExecutorCacheToolchainsDir,
} from "./storage.js";
import {
  getBuiltInToolchainsDir,
  TOOLCHAIN_PACKAGE_RECEIPT,
} from "./package-store.js";
import { TOOLCHAIN_RELEASE_BLUEPRINTS } from "./manifest.js";
import {
  getLocalExecutionPolicyFilePath,
  saveLocalExecutionPolicy,
} from "./execution-policy.js";

export interface ToolchainMigrationOptions {
  builtInRoot?: string;
  downloadedRoot?: string;
  executorCacheRoot?: string;
  candidateRoots?: string[];
}

export interface ToolchainMigrationResult {
  migratedPackages: string[];
  freedBytes: number;
  errors: string[];
}

/**
 * Calculates total size in bytes of a directory tree.
 */
function getDirectorySizeBytes(dirPath: string): number {
  let total = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        total += getDirectorySizeBytes(fullPath);
      } else if (entry.isFile()) {
        total += fs.statSync(fullPath).size;
      }
    }
  } catch {
    // Ignore errors during size calculation
  }
  return total;
}

interface CandidatePackage {
  dirPath: string;
  packageId: string;
  version: string;
  archiveSha256: string;
  hasReceipt: boolean;
}

function inspectCandidateDirectory(dirPath: string): CandidatePackage | null {
  const receiptPath = path.join(dirPath, TOOLCHAIN_PACKAGE_RECEIPT);
  if (!fs.existsSync(receiptPath)) return null;

  const folderName = path.basename(dirPath);
  let packageId = folderName;
  let version = "";
  let archiveSha256 = "";

  try {
    const bytes = fs.readFileSync(receiptPath);
    if (bytes.byteLength > 0 && bytes.byteLength <= 16 * 1024) {
      const receipt = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
      if (typeof receipt.packageId === "string" && receipt.packageId.trim()) {
        packageId = receipt.packageId.trim();
      }
      if (typeof receipt.version === "string") {
        version = receipt.version;
      }
      if (typeof receipt.archiveSha256 === "string") {
        archiveSha256 = receipt.archiveSha256.toLowerCase();
      }
    }
  } catch {
    // If JSON parsing fails, use folderName
  }

  // If folderName has version suffix (e.g. gcc-windows-x64_14.2.0 or python-windows-x64-3.12.13)
  // and packageId is still folderName, derive packageId by matching known blueprints
  if (packageId === folderName) {
    for (const blueprintId of Object.keys(TOOLCHAIN_RELEASE_BLUEPRINTS)) {
      if (
        folderName === blueprintId
        || folderName.startsWith(`${blueprintId}_`)
        || folderName.startsWith(`${blueprintId}-`)
      ) {
        packageId = blueprintId;
        break;
      }
    }
  }

  return {
    dirPath,
    packageId,
    version,
    archiveSha256,
    hasReceipt: true,
  };
}

/**
 * Reconciles toolchain storage to ensure zero duplicate copies between
 * read-only application resources (e.g. Program Files/resources/toolchains)
 * and per-user storage (%LOCALAPPDATA%/ThemisV2/toolchains).
 *
 * Behavior:
 * 1. Full Edition: Built-in toolchains remain in application resources and are used
 *    directly (zero startup copy, instant launch, shared across all local OS users).
 *    If an identical package already exists in per-user AppData from a previous version
 *    or manual download, the AppData duplicate is safely removed to free ~800MB.
 * 2. Core Edition / Post-Update: When built-in toolchains are absent (e.g. after updating
 *    from Full to Core MSI), scans executor cache and legacy roots for JudgeDesk managed
 *    packages, migrates them to the canonical safe per-user directory (%LOCALAPPDATA%/ThemisV2/toolchains),
 *    and removes duplicate copies to retain only the single safest location.
 * 3. Preserves any additional downloaded languages (e.g. Rust, Go) that are not bundled.
 * 4. External compilers (MinGW, Dev-C++, FreePascal, Themis 1.x) lacking a .judgedesk-package.json
 *    receipt are never touched or modified.
 */
export function migrateLegacyBundledToolchains(
  options?: ToolchainMigrationOptions,
): ToolchainMigrationResult {
  const result: ToolchainMigrationResult = {
    migratedPackages: [],
    freedBytes: 0,
    errors: [],
  };

  const builtInRoot = normalizeWindowsVerbatimPath(
    options?.builtInRoot ?? getBuiltInToolchainsDir(),
  );
  const downloadedRoot = normalizeWindowsVerbatimPath(
    options?.downloadedRoot ?? getDownloadedToolchainsDir(),
  );
  const executorCacheRoot = normalizeWindowsVerbatimPath(
    options?.executorCacheRoot
      ?? (options?.downloadedRoot || options?.builtInRoot
        ? path.join(path.dirname(downloadedRoot), "executor-toolchains")
        : getExecutorCacheToolchainsDir()),
  );

  // If built-in and downloaded directories are identical (e.g. in test mocks), skip
  if (builtInRoot.toLowerCase() === downloadedRoot.toLowerCase()) {
    return result;
  }

  // Scenario 1: Built-in toolchains exist (Full edition)
  if (fs.existsSync(builtInRoot)) {
    let builtInEntries: fs.Dirent[] = [];
    try {
      builtInEntries = fs.readdirSync(builtInRoot, { withFileTypes: true });
    } catch (error) {
      result.errors.push(
        `Failed to read built-in toolchains directory: ${error instanceof Error ? error.message : String(error)}`,
      );
      return result;
    }

    let foundBuiltInPackages = false;
    for (const entry of builtInEntries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const packageId = entry.name;
      const builtInDir = path.join(builtInRoot, packageId);
      const downloadedDir = path.join(downloadedRoot, packageId);

      const builtInReceiptPath = path.join(builtInDir, TOOLCHAIN_PACKAGE_RECEIPT);
      if (!fs.existsSync(builtInReceiptPath)) continue;
      foundBuiltInPackages = true;

      if (fs.existsSync(downloadedDir)) {
        try {
          const duplicateSizeBytes = getDirectorySizeBytes(downloadedDir);
          fs.rmSync(downloadedDir, { recursive: true, force: true });
          result.freedBytes += duplicateSizeBytes;
          result.migratedPackages.push(packageId);
        } catch (error) {
          result.errors.push(
            `Failed to remove duplicate toolchain '${packageId}' from AppData: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    if (foundBuiltInPackages) {
      try {
        if (
          fs.existsSync(downloadedRoot)
          && fs.readdirSync(downloadedRoot).length === 0
        ) {
          fs.rmSync(downloadedRoot, { recursive: true, force: true });
        }
      } catch {
        // Non-fatal
      }
      return result;
    }
  }

  // Scenario 2: Built-in root is absent or contains no toolchains (Core edition / update from Full to Core).
  // Target location is downloadedRoot (%LOCALAPPDATA%/ThemisV2/toolchains).
  const scanRoots: string[] = [];
  if (
    fs.existsSync(executorCacheRoot)
    && executorCacheRoot.toLowerCase() !== downloadedRoot.toLowerCase()
  ) {
    scanRoots.push(executorCacheRoot);
  }

  const legacyJudgeDeskToolchains = normalizeWindowsVerbatimPath(
    path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "JudgeDesk",
      "toolchains",
    ),
  );
  if (
    fs.existsSync(legacyJudgeDeskToolchains)
    && legacyJudgeDeskToolchains.toLowerCase() !== downloadedRoot.toLowerCase()
    && !scanRoots.some(
      (r) => r.toLowerCase() === legacyJudgeDeskToolchains.toLowerCase(),
    )
  ) {
    scanRoots.push(legacyJudgeDeskToolchains);
  }

  if (options?.candidateRoots) {
    for (const r of options.candidateRoots) {
      const norm = normalizeWindowsVerbatimPath(r);
      if (
        fs.existsSync(norm)
        && norm.toLowerCase() !== downloadedRoot.toLowerCase()
        && !scanRoots.some((s) => s.toLowerCase() === norm.toLowerCase())
      ) {
        scanRoots.push(norm);
      }
    }
  }

  const allCandidates: CandidatePackage[] = [];
  for (const root of scanRoots) {
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const cand = inspectCandidateDirectory(path.join(root, entry.name));
        if (cand) allCandidates.push(cand);
      }
    } catch {
      // Skip unreadable
    }
  }

  if (fs.existsSync(downloadedRoot)) {
    try {
      const entries = fs.readdirSync(downloadedRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const cand = inspectCandidateDirectory(path.join(downloadedRoot, entry.name));
        if (cand) allCandidates.push(cand);
      }
    } catch {
      // Skip unreadable
    }
  }

  if (allCandidates.length === 0) {
    return result;
  }

  const candidatesByPackage = new Map<string, CandidatePackage[]>();
  for (const cand of allCandidates) {
    const list = candidatesByPackage.get(cand.packageId) ?? [];
    list.push(cand);
    candidatesByPackage.set(cand.packageId, list);
  }

  for (const [packageId, candidates] of candidatesByPackage.entries()) {
    const canonicalDir = path.join(downloadedRoot, packageId);
    let canonicalValid = false;

    if (
      fs.existsSync(canonicalDir)
      && fs.existsSync(path.join(canonicalDir, TOOLCHAIN_PACKAGE_RECEIPT))
    ) {
      canonicalValid = true;
    }

    if (!canonicalValid) {
      const bestCandidate = candidates.find(
        (c) => c.dirPath.toLowerCase() !== canonicalDir.toLowerCase(),
      );
      if (bestCandidate) {
        try {
          fs.mkdirSync(downloadedRoot, { recursive: true });
          fs.renameSync(bestCandidate.dirPath, canonicalDir);
          result.migratedPackages.push(packageId);
          canonicalValid = true;
        } catch {
          try {
            fs.cpSync(bestCandidate.dirPath, canonicalDir, { recursive: true });
            try {
              fs.rmSync(bestCandidate.dirPath, { recursive: true, force: true });
            } catch {
              // Non-fatal
            }
            result.migratedPackages.push(packageId);
            canonicalValid = true;
          } catch (copyError) {
            result.errors.push(
              `Failed to migrate toolchain '${packageId}' to '${canonicalDir}': ${copyError instanceof Error ? copyError.message : String(copyError)}`,
            );
          }
        }
      }
    }

    if (canonicalValid) {
      for (const cand of candidates) {
        if (!fs.existsSync(cand.dirPath)) continue;
        if (cand.dirPath.toLowerCase() === canonicalDir.toLowerCase()) continue;
        try {
          const size = getDirectorySizeBytes(cand.dirPath);
          fs.rmSync(cand.dirPath, { recursive: true, force: true });
          result.freedBytes += size;
        } catch (error) {
          result.errors.push(
            `Failed to remove duplicate toolchain at '${cand.dirPath}': ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  }

  return result;
}

/**
 * Initialize missing policies without increasing local execution privileges.
 * Existing documents are preserved so the loader can explain disabled legacy
 * settings and recovery errors instead of silently losing that evidence.
 */
export function migrateLegacyExecutionPolicy(options?: {
  policyFilePath?: string;
}): boolean {
  try {
    const policyPath = options?.policyFilePath ?? getLocalExecutionPolicyFilePath();
    try {
      fs.lstatSync(policyPath);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
    saveLocalExecutionPolicy(false, policyPath);
    return true;
  } catch {
    // Non-fatal if policy cannot be read or migrated
  }
  return false;
}
