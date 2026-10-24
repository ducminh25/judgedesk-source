import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { signArtifact } from "./sign-publish.mjs";
import { signBytes, verifyBytes, assertPublicationBaseline, createBootstrapReceipt, verifyBootstrapReceipt } from "./publisher-security.mjs";
import { signAnnouncementPayload, verifyAnnouncementSignature } from "./signatures.js";

test("isolated built-ins signer matches the reference exactly and refuses key mismatch", () => {
  const key = generateKeyPairSync("ed25519");
  const rawKey = key.publicKey.export({ format: "jwk" }).x!;
  const trust = { keys: [{ keyId: "test-only", publicKeyBase64: Buffer.from(rawKey, "base64url").toString("base64") }] };
  const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, feedId: "judgedesk-announcements", sequence: 1, generatedAt: "2026-10-24T00:00:00.000Z", items: [] }));
  const envelope = signBytes(payload, "test-only", key.privateKey, trust);
  assert.deepEqual(envelope, signAnnouncementPayload(payload, "test-only", key.privateKey));
  assert.deepEqual(verifyBytes(envelope, trust), payload);
  assert.deepEqual(verifyAnnouncementSignature(envelope, new Map([["test-only", key.publicKey]])), payload);
  assert.throws(() => signBytes(payload, "test-only", generateKeyPairSync("ed25519").privateKey, trust), /key/i);
  assert.throws(() => verifyBytes({ ...envelope, payloadBase64: Buffer.from("changed").toString("base64") }, trust), /signature/i);
});
test("publication baseline refuses unknown production state, stale rerun and sequence equivocation", () => {
  const a = { sequence: 3, payloadSha256: "a".repeat(64) };
  assert.throws(() => assertPublicationBaseline(a, null, false), /baseline|bootstrap/i);
  assert.doesNotThrow(() => assertPublicationBaseline(a, null, true));
  assert.doesNotThrow(() => assertPublicationBaseline(a, a, false));
  assert.throws(() => assertPublicationBaseline({ ...a, sequence: 2 }, a, false), /rollback|sequence/i);
  assert.throws(() => assertPublicationBaseline({ ...a, payloadSha256: "b".repeat(64) }, a, false), /equivocation|sequence/i);
  assert.doesNotThrow(() => assertPublicationBaseline({ ...a, sequence: 4 }, a, false));
});
test("bootstrap job-output authorization is bound to this run attempt, commit and payload", () => {
  const current = { commit: "a".repeat(40), runId: "12345", attempt: "1", payloadSha256: "b".repeat(64) };
  const receipt = createBootstrapReceipt(current);
  assert.equal(verifyBootstrapReceipt(receipt, current), true);
  for (const stale of [{ ...current, attempt: "2" }, { ...current, runId: "12346" }, { ...current, commit: "c".repeat(40) }, { ...current, payloadSha256: "d".repeat(64) }]) assert.equal(verifyBootstrapReceipt(receipt, stale), false);
  assert.equal(verifyBootstrapReceipt("", current), false);
  assert.equal(verifyBootstrapReceipt("{}", current), false);
});
test("signing stage rebuilds the public tree and never publishes a build-supplied script/index", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "judgedesk-signing-"));
  try {
    const key = generateKeyPairSync("ed25519");
    const trust = { keys: [{ keyId: "test-only", publicKeyBase64: Buffer.from(key.publicKey.export({ format: "jwk" }).x!, "base64url").toString("base64") }] };
    const input = path.join(root, "unsigned"); const output = path.join(root, "signed");
    await mkdir(path.join(input, "site"), { recursive: true });
    await writeFile(path.join(input, "payload.json"), JSON.stringify({ schemaVersion: 1, feedId: "judgedesk-announcements", sequence: 1, generatedAt: "2026-10-24T00:00:00.000Z", items: [] }));
    await writeFile(path.join(input, "media-manifest.json"), "[]");
    await writeFile(path.join(input, "site/index.html"), "<script>bad()</script>");
    const trustFile = path.join(root, "trust.json"); await writeFile(trustFile, JSON.stringify(trust));
    await signArtifact(input, output, trustFile, "test-only", key.privateKey);
    assert.ok(!(await readFile(path.join(output, "index.html"), "utf8")).includes("script"));
    const envelope = JSON.parse(await readFile(path.join(output, "announcements/v1/feed.json"), "utf8"));
    assert.equal(JSON.parse(verifyBytes(envelope, trust).toString("utf8")).sequence, 1);
    await writeFile(path.join(input, "media-manifest.json"), JSON.stringify([{ name: "../../private.pem", sizeBytes: 1 }]));
    await assert.rejects(signArtifact(input, path.join(root, "unsafe"), trustFile, "test-only", key.privateKey), /artifact|media/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});
