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

test("migrateLegacyExecutionPolicy migrates false to true automatically", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-migration-test-"));
  try {
    const policyFile = path.join(tempDir, "toolchain-execution-policy-v1.json");
    fs.writeFileSync(
      policyFile,
      JSON.stringify({ schemaVersion: 1, allowResourceOnlyLocalExecution: false }, null, 2),
      "utf8",
    );

    const migrated = migrateLegacyExecutionPolicy({ policyFilePath: policyFile });
    assert.equal(migrated, true);

    const after = JSON.parse(fs.readFileSync(policyFile, "utf8"));
    assert.equal(after.allowResourceOnlyLocalExecution, true);
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

test("migrateLegacyExecutionPolicy creates default true policy when file does not exist", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-migration-test-"));
  try {
    const policyFile = path.join(tempDir, "sub", "toolchain-execution-policy-v1.json");
    const migrated = migrateLegacyExecutionPolicy({ policyFilePath: policyFile });
    assert.equal(migrated, true);

    const after = JSON.parse(fs.readFileSync(policyFile, "utf8"));
    assert.equal(after.allowResourceOnlyLocalExecution, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
