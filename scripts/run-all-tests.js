#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Directories to scan for tests
const SCAN_DIRS = ["src", "server", "scripts", "shared"];

// Ignored directories
const IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "src-tauri",
  ".git",
  ".agents",
  ".system_generated",
]);

// Integration test directories that require external OS daemon harnesses
const INTEGRATION_ONLY_DIRS = [
  path.join("server", "executor-tests"),
];

export function findTestFiles(dirPath, includeIntegration = false) {
  const absoluteDir = path.join(repoRoot, dirPath);
  if (!fs.existsSync(absoluteDir)) return [];

  const results = [];
  const entries = fs.readdirSync(absoluteDir, { withFileTypes: true });

  for (const entry of entries) {
    const relativePath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      if (!includeIntegration && INTEGRATION_ONLY_DIRS.some((d) => relativePath.startsWith(d))) {
        continue;
      }
      results.push(...findTestFiles(relativePath, includeIntegration));
    } else if (entry.isFile()) {
      if (/\.test\.(?:ts|tsx|js|mjs)$/.test(entry.name)) {
        results.push(relativePath.replace(/\\/g, "/"));
      }
    }
  }

  return results;
}

export function isSafeTestAppDataDir(dir) {
  if (!dir || typeof dir !== "string") return false;

  const resolved = path.resolve(dir);
  const isWindows = process.platform === "win32";

  // 1. Walk up to find the nearest existing ancestor on disk (using lstatSync so broken junctions/symlinks are not skipped).
  let curr = resolved;
  const missingParts = [];
  while (true) {
    try {
      fs.lstatSync(curr);
      break;
    } catch {
      const parent = path.dirname(curr);
      if (parent === curr) {
        return false;
      }
      missingParts.unshift(path.basename(curr));
      curr = parent;
    }
  }

  // 2. Reject any reparse point / junction / symlink in the full ancestor chain from the nearest existing ancestor up to root.
  let ancestor = curr;
  while (true) {
    try {
      const stat = fs.lstatSync(ancestor);
      if (stat.isSymbolicLink()) {
        const isSystemPosixLink = !isWindows && (ancestor === "/var" || ancestor === "/tmp");
        if (!isSystemPosixLink) {
          return false;
        }
      }
    } catch {
      return false;
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }

  // 3. Resolve canonical existing ancestor
  let canonicalExisting = curr;
  try {
    canonicalExisting = fs.realpathSync(curr);
  } catch {
    return false;
  }

  const canonicalDir = missingParts.length > 0
    ? path.join(canonicalExisting, ...missingParts)
    : canonicalExisting;

  // 4. Require canonical containment of the existing ancestor within approved OS temp directory
  let canonicalTemp = os.tmpdir();
  try {
    canonicalTemp = fs.realpathSync(os.tmpdir());
  } catch {}
  const checkTemp = isWindows ? canonicalTemp.toLowerCase() : canonicalTemp;
  const checkExisting = isWindows ? canonicalExisting.toLowerCase() : canonicalExisting;
  const checkPath = isWindows ? canonicalDir.toLowerCase() : canonicalDir;

  if (checkExisting !== checkTemp && !checkExisting.startsWith(checkTemp + path.sep)) {
    return false;
  }
  if (checkPath !== checkTemp && !checkPath.startsWith(checkTemp + path.sep)) {
    return false;
  }

  // 5. Reject host AppData, homedir, and any path containing themisv2 (case-insensitive) on BOTH checkPath and checkExisting
  const localAppData = process.env.LOCALAPPDATA ? path.resolve(process.env.LOCALAPPDATA) : "";
  const checkLocalAppData = isWindows ? localAppData.toLowerCase() : localAppData;
  if (checkLocalAppData && (
    checkPath === checkLocalAppData || checkPath.startsWith(checkLocalAppData + path.sep) ||
    checkExisting === checkLocalAppData || checkExisting.startsWith(checkLocalAppData + path.sep)
  )) {
    if (checkPath.includes("themisv2") || checkExisting.includes("themisv2") || checkPath === checkLocalAppData || checkExisting === checkLocalAppData) {
      return false;
    }
  }

  const appData = process.env.APPDATA ? path.resolve(process.env.APPDATA) : "";
  const checkAppData = isWindows ? appData.toLowerCase() : appData;
  if (checkAppData && (
    checkPath === checkAppData || checkPath.startsWith(checkAppData + path.sep) ||
    checkExisting === checkAppData || checkExisting.startsWith(checkAppData + path.sep)
  )) {
    if (checkPath.includes("themisv2") || checkExisting.includes("themisv2") || checkPath === checkAppData || checkExisting === checkAppData) {
      return false;
    }
  }

  const home = path.resolve(os.homedir());
  const checkHome = isWindows ? home.toLowerCase() : home;
  if (
    checkPath === checkHome || checkPath.startsWith(path.join(checkHome, "documents") + path.sep) || checkPath === path.join(checkHome, "documents") ||
    checkExisting === checkHome || checkExisting.startsWith(path.join(checkHome, "documents") + path.sep) || checkExisting === path.join(checkHome, "documents")
  ) {
    return false;
  }

  if (checkPath.includes("themisv2") || checkExisting.includes("themisv2")) {
    return false;
  }

  // 6. Require an explicit ownership marker. A recognizable basename alone is not authority
  // to write into or recursively clean an existing directory.
  const markerFile = path.join(canonicalDir, ".judgedesk-test-root");
  let hasFileMarker = false;
  try {
    hasFileMarker = fs.lstatSync(markerFile).isFile()
      && fs.readFileSync(markerFile, "utf8") === "judgedesk-test-owned\n";
  } catch {
    hasFileMarker = false;
  }
  if (!hasFileMarker) {
    return false;
  }

  return true;
}

export function resolveTestAppDataDir(env) {
  if (env.THEMIS_APP_DATA_DIR) {
    if (!isSafeTestAppDataDir(env.THEMIS_APP_DATA_DIR)) {
      throw new Error(
        `Unsafe THEMIS_APP_DATA_DIR detected: "${env.THEMIS_APP_DATA_DIR}". Refusing to run tests against host or unverified directory.`,
      );
    }
    return { dir: env.THEMIS_APP_DATA_DIR, owned: false };
  }
  const ownedDir = fs.mkdtempSync(path.join(os.tmpdir(), "jd_test_server_appdata_"));
  try {
    fs.writeFileSync(path.join(ownedDir, ".judgedesk-test-root"), "judgedesk-test-owned\n", "utf8");
  } catch (markerError) {
    try {
      fs.rmSync(ownedDir, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [markerError, cleanupError],
        `Failed to mark and clean owned test root at ${ownedDir}`,
      );
    }
    throw markerError;
  }
  return { dir: ownedDir, owned: true };
}

export function evaluateChildResult(result, cleanupError) {
  if (cleanupError) {
    return 1;
  }
  if (!result || result.error) {
    return 1;
  }
  if (result.signal !== null) {
    return 1;
  }
  if (result.status === null || result.status !== 0) {
    return result.status ?? 1;
  }
  return 0;
}

export function main() {
  const args = process.argv.slice(2);
  let filterPattern = null;
  let includeIntegration = false;
  let dryRun = false;
  const extraFlags = [];

  for (const arg of args) {
    if (arg.startsWith("--filter=")) {
      filterPattern = new RegExp(arg.slice(9), "i");
    } else if (arg === "--include-integration") {
      includeIntegration = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg.startsWith("-")) {
      extraFlags.push(arg);
    } else {
      // Positional filter
      filterPattern = new RegExp(arg, "i");
    }
  }

  const allTestFiles = [];
  for (const dir of SCAN_DIRS) {
    allTestFiles.push(...findTestFiles(dir, includeIntegration));
  }

  // Sort files for deterministic execution order
  allTestFiles.sort();

  const selectedFiles = filterPattern
    ? allTestFiles.filter((f) => filterPattern.test(f))
    : allTestFiles;

  if (selectedFiles.length === 0) {
    console.error(`[run-all-tests] No test files matched filter: ${filterPattern}`);
    process.exit(1);
  }

  console.log(
    `[run-all-tests] Found ${allTestFiles.length} total test files on disk. Running ${selectedFiles.length} selected suite(s)...`,
  );

  if (dryRun) {
    for (const file of selectedFiles) {
      console.log(`  - ${file}`);
    }
    process.exit(0);
  }

  const runnerArgs = [
    "--test",
    "--test-concurrency=1",
    ...extraFlags,
    ...selectedFiles,
  ];

  let isolatedAppData = null;
  let ownedByRunner = false;
  const env = { ...process.env };
  try {
    const resolved = resolveTestAppDataDir(env);
    env.THEMIS_APP_DATA_DIR = resolved.dir;
    const testLocalAppData = path.join(resolved.dir, "localappdata");
    const testAppData = path.join(resolved.dir, "roamingappdata");
    fs.mkdirSync(testLocalAppData, { recursive: true });
    fs.mkdirSync(testAppData, { recursive: true });
    env.LOCALAPPDATA = testLocalAppData;
    env.APPDATA = testAppData;
    if (resolved.owned) {
      isolatedAppData = resolved.dir;
      ownedByRunner = true;
    }
  } catch (err) {
    console.error("[run-all-tests] Fatal configuration error:", err.message);
    process.exit(1);
  }

  const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  let result;
  let cleanupError = null;
  try {
    result = spawnSync(process.execPath, [tsxCli, ...runnerArgs], {
      cwd: repoRoot,
      stdio: "inherit",
      env,
    });
  } finally {
    if (isolatedAppData && ownedByRunner && fs.existsSync(isolatedAppData)) {
      try {
        fs.rmSync(isolatedAppData, { recursive: true, force: true });
        if (fs.existsSync(isolatedAppData)) {
          cleanupError = new Error(
            `Failed to remove isolated AppData directory: path still exists at ${isolatedAppData}`,
          );
        }
      } catch (err) {
        cleanupError = err;
      }
    }
  }

  if (cleanupError) {
    console.error("[run-all-tests] Cleanup failure on isolated test environment:", cleanupError);
  }

  if (result && result.error) {
    console.error("[run-all-tests] Failed to spawn tsx runner:", result.error);
  } else if (result && result.signal !== null) {
    console.error(`[run-all-tests] Test runner process terminated abnormally by signal: ${result.signal}`);
  }

  const exitCode = evaluateChildResult(result, cleanupError);
  process.exit(exitCode);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
