import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  TOOLCHAIN_RELEASE_BLUEPRINTS,
} from "../server/toolchains/manifest.js";
import {
  buildToolchainSourceProvenance,
  TOOLCHAIN_RELEASE_SOURCES,
  validateToolchainSourceProvenance,
  validateToolchainReleaseSources,
} from "./toolchain-release-sources.js";
import {
  writeToolchainPackageMetadata,
} from "./write-toolchain-package-metadata.js";

test("release sources cover every signed package blueprint exactly once", () => {
  assert.doesNotThrow(validateToolchainReleaseSources);
  assert.deepEqual(
    Object.keys(TOOLCHAIN_RELEASE_SOURCES).sort(),
    Object.keys(TOOLCHAIN_RELEASE_BLUEPRINTS).sort(),
  );
});

test("Full host sets include every managed language on each supported host", () => {
  const hostPackages = (platform: "win32" | "darwin", arch: "x64" | "arm64") =>
    Object.values(TOOLCHAIN_RELEASE_SOURCES)
      .filter((entry) => entry.platform === platform && entry.arch === arch)
      .map((entry) => entry.packageId)
      .sort();

  assert.deepEqual(hostPackages("win32", "x64"), [
    "dotnet10-windows-x64",
    "fpc-windows-x64",
    "gcc-windows-x64",
    "go-windows-x64",
    "node-windows-x64",
    "python-windows-x64",
    "rust-windows-x64-gnu",
    "temurin21-windows-x64",
  ]);
  assert.deepEqual(hostPackages("darwin", "arm64"), [
    "dotnet10-macos-arm64",
    "fpc-macos-arm64",
    "go-macos-arm64",
    "node-macos-arm64",
    "python-macos-arm64",
    "rust-macos-arm64",
    "temurin21-macos-arm64",
  ]);
  assert.deepEqual(hostPackages("darwin", "x64"), []);
  assert.equal(hostPackages("win32", "x64").length, 8);
});

test("all release inputs are immutable checksum-pinned HTTPS resources", () => {
  for (const source of Object.values(TOOLCHAIN_RELEASE_SOURCES)) {
    for (const input of source.inputs) {
      assert.match(input.url, /^https:\/\//);
      assert.doesNotMatch(input.url, /\/latest(?:\/|$)|[?&]version=latest/i);
      assert.match(input.sha256, /^[a-f0-9]{64}$/);
      if (input.sha512) assert.match(input.sha512, /^[a-f0-9]{128}$/);
    }
  }
});

test("source provenance rejects catalog drift and metadata records exact inputs", (t) => {
  const createdAt = "2026-07-31T00:00:00.000Z";
  const provenance = buildToolchainSourceProvenance(
    "python-windows-x64",
    createdAt,
  );
  assert.equal(
    validateToolchainSourceProvenance(
      provenance,
      "python-windows-x64",
    ).inputs[0].sha256,
    TOOLCHAIN_RELEASE_SOURCES["python-windows-x64"].inputs[0].sha256,
  );
  assert.throws(
    () => validateToolchainSourceProvenance(
      {
        ...provenance,
        inputs: [{ ...provenance.inputs[0], sha256: "0".repeat(64) }],
      },
      "python-windows-x64",
    ),
    /does not match the pinned release catalog/,
  );

  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "judgedesk-package-metadata-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "LICENSE.txt"), "Python license\n");
  writeToolchainPackageMetadata(root, "python-windows-x64", { createdAt });

  const notice = fs.readFileSync(
    path.join(root, "THIRD-PARTY-NOTICES.txt"),
    "utf8",
  );
  assert.match(notice, /checksum-pinned upstream release inputs/);
  assert.doesNotMatch(notice, /unmodified upstream binary distribution/);
  const sbom = JSON.parse(
    fs.readFileSync(path.join(root, "SBOM.spdx.json"), "utf8"),
  );
  assert.equal(sbom.spdxVersion, "SPDX-2.3");
  assert.match(
    sbom.packages[0].externalRefs[0].referenceLocator,
    /#sha256=[a-f0-9]{64}$/,
  );
});
