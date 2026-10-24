import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  normalizeLinuxDistributionPermissions,
  validateLinuxDistributionPermissions,
} from "./distribution-permissions.js";

test("Linux install resources are readable by other users without changing executable identity", (t) => {
  if (process.platform !== "linux") return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jd-install-modes-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sdk = path.join(root, "sdk");
  fs.mkdirSync(sdk, { mode: 0o700 });
  const receipt = path.join(sdk, ".judgedesk-package.json");
  const binary = path.join(sdk, "compiler");
  fs.writeFileSync(receipt, "private receipt", { mode: 0o600 });
  fs.writeFileSync(binary, "compiler bytes", { mode: 0o700 });
  assert.throws(() => validateLinuxDistributionPermissions(root), /permissions/);
  normalizeLinuxDistributionPermissions(root);
  validateLinuxDistributionPermissions(root);
  for (const directory of [root, sdk]) assert.equal(fs.statSync(directory).mode & 0o7777, 0o755);
  assert.equal(fs.statSync(receipt).mode & 0o7777, 0o644);
  assert.equal(fs.statSync(binary).mode & 0o7777, 0o755);
  assert.equal(fs.readFileSync(receipt, "utf8"), "private receipt");
  fs.chmodSync(receipt, 0o600);
  assert.throws(() => validateLinuxDistributionPermissions(root), /permissions/);
});

test("Linux resource permission normalization refuses links instead of modifying their targets", (t) => {
  if (process.platform !== "linux") return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jd-install-links-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "jd-install-outside-"));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  const target = path.join(outside, "private");
  fs.writeFileSync(target, "outside", { mode: 0o600 });
  fs.symlinkSync(target, path.join(root, "link"));
  assert.throws(() => normalizeLinuxDistributionPermissions(root), /regular/);
  assert.equal(fs.statSync(target).mode & 0o7777, 0o600);
});
