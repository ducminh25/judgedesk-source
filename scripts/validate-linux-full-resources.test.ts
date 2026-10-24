import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateLinuxFullResources } from "./validate-linux-full-resources.js";
import { listCurrentReleaseManagedPackageIds } from "../server/toolchains/release-scope.js";
import { normalizeLinuxDistributionPermissions } from "../server/toolchains/distribution-permissions.js";

test("Full preflight rejects missing languages, changed indices and a self-replaced lock", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jd-full-preflight-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hash = (text: string) => crypto.createHash("sha256").update(text).digest("hex");
  const packages = listCurrentReleaseManagedPackageIds("linux", "x64").map((id) => ({
    id, version: "test", archiveSha256: "a".repeat(64), installedSizeBytes: 1,
    contentIndexSha256: hash("index"),
  })).sort((a, b) => a.id.localeCompare(b.id));
  const trusted = { schemaVersion: 1 as const, distribution: "full" as const,
    platform: "linux" as const, arch: "x64" as const, manifestSha256: hash("manifest"), packages };
  fs.mkdirSync(path.join(root, "toolchains"));
  for (const entry of packages) {
    fs.mkdirSync(path.join(root, "toolchains", entry.id));
    fs.writeFileSync(path.join(root, "toolchains", entry.id, ".judgedesk-content.json"), "index");
  }
  fs.writeFileSync(path.join(root, "toolchains-manifest.json"), "manifest");
  fs.writeFileSync(path.join(root, "judgedesk-distribution-lock.json"), JSON.stringify(trusted));
  fs.writeFileSync(path.join(root, "judgedesk-distribution.json"), JSON.stringify({ schemaVersion: 1, distribution: "full" }));
  if (process.platform === "linux") normalizeLinuxDistributionPermissions(root);
  assert.equal(validateLinuxFullResources(root, trusted).packageCount, 5);
  if (process.platform === "linux") {
    const receipt = path.join(root, "toolchains", packages[0].id, ".judgedesk-package.json");
    fs.writeFileSync(receipt, "receipt", { mode: 0o600 });
    assert.throws(() => validateLinuxFullResources(root, trusted), /permissions/);
    fs.chmodSync(receipt, 0o644);
  }
  const index = path.join(root, "toolchains", packages[0].id, ".judgedesk-content.json");
  fs.writeFileSync(index, "tampered index");
  assert.throws(() => validateLinuxFullResources(root, trusted), /content index/);
  fs.writeFileSync(index, "index");
  fs.rmSync(path.dirname(index), { recursive: true });
  assert.throws(() => validateLinuxFullResources(root, trusted), /package set/);
  fs.mkdirSync(path.dirname(index));
  fs.writeFileSync(index, "index");
  fs.writeFileSync(path.join(root, "judgedesk-distribution-lock.json"), JSON.stringify({ ...trusted, packages: [] }));
  assert.throws(() => validateLinuxFullResources(root, trusted), /trusted catalog/);
});
