import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeToolchainContentIndex } from "./content-index.js";

test("content index pins every extracted file including the trust receipt", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-content-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "bin"));
  fs.writeFileSync(path.join(root, "bin", "python3"), "runtime");
  fs.writeFileSync(path.join(root, ".judgedesk-package.json"), "receipt");
  const result = await writeToolchainContentIndex(root);
  const bytes = fs.readFileSync(path.join(root, ".judgedesk-content.json"));
  assert.equal(result, crypto.createHash("sha256").update(bytes).digest("hex"));
  const index = JSON.parse(bytes.toString());
  assert.deepEqual(index.entries.map((entry: { path: string }) => entry.path), [
    ".judgedesk-package.json", "bin", "bin/python3",
  ]);
  assert.equal(index.entries[2].sha256, crypto.createHash("sha256").update("runtime").digest("hex"));
  fs.writeFileSync(path.join(root, "bin", "python3"), "tampered");
  assert.notEqual(await writeToolchainContentIndex(root), result);
});

test("content index refuses links instead of silently hashing their destination", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-content-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "target"));
  fs.symlinkSync(path.join(root, "target"), path.join(root, "alias"), "junction");
  await assert.rejects(writeToolchainContentIndex(root), /symbolic link/);
});
