import assert from "node:assert/strict";
import test from "node:test";
import {
  TOOLCHAIN_RELEASE_BLUEPRINTS,
} from "../server/toolchains/manifest.js";
import {
  TOOLCHAIN_RELEASE_SOURCES,
  validateToolchainReleaseSources,
} from "./toolchain-release-sources.js";

test("release sources cover every signed package blueprint exactly once", () => {
  assert.doesNotThrow(validateToolchainReleaseSources);
  assert.deepEqual(
    Object.keys(TOOLCHAIN_RELEASE_SOURCES).sort(),
    Object.keys(TOOLCHAIN_RELEASE_BLUEPRINTS).sort(),
  );
});

test("Full host sets are deliberate and Java remains macOS-only", () => {
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
  assert.equal(
    Object.keys(TOOLCHAIN_RELEASE_SOURCES).some((id) =>
      id.includes("temurin") && id.includes("windows")
    ),
    false,
  );
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
