import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repo = fileURLToPath(new URL("../", import.meta.url));
const appVersion = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).version;
const files = ["package.json", "package-lock.json", "src/version.ts", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/tauri.conf.json", "native-executor/Cargo.toml", "native-executor/Cargo.lock"];
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jd-version-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of files) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.copyFileSync(path.join(repo, file), path.join(root, file)); }
  return root;
}
function check(root, tag = "") {
  return spawnSync(process.execPath, [path.join(repo, "scripts/check-release-version.js")], { cwd: root, encoding: "utf8", env: { ...process.env, GITHUB_REF_NAME: tag } });
}
for (const file of files) test(`eight-file authority rejects mismatch in ${file}`, (t) => {
  const root = fixture(t); const location = path.join(root, file);
  fs.writeFileSync(location, fs.readFileSync(location, "utf8").replaceAll(JSON.stringify(appVersion), '"99.8.7"'));
  const result = check(root); assert.notEqual(result.status, 0); assert.match(result.stderr, /Release versions do not match/);
});
test("package-lock root mismatch is independently rejected", (t) => {
  const root = fixture(t); const file = path.join(root, "package-lock.json");
  const json = JSON.parse(fs.readFileSync(file, "utf8")); json.packages[""].version = "99.8.7";
  fs.writeFileSync(file, JSON.stringify(json)); assert.notEqual(check(root).status, 0);
});
test("application authority excludes independent core package and enforces release tag", (t) => {
  const root = fixture(t); fs.mkdirSync(path.join(root, "crates/judgedesk-core"), { recursive: true });
  fs.writeFileSync(path.join(root, "crates/judgedesk-core/Cargo.toml"), '[package]\nname="judgedesk-core"\nversion="99.8.7"\n');
  assert.equal(check(root, "v" + appVersion).status, 0);
  const rejected = check(root, "v99.8.7"); assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /Git tag/);
  const lock = path.join(root, "src-tauri/Cargo.lock");
  fs.writeFileSync(lock, fs.readFileSync(lock, "utf8").replace('name = "themis-v2"', 'name = "judgedesk-desktop"'));
  assert.notEqual(check(root).status, 0);
});
