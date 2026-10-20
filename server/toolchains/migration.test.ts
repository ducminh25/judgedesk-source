import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  migrateLegacyBundledToolchains,
  migrateLegacyExecutionPolicy,
} from "./migration.js";
import { TOOLCHAIN_PACKAGE_RECEIPT } from "./package-store.js";

function withTempSandbox(
  run: (dirs: { builtInRoot: string; downloadedRoot: string }) => void,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "toolchain-migration-test-"));
  const builtInRoot = path.join(root, "builtin-toolchains");
  const downloadedRoot = path.join(root, "downloaded-toolchains");
  fs.mkdirSync(builtInRoot, { recursive: true });
  fs.mkdirSync(downloadedRoot, { recursive: true });

  try {
    run({ builtInRoot, downloadedRoot });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("migrateLegacyBundledToolchains removes AppData duplicate when built-in package is present", () => {
  withTempSandbox(({ builtInRoot, downloadedRoot }) => {
    const packageId = "gcc-windows-x64";
    const builtInPackageDir = path.join(builtInRoot, packageId);
    const downloadedPackageDir = path.join(downloadedRoot, packageId);

    // Setup built-in package
    fs.mkdirSync(path.join(builtInPackageDir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(builtInPackageDir, "bin", "g++.exe"), "dummy-compiler-binary");
    fs.writeFileSync(
      path.join(builtInPackageDir, TOOLCHAIN_PACKAGE_RECEIPT),
      JSON.stringify({
        schemaVersion: 1,
        packageId,
        version: "14.2.0",
        archiveSha256: "abc1234",
        entrypointComponentId: "g++",
        components: [
          {
            id: "g++",
            kind: "executable",
            relativePath: "bin/g++.exe",
            roles: ["compiler"],
          },
        ],
      }),
    );

    // Setup duplicate in downloaded
    fs.mkdirSync(path.join(downloadedPackageDir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(downloadedPackageDir, "bin", "g++.exe"), "dummy-duplicate");
    fs.writeFileSync(path.join(downloadedPackageDir, TOOLCHAIN_PACKAGE_RECEIPT), "{}");

    const result = migrateLegacyBundledToolchains({ builtInRoot, downloadedRoot });

    assert.equal(result.errors.length, 0);
    assert.deepEqual(result.migratedPackages, [packageId]);
    assert.ok(result.freedBytes > 0);

    // Built-in package MUST remain intact
    assert.ok(fs.existsSync(builtInPackageDir));
    assert.ok(fs.existsSync(path.join(builtInPackageDir, TOOLCHAIN_PACKAGE_RECEIPT)));
    assert.ok(fs.existsSync(path.join(builtInPackageDir, "bin", "g++.exe")));

    // Downloaded duplicate directory should be removed to free disk space
    assert.ok(!fs.existsSync(downloadedPackageDir));
  });
});

test("migrateLegacyBundledToolchains preserves extra downloaded packages that are not built-in", () => {
  withTempSandbox(({ builtInRoot, downloadedRoot }) => {
    const builtInId = "gcc-windows-x64";
    const extraDownloadedId = "rust-windows-x64";

    const builtInPackageDir = path.join(builtInRoot, builtInId);
    fs.mkdirSync(builtInPackageDir, { recursive: true });
    fs.writeFileSync(path.join(builtInPackageDir, TOOLCHAIN_PACKAGE_RECEIPT), "{}");

    const extraPackageDir = path.join(downloadedRoot, extraDownloadedId);
    fs.mkdirSync(extraPackageDir, { recursive: true });
    fs.writeFileSync(path.join(extraPackageDir, TOOLCHAIN_PACKAGE_RECEIPT), "{}");

    const result = migrateLegacyBundledToolchains({ builtInRoot, downloadedRoot });

    assert.equal(result.errors.length, 0);
    assert.deepEqual(result.migratedPackages, []);

    // Built-in remains
    assert.ok(fs.existsSync(builtInPackageDir));
    // Extra downloaded package remains
    assert.ok(fs.existsSync(extraPackageDir));
  });
});

test("migrateLegacyBundledToolchains handles missing or empty roots gracefully", () => {
  withTempSandbox(({ builtInRoot, downloadedRoot }) => {
    const nonExistent = path.join(builtInRoot, "does-not-exist");
    const result = migrateLegacyBundledToolchains({
      builtInRoot: nonExistent,
      downloadedRoot,
    });
    assert.deepEqual(result.migratedPackages, []);
    assert.equal(result.errors.length, 0);
  });
});

test("migrateLegacyBundledToolchains migrates toolchain from executorCacheRoot to downloadedRoot when builtInRoot is absent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "toolchain-migration-exec-"));
  const downloadedRoot = path.join(root, "downloaded-toolchains");
  const executorCacheRoot = path.join(root, "executor-toolchains");
  fs.mkdirSync(downloadedRoot, { recursive: true });
  fs.mkdirSync(executorCacheRoot, { recursive: true });

  try {
    const packageId = "gcc-windows-x64";
    const cacheDirName = `${packageId}_14.2.0`;
    const cachedPackageDir = path.join(executorCacheRoot, cacheDirName);

    fs.mkdirSync(path.join(cachedPackageDir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(cachedPackageDir, "bin", "g++.exe"), "compiler-binary");
    fs.writeFileSync(
      path.join(cachedPackageDir, TOOLCHAIN_PACKAGE_RECEIPT),
      JSON.stringify({
        schemaVersion: 1,
        packageId,
        version: "14.2.0",
        archiveSha256: "0da7f5ce533705777ab711871777e09fb8232987c2144547054c726dd00e1a36",
        entrypointComponentId: "gcc.cxx",
        components: [
          {
            id: "gcc.cxx",
            kind: "executable",
            relativePath: "bin/g++.exe",
            roles: ["compiler"],
          },
        ],
      }),
    );

    const result = migrateLegacyBundledToolchains({
      builtInRoot: path.join(root, "non-existent-builtin"),
      downloadedRoot,
      executorCacheRoot,
    });

    assert.equal(result.errors.length, 0);
    assert.deepEqual(result.migratedPackages, [packageId]);

    // Destination in downloadedRoot must now exist with the canonical packageId name
    const canonicalDir = path.join(downloadedRoot, packageId);
    assert.ok(fs.existsSync(canonicalDir));
    assert.ok(fs.existsSync(path.join(canonicalDir, TOOLCHAIN_PACKAGE_RECEIPT)));
    assert.ok(fs.existsSync(path.join(canonicalDir, "bin", "g++.exe")));

    // Source in executorCacheRoot was moved or removed
    assert.ok(!fs.existsSync(cachedPackageDir));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("migrateLegacyBundledToolchains deduplicates multiple copies and frees disk space", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "toolchain-migration-dedup-"));
  const downloadedRoot = path.join(root, "downloaded-toolchains");
  const executorCacheRoot = path.join(root, "executor-toolchains");
  fs.mkdirSync(downloadedRoot, { recursive: true });
  fs.mkdirSync(executorCacheRoot, { recursive: true });

  try {
    const packageId = "python-windows-x64";
    const canonicalDir = path.join(downloadedRoot, packageId);
    const staleDuplicateDir = path.join(executorCacheRoot, `${packageId}-3.12.13`);

    // Setup valid canonical in downloadedRoot
    fs.mkdirSync(path.join(canonicalDir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(canonicalDir, "bin", "python.exe"), "python-canonical");
    fs.writeFileSync(
      path.join(canonicalDir, TOOLCHAIN_PACKAGE_RECEIPT),
      JSON.stringify({
        schemaVersion: 1,
        packageId,
        version: "3.12.13",
        archiveSha256: "4c2ae1e91234567890abcdef1234567890abcdef1234567890abcdef12345678",
        entrypointComponentId: "python.exe",
        components: [
          {
            id: "python.exe",
            kind: "executable",
            relativePath: "bin/python.exe",
            roles: ["submission-runtime"],
          },
        ],
      }),
    );

    // Setup duplicate in executorCacheRoot
    fs.mkdirSync(path.join(staleDuplicateDir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(staleDuplicateDir, "bin", "python.exe"), "python-duplicate");
    fs.writeFileSync(
      path.join(staleDuplicateDir, TOOLCHAIN_PACKAGE_RECEIPT),
      JSON.stringify({
        schemaVersion: 1,
        packageId,
        version: "3.12.13",
        archiveSha256: "4c2ae1e91234567890abcdef1234567890abcdef1234567890abcdef12345678",
        entrypointComponentId: "python.exe",
        components: [
          {
            id: "python.exe",
            kind: "executable",
            relativePath: "bin/python.exe",
            roles: ["submission-runtime"],
          },
        ],
      }),
    );

    const result = migrateLegacyBundledToolchains({
      builtInRoot: path.join(root, "non-existent-builtin"),
      downloadedRoot,
      executorCacheRoot,
    });

    assert.equal(result.errors.length, 0);
    assert.ok(result.freedBytes > 0);

    // Canonical remains intact
    assert.ok(fs.existsSync(canonicalDir));
    // Stale duplicate is removed
    assert.ok(!fs.existsSync(staleDuplicateDir));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("migrateLegacyBundledToolchains preserves active executor cache directory with matching import-complete marker", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "toolchain-migration-active-cache-"));
  const downloadedRoot = path.join(root, "downloaded-toolchains");
  const executorCacheRoot = path.join(root, "executor-toolchains");
  fs.mkdirSync(downloadedRoot, { recursive: true });
  fs.mkdirSync(executorCacheRoot, { recursive: true });

  try {
    const packageId = "gcc-windows-x64";
    const version = "14.2.0";
    const archiveSha256 = "0da7f5ce533705777ab711871777e09fb8232987c2144547054c726dd00e1a36";
    const canonicalDir = path.join(downloadedRoot, packageId);
    const activeCacheDir = path.join(executorCacheRoot, `${packageId}_${version}`);
    const receiptJson = JSON.stringify({
      schemaVersion: 1,
      packageId,
      version,
      archiveSha256,
      entrypointComponentId: "gcc.cxx",
      components: [
        {
          id: "gcc.cxx",
          kind: "executable",
          relativePath: "bin/g++.exe",
          roles: ["compiler"],
        },
      ],
    });

    fs.mkdirSync(path.join(canonicalDir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(canonicalDir, "bin", "g++.exe"), "g++-canonical");
    fs.writeFileSync(path.join(canonicalDir, TOOLCHAIN_PACKAGE_RECEIPT), receiptJson);

    fs.mkdirSync(path.join(activeCacheDir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(activeCacheDir, "bin", "g++.exe"), "g++-cached");
    fs.writeFileSync(path.join(activeCacheDir, TOOLCHAIN_PACKAGE_RECEIPT), receiptJson);
    fs.writeFileSync(
      path.join(activeCacheDir, ".judgedesk-import-complete"),
      `4-receipt-digest\n${packageId}\n${version}\n${archiveSha256}\n`,
      "utf8",
    );

    const result = migrateLegacyBundledToolchains({
      builtInRoot: path.join(root, "non-existent-builtin"),
      downloadedRoot,
      executorCacheRoot,
    });

    assert.equal(result.errors.length, 0);
    assert.equal(result.freedBytes, 0);
    assert.ok(fs.existsSync(canonicalDir));
    assert.ok(fs.existsSync(activeCacheDir));
    assert.ok(fs.existsSync(path.join(activeCacheDir, ".judgedesk-import-complete")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("migrateLegacyBundledToolchains ignores external directories lacking receipt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "toolchain-migration-external-"));
  const downloadedRoot = path.join(root, "downloaded-toolchains");
  const executorCacheRoot = path.join(root, "executor-toolchains");
  fs.mkdirSync(downloadedRoot, { recursive: true });
  fs.mkdirSync(executorCacheRoot, { recursive: true });

  try {
    // External MinGW folder without receipt
    const externalDir = path.join(executorCacheRoot, "mingw64");
    fs.mkdirSync(path.join(externalDir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(externalDir, "bin", "gcc.exe"), "external-gcc");

    const result = migrateLegacyBundledToolchains({
      builtInRoot: path.join(root, "non-existent-builtin"),
      downloadedRoot,
      executorCacheRoot,
    });

    assert.equal(result.errors.length, 0);
    assert.deepEqual(result.migratedPackages, []);
    assert.equal(result.freedBytes, 0);

    // External dir must remain untouched
    assert.ok(fs.existsSync(externalDir));
    assert.ok(!fs.existsSync(path.join(downloadedRoot, "mingw64")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("migrateLegacyExecutionPolicy preserves an existing strict policy byte-for-byte", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-migration-test-"));
  try {
    const policyFile = path.join(tempDir, "toolchain-execution-policy-v1.json");
    fs.writeFileSync(
      policyFile,
      JSON.stringify({ schemaVersion: 1, allowResourceOnlyLocalExecution: false }, null, 2),
      "utf8",
    );

    const before = fs.readFileSync(policyFile);
    const migrated = migrateLegacyExecutionPolicy({ policyFilePath: policyFile });
    assert.equal(migrated, false);
    assert.deepEqual(fs.readFileSync(policyFile), before);

    const after = JSON.parse(fs.readFileSync(policyFile, "utf8"));
    assert.equal(after.allowResourceOnlyLocalExecution, false);
    assert.equal(after.schemaVersion, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("migrateLegacyExecutionPolicy does not modify already true policy", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-migration-test-"));
  try {
    const policyFile = path.join(tempDir, "toolchain-execution-policy-v1.json");
    fs.writeFileSync(
      policyFile,
      JSON.stringify({ schemaVersion: 1, allowResourceOnlyLocalExecution: true }, null, 2),
      "utf8",
    );

    const migrated = migrateLegacyExecutionPolicy({ policyFilePath: policyFile });
    assert.equal(migrated, false);

    const after = JSON.parse(fs.readFileSync(policyFile, "utf8"));
    assert.equal(after.allowResourceOnlyLocalExecution, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("migrateLegacyExecutionPolicy creates a strict policy when the file does not exist", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-migration-test-"));
  try {
    const policyFile = path.join(tempDir, "sub", "toolchain-execution-policy-v1.json");
    const migrated = migrateLegacyExecutionPolicy({ policyFilePath: policyFile });
    assert.equal(migrated, true);

    const after = JSON.parse(fs.readFileSync(policyFile, "utf8"));
    assert.equal(after.allowResourceOnlyLocalExecution, false);
    assert.deepEqual(fs.readdirSync(path.dirname(policyFile)), [path.basename(policyFile)]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("migration never rewrites corrupt, oversized, or future-schema policy documents", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-migration-test-"));
  try {
    const policyFile = path.join(tempDir, "toolchain-execution-policy-v1.json");
    for (const contents of [
      "{not-json",
      JSON.stringify({ schemaVersion: 2, allowResourceOnlyLocalExecution: false }),
      `${JSON.stringify({ schemaVersion: 1, allowResourceOnlyLocalExecution: false })}${" ".repeat(8 * 1024)}`,
    ]) {
      fs.writeFileSync(policyFile, contents, "utf8");
      assert.equal(migrateLegacyExecutionPolicy({ policyFilePath: policyFile }), false);
      assert.equal(fs.readFileSync(policyFile, "utf8"), contents);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
