import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { targetTripleForHost } from "./build-server-target.js";
import {
  bundleServer,
  replaceFileAtomically,
  resolveTarget,
} from "./build-server-lib.js";

test("sidecar target names match Tauri target triples", () => {
  assert.equal(targetTripleForHost("win32", "x64"), "x86_64-pc-windows-msvc");
  assert.equal(targetTripleForHost("darwin", "x64"), "x86_64-apple-darwin");
  assert.equal(targetTripleForHost("darwin", "arm64"), "aarch64-apple-darwin");
  assert.equal(targetTripleForHost("linux", "x64"), "x86_64-unknown-linux-gnu");
  assert.equal(
    targetTripleForHost("linux", "arm64"),
    "aarch64-unknown-linux-gnu",
  );
  assert.throws(() => targetTripleForHost("win32", "arm64"), /Unsupported/);
});

test("resolveTarget matches host targets and handles errors", () => {
  // Matching host architecture should succeed
  assert.equal(
    resolveTarget("win32", "x64", "x86_64-pc-windows-msvc"),
    "x86_64-pc-windows-msvc",
  );
  assert.equal(
    resolveTarget("darwin", "arm64", "aarch64-apple-darwin"),
    "aarch64-apple-darwin",
  );

  // No environment target specified should default to host target
  assert.equal(
    resolveTarget("win32", "x64", undefined),
    "x86_64-pc-windows-msvc",
  );

  // Mismatch target should throw a helpful error
  assert.throws(
    () => resolveTarget("win32", "x64", "aarch64-apple-darwin"),
    /Cannot build aarch64-apple-darwin sidecar/,
  );
  assert.throws(
    () => resolveTarget("darwin", "x64", "universal-apple-darwin"),
    /Cannot build universal-apple-darwin sidecar/,
  );
});

test("replaceFileAtomically replaces an existing sidecar without leaving staging files", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "themis-sidecar-atomic-"),
  );
  const sourcePath = path.join(directory, "new.exe");
  const finalPath = path.join(directory, "server.exe");
  try {
    fs.writeFileSync(sourcePath, "new-sidecar");
    fs.writeFileSync(finalPath, "old-sidecar");

    replaceFileAtomically(sourcePath, finalPath);

    assert.equal(fs.readFileSync(finalPath, "utf8"), "new-sidecar");
    assert.deepEqual(fs.readdirSync(directory).sort(), [
      "new.exe",
      "server.exe",
    ]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("bundleServer uses esbuild's cross-platform JavaScript API", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "themis-esbuild-"));
  try {
    fs.writeFileSync(
      path.join(directory, "server.ts"),
      "const answer: number = 42; console.log(answer);",
    );

    bundleServer(directory, "server.ts", "dist/server.cjs");

    const output = fs.readFileSync(
      path.join(directory, "dist", "server.cjs"),
      "utf8",
    );
    assert.match(output, /42/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("release workflow uses Xcode-compatible lipo argument ordering", () => {
  const workflow = fs.readFileSync(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  assert.match(
    workflow,
    /lipo "\$universal_sidecar" -verify_arch x86_64 arm64/,
  );
  assert.doesNotMatch(workflow, /lipo -verify_arch[^\n]+universal_sidecar/);
});

test("universal DMG build provides native and universal Tauri sidecars", () => {
  const workflow = fs.readFileSync(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const dmgJob = workflow.slice(
    workflow.indexOf("  build-macos-universal-dmg:"),
    workflow.indexOf("  release:"),
  );
  assert.match(dmgJob, /name: server-macos-x64/);
  assert.match(dmgJob, /name: server-macos-arm64/);
  assert.match(dmgJob, /name: server-macos-universal/);
  assert.match(
    dmgJob,
    /server-universal-apple-darwin -verify_arch x86_64 arm64/,
  );
  assert.match(dmgJob, /Contents\/MacOS\/server" -verify_arch x86_64 arm64/);
});

test("unsigned macOS builds do not expose empty certificate variables to Tauri", () => {
  const workflow = fs.readFileSync(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const dmgJob = workflow.slice(
    workflow.indexOf("  build-macos-universal-dmg:"),
    workflow.indexOf("  release:"),
  );
  const jobEnvironment = dmgJob.slice(0, dmgJob.indexOf("    steps:"));
  assert.doesNotMatch(jobEnvironment, /APPLE_CERTIFICATE/);
  assert.match(dmgJob, /if \[ -z "\$APPLE_CERTIFICATE" \]/);
  assert.match(dmgJob, /unset APPLE_SIGNING_IDENTITY/);
  assert.match(dmgJob, /unset APPLE_API_ISSUER APPLE_API_KEY/);
});
