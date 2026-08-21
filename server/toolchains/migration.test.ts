import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  migrateLegacyBundledToolchains,
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

test("migrateLegacyBundledToolchains moves legacy toolchains, preserves receipts, and deletes source", () => {
  withTempSandbox(({ builtInRoot, downloadedRoot }) => {
    const packageId = "gcc-windows-x64";
    const srcPackageDir = path.join(builtInRoot, packageId);
    fs.mkdirSync(path.join(srcPackageDir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(srcPackageDir, "bin", "g++.exe"), "dummy-compiler-binary");
    fs.writeFileSync(
      path.join(srcPackageDir, TOOLCHAIN_PACKAGE_RECEIPT),
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

    const result = migrateLegacyBundledToolchains({ builtInRoot, downloadedRoot });

    assert.equal(result.errors.length, 0);
    assert.deepEqual(result.migratedPackages, [packageId]);
    assert.ok(result.freedBytes > 0);

    const destPackageDir = path.join(downloadedRoot, packageId);
    assert.ok(fs.existsSync(destPackageDir));
    assert.ok(fs.existsSync(path.join(destPackageDir, TOOLCHAIN_PACKAGE_RECEIPT)));
    assert.ok(fs.existsSync(path.join(destPackageDir, "bin", "g++.exe")));

    // Source directory should be deleted
    assert.ok(!fs.existsSync(srcPackageDir));
  });
});

test("migrateLegacyBundledToolchains removes source when destination already exists with valid receipt", () => {
  withTempSandbox(({ builtInRoot, downloadedRoot }) => {
    const packageId = "python-windows-x64";
    const srcPackageDir = path.join(builtInRoot, packageId);
    const destPackageDir = path.join(downloadedRoot, packageId);

    fs.mkdirSync(srcPackageDir, { recursive: true });
    fs.writeFileSync(path.join(srcPackageDir, "python.exe"), "dummy");
    fs.writeFileSync(path.join(srcPackageDir, TOOLCHAIN_PACKAGE_RECEIPT), "{}");

    fs.mkdirSync(destPackageDir, { recursive: true });
    fs.writeFileSync(path.join(destPackageDir, "python.exe"), "dummy-dest");
    fs.writeFileSync(path.join(destPackageDir, TOOLCHAIN_PACKAGE_RECEIPT), "{}");

    const result = migrateLegacyBundledToolchains({ builtInRoot, downloadedRoot });

    assert.equal(result.errors.length, 0);
    assert.deepEqual(result.migratedPackages, [packageId]);
    // Source should be removed
    assert.ok(!fs.existsSync(srcPackageDir));
    // Dest should still be there
    assert.ok(fs.existsSync(destPackageDir));
  });
});

test("migrateLegacyBundledToolchains handles missing or empty builtInRoot gracefully", () => {
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
