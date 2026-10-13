import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { executorCargoArguments } from "./build-native-executor.js";

test("Windows executor links reproducibly without changing other binary targets", () => {
  assert.deepEqual(executorCargoArguments("x86_64-pc-windows-msvc"), [
    "rustc", "--locked", "--release", "--manifest-path",
    "native-executor/Cargo.toml", "--target", "x86_64-pc-windows-msvc",
    "--bin", "judgedesk-native-executor", "--", "-C", "link-arg=/Brepro",
  ]);
});

test("macOS executor retains the locked release build recipe", () => {
  assert.deepEqual(executorCargoArguments("aarch64-apple-darwin"), [
    "build", "--locked", "--release", "--manifest-path",
    "native-executor/Cargo.toml", "--target", "aarch64-apple-darwin",
  ]);
});

test("approved executor freeze binds raw source bytes and fixed Windows identity", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const freeze = JSON.parse(fs.readFileSync(
    path.join(root, "docs/reports/executor-freeze-2026-10-12.json"), "utf8",
  ));
  const nativeSources = (directory) => fs.readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => entry.isDirectory()
      ? nativeSources(path.join(directory, entry.name))
      : entry.name.endsWith(".rs") ? [path.join(directory, entry.name)] : []);
  const required = [
    ...nativeSources(path.join(root, "native-executor/src"))
      .map(file => path.relative(root, file).replaceAll("\\", "/")),
    "native-executor/build.rs", "native-executor/Cargo.toml", "native-executor/Cargo.lock",
    "rust-toolchain.toml", ".gitattributes", "scripts/build-native-executor.js",
    "scripts/build-server-target.js", "package.json",
  ].sort();
  assert.deepEqual(freeze.inputs.map(input => input.path), required);
  for (const input of freeze.inputs) {
    const digest = crypto.createHash("sha256")
      .update(fs.readFileSync(path.join(root, input.path))).digest("hex");
    assert.equal(digest, input.sha256, `refreeze required after input change: ${input.path}`);
  }
  const boundary = fs.readFileSync(
    path.join(root, "crates/judgedesk-core/tests/executor_boundary_test.rs"), "utf8",
  );
  const fixedHash = boundary.match(/FROZEN_WINDOWS_EXECUTOR_SHA256: &str\s*=\s*"([A-F0-9]{64})"/);
  const fixedSize = boundary.match(/FROZEN_WINDOWS_EXECUTOR_SIZE_BYTES: usize\s*=\s*(\d+)/);
  assert.ok(fixedHash && fixedSize, "boundary tests must retain literal identity pins");
  assert.equal(fixedHash[1].toLowerCase(), freeze.artifact.sha256);
  assert.equal(Number(fixedSize[1]), freeze.artifact.sizeBytes);
});
