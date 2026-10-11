import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { claimOsdSource } from "./osd-source.js";

it("claims and fingerprints a multi-chunk source, detects tampering, and disposes only its owned leaf", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-osd-source-"));
  const name = "0[HS01][SUM]cpp";
  const bytes = Buffer.alloc(150_000, 42);
  try {
    fs.writeFileSync(path.join(root, name), bytes);
    const source = await claimOsdSource(root, name, "SUM.cpp", { debounceMs: 1, maxRetries: 1, isActive: () => true });
    assert.ok(source);
    assert.equal(source.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
    assert.deepEqual(fs.readFileSync(source.filePath), bytes);
    source.assertIntegrity();
    fs.writeFileSync(source.filePath, "tampered");
    assert.throws(() => source.assertIntegrity(), /INTEGRITY_MISMATCH/);
    source.dispose();
    source.dispose();
    assert.deepEqual(fs.readdirSync(root), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it("a cancelled claim never overwrites the newer inbox file and preserves the original bytes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-osd-cancel-"));
  const name = "0[HS01][SUM]cpp";
  let active = true;
  try {
    fs.writeFileSync(path.join(root, name), "A");
    const pending = claimOsdSource(root, name, "SUM.cpp", { debounceMs: 10, maxRetries: 1, isActive: () => active });
    assert.equal(fs.existsSync(path.join(root, name)), false, "claim must rename before waiting");
    fs.writeFileSync(path.join(root, name), "B");
    active = false;
    assert.equal(await pending, undefined);
    assert.equal(fs.readFileSync(path.join(root, name), "utf8"), "B");
    const rejected = fs.readdirSync(path.join(root, "Rejected"));
    assert.equal(rejected.length, 1);
    assert.equal(fs.readFileSync(path.join(root, "Rejected", rejected[0]), "utf8"), "A");
    assert.equal(fs.readdirSync(root).some(entry => entry.startsWith(".judgedesk-osd-")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it("rejects hard-linked sources and traversal names without reading outside the inbox", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-osd-linked-"));
  try {
    fs.writeFileSync(path.join(root, "original"), "private");
    fs.linkSync(path.join(root, "original"), path.join(root, "0[HS01][SUM]cpp"));
    const options = { debounceMs: 1, maxRetries: 1, isActive: () => true };
    await assert.rejects(claimOsdSource(root, "0[HS01][SUM]cpp", "SUM.cpp", options), /LINKED_OR_NOT_REGULAR/);
    await assert.rejects(claimOsdSource(root, "../outside", "SUM.cpp", options), /UNSAFE_SOURCE_NAME/);
    assert.equal(fs.readFileSync(path.join(root, "original"), "utf8"), "private");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
