import fs from "node:fs";
import path from "node:path";
import { normalizeWindowsVerbatimPath, RESOURCE_ROOT } from "../runtime.js";
import { getDownloadedToolchainsDir } from "./storage.js";
import {
  getBuiltInToolchainsDir,
  TOOLCHAIN_PACKAGE_RECEIPT,
} from "./package-store.js";

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
 * 2. Core Edition: Uses %LOCALAPPDATA%/ThemisV2/toolchains directly for on-demand downloads.
 * 3. Preserves any additional downloaded languages (e.g. Rust, Go) that are not bundled.
 */
export function migrateLegacyBundledToolchains(options?: {
  builtInRoot?: string;
  downloadedRoot?: string;
}): ToolchainMigrationResult {
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

  // If built-in and downloaded directories are identical (e.g. in test mocks), skip
  if (builtInRoot.toLowerCase() === downloadedRoot.toLowerCase()) {
    return result;
  }

  // If no built-in toolchains exist (Core edition) or no downloaded folder exists, nothing to deduplicate
  if (!fs.existsSync(builtInRoot) || !fs.existsSync(downloadedRoot)) {
    return result;
  }

  let builtInEntries: fs.Dirent[] = [];
  try {
    builtInEntries = fs.readdirSync(builtInRoot, { withFileTypes: true });
  } catch (error) {
    result.errors.push(
      `Failed to read built-in toolchains directory: ${error instanceof Error ? error.message : String(error)}`,
    );
    return result;
  }

  for (const entry of builtInEntries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const packageId = entry.name;
    const builtInDir = path.join(builtInRoot, packageId);
    const downloadedDir = path.join(downloadedRoot, packageId);

    // Verify built-in directory has a valid receipt
    const builtInReceiptPath = path.join(builtInDir, TOOLCHAIN_PACKAGE_RECEIPT);
    const builtInHasReceipt = fs.existsSync(builtInReceiptPath);

    if (fs.existsSync(downloadedDir) && builtInHasReceipt) {
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

  // Clean up empty downloadedRoot directory if all duplicate packages were removed
  try {
    const remaining = fs.readdirSync(downloadedRoot);
    if (remaining.length === 0) {
      fs.rmSync(downloadedRoot, { recursive: true, force: true });
    }
  } catch {
    // Non-fatal
  }

  return result;
}
