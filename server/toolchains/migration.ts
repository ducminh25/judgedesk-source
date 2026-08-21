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
 * Migrates toolchains from legacy built-in location (e.g. Program Files/JudgeDesk/toolchains)
 * to per-user safe storage (%LOCALAPPDATA%/ThemisV2/toolchains).
 *
 * Performs Cut & Paste (move/copy + delete source) to:
 * 1. Ensure toolchains persist across fast Core updates.
 * 2. Delete source in Program Files to free ~800MB disk space.
 * 3. Preserve .judgedesk-package.json receipt for 100% certified status in Core edition.
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

  if (!fs.existsSync(builtInRoot)) {
    return result;
  }

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(builtInRoot, { withFileTypes: true });
  } catch (error) {
    result.errors.push(
      `Failed to read built-in toolchains directory: ${error instanceof Error ? error.message : String(error)}`,
    );
    return result;
  }

  fs.mkdirSync(downloadedRoot, { recursive: true });

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const packageId = entry.name;
    const sourceDir = path.join(builtInRoot, packageId);
    const destDir = path.join(downloadedRoot, packageId);

    try {
      const sourceSizeBytes = getDirectorySizeBytes(sourceDir);

      // Check if dest already has a valid receipt and files
      const destReceiptPath = path.join(destDir, TOOLCHAIN_PACKAGE_RECEIPT);
      const destExists = fs.existsSync(destDir);
      const destHasReceipt = destExists && fs.existsSync(destReceiptPath);

      if (destHasReceipt) {
        // Destination is already complete, remove source to free disk space
        try {
          fs.rmSync(sourceDir, { recursive: true, force: true });
          result.freedBytes += sourceSizeBytes;
          result.migratedPackages.push(packageId);
        } catch {
          // If deletion failed (e.g. read-only permissions), destination is still ready
          result.migratedPackages.push(packageId);
        }
        continue;
      }

      // Try fast atomic rename / move
      let moved = false;
      try {
        if (!destExists) {
          fs.renameSync(sourceDir, destDir);
          moved = true;
        }
      } catch {
        moved = false;
      }

      if (!moved) {
        // Fallback: copy recursively and then delete source
        fs.cpSync(sourceDir, destDir, { recursive: true, force: true });
        try {
          fs.rmSync(sourceDir, { recursive: true, force: true });
        } catch {
          // Source deletion non-fatal
        }
      }

      result.freedBytes += sourceSizeBytes;
      result.migratedPackages.push(packageId);
    } catch (error) {
      result.errors.push(
        `Failed to migrate toolchain '${packageId}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Try to clean up empty built-in root directory if possible
  try {
    const remaining = fs.readdirSync(builtInRoot);
    if (remaining.length === 0) {
      fs.rmSync(builtInRoot, { recursive: true, force: true });
    }
  } catch {
    // Non-fatal
  }

  return result;
}
