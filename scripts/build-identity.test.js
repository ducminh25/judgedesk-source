import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { resolveBuildMetadata } from "./build-server-lib.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jd-identity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "9.8.7" }));
  return root;
}
const packaged = {
  JUDGEDESK_BUILD_MODE: "packaged", JUDGEDESK_APP_VERSION: "9.8.7",
  JUDGEDESK_GIT_COMMIT: "a".repeat(40), JUDGEDESK_BUILD_SOURCE_STATE: "dirty",
  JUDGEDESK_BUILD_NUMBER: "42", SOURCE_DATE_EPOCH: "1700000000",
};
test("packaged metadata is deterministic and retains legacy fields with truthful identity", (t) => {
  const root = fixture(t);
  const actual = resolveBuildMetadata(root, packaged);
  assert.deepEqual(actual, {
    appVersion: "9.8.7", gitCommit: "a".repeat(40), buildNumber: "42",
    builtAt: "2023-11-14T22:13:20.000Z", backend: "node", sourceState: "dirty",
    buildMode: "packaged", target: process.platform === "win32" ? "x86_64-pc-windows-msvc" : process.platform === "darwin" ? (process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin") : (process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu"), features: [],
  });
  assert.deepEqual(resolveBuildMetadata(root, packaged), actual);
});
for (const name of Object.keys(packaged).filter((name) => name !== "JUDGEDESK_BUILD_MODE")) {
  test(`packaged identity rejects missing ${name}`, (t) => {
    const env = { ...packaged }; delete env[name];
    assert.throws(() => resolveBuildMetadata(fixture(t), env), /BUILD_IDENTITY/);
  });
}
for (const [name, value] of [
  ["JUDGEDESK_APP_VERSION", "1.5.0"], ["JUDGEDESK_GIT_COMMIT", "native"],
  ["JUDGEDESK_BUILD_SOURCE_STATE", "dev"], ["SOURCE_DATE_EPOCH", "1700000000junk"],
  ["SOURCE_DATE_EPOCH", "-1"], ["SOURCE_DATE_EPOCH", "1.5"],
  ["SOURCE_DATE_EPOCH", "999999999999999999999"], ["JUDGEDESK_BUILD_NUMBER", "bad\nline"],
  ["JUDGEDESK_BUILD_NUMBER", "bad\u0000"], ["JUDGEDESK_BUILD_NUMBER", "é"],
  ["JUDGEDESK_BUILD_NUMBER", 'bad"quote'], ["JUDGEDESK_BUILD_NUMBER", "bad\\escape"],
]) {
  test(`packaged identity rejects invalid ${name}=${JSON.stringify(value)}`, (t) => {
    assert.throws(() => resolveBuildMetadata(fixture(t), { ...packaged, [name]: value }), /BUILD_IDENTITY/);
  });
}
test("packaged identity rejects conflicting timestamps", (t) => {
  assert.throws(() => resolveBuildMetadata(fixture(t), { ...packaged, JUDGEDESK_BUILD_TIMESTAMP: "2020-01-01T00:00:00.000Z" }), /BUILD_IDENTITY/);
});
test("development identity refreshes actual Git clean/dirty/commit and Git-less archive state", async (t) => {
  const { resolveBuildIdentity } = await import("./build-metadata.js");
  const root = fixture(t);
  const identity = () => resolveBuildIdentity(root, {}, "rust", "x86_64-pc-windows-msvc", []);
  assert.equal(identity().sourceState, "dev");
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString().trim();
  git("init"); git("add", "package.json");
  git("-c", "user.name=identity fixture", "-c", "user.email=fixture@localhost", "commit", "-m", "initial");
  const first = identity(); assert.equal(first.sourceState, "clean"); assert.equal(first.gitCommit, git("rev-parse", "HEAD"));
  fs.writeFileSync(path.join(root, "new-input"), "dirty"); assert.equal(identity().sourceState, "dirty");
  fs.rmSync(path.join(root, "new-input")); assert.equal(identity().sourceState, "clean");
  git("-c", "user.name=identity fixture", "-c", "user.email=fixture@localhost", "commit", "--allow-empty", "-m", "next");
  assert.notEqual(identity().gitCommit, first.gitCommit);
  const nested = path.join(root, "archive"); fs.mkdirSync(nested);
  fs.copyFileSync(path.join(root, "package.json"), path.join(nested, "package.json"));
  assert.equal(resolveBuildIdentity(nested, {}, "rust", "aarch64-apple-darwin", ["test-server"]).sourceState, "dev");
});

test("all package entry points enforce packaged provenance and owning locked Cargo", () => {
  const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const scripts = JSON.parse(read("package.json")).scripts;
  for (const name of ["build:windows:local", "build:windows:core:local", "build:windows:full:local", "build:macos:local", "build:macos:core:local", "build:macos:full:local", "build:macos:local:headless", "build:test"]) {
    assert.match(scripts[name], /scripts\/build-packaged\.js/, name);
  }
  assert.match(read("scripts/build-packaged.js"), /preparePackagedEnvironment/);
  assert.match(read("scripts/build-packaged.js"), /check-release-version/);
  assert.match(read("scripts/build-packaged.js"), /"--", "--locked"/);
  assert.match(read("scripts/build-windows-release-variants.ps1"), /prepare-build-environment/);
  assert.match(read("scripts/build-windows-release-variants.ps1"), /tauri build[^\n]+-- --locked/);
  const mac = read("codemagic.yaml");
  assert.match(mac, /JUDGEDESK_BUILD_MODE=packaged/);
  assert.equal((mac.match(/--target aarch64-apple-darwin -- --locked/g) || []).length, 2);
  assert.match(read(".github/workflows/ci.yml"), /cargo check --locked/);
  assert.match(read("scripts/build-native-executor.js"), /"--locked"/);
  assert.match(read("crates/judgedesk-core/tests/common/mod.rs"), /"build", "--locked"/);
});

test("compiler feature selectors cover each owner's effective Cargo feature inventory", () => {
  const repo = new URL("../", import.meta.url);
  for (const owner of ["crates/judgedesk-core", "src-tauri"]) {
    const manifest = new URL(`${owner}/Cargo.toml`, repo);
    const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--locked", "--no-deps", "--format-version", "1",
      "--manifest-path", fileURLToPath(manifest)], { cwd: repo, encoding: "utf8" }));
    const pkg = metadata.packages.find((entry) => entry.name === (owner === "src-tauri" ? "themis-v2" : "judgedesk-core"));
    assert.ok(pkg, `${owner}: owning package missing`);
    const buildScript = fs.readFileSync(new URL(`${owner}/build.rs`, repo), "utf8");
    const selectors = [...buildScript.matchAll(/#\[cfg\(feature = "([^"]+)"\)\]/g)].map((match) => match[1]);
    assert.deepEqual(selectors.sort(), Object.keys(pkg.features).sort(), `${owner}: update compiler feature selectors with Cargo inventory`);
  }
});
