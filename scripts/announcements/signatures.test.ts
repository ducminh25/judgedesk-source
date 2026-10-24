import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  createAnnouncementSigningMessage,
  signAnnouncementPayload,
  verifyAnnouncementSignature,
} from "./signatures.js";

const fixtureUrl = new URL("../../shared/test-fixtures/announcements/signed-feed.json", import.meta.url);

test("the committed golden signature verifies without the publisher signing function", () => {
  const fixture = JSON.parse(readFileSync(fixtureUrl, "utf8"));
  const bytes = Buffer.from(fixture.envelope.payloadBase64, "base64");
  const publicKey = createPublicKey(fixture.publicKeySpkiPem);
  assert.equal(fixture.testOnly, true);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), fixture.payloadSha256);
  const rawPublicKey = publicKey.export({ format: "jwk" }).x;
  assert.ok(typeof rawPublicKey === "string");
  assert.equal(Buffer.from(rawPublicKey, "base64url").toString("base64"), fixture.publicKeyRawBase64);
  const expectedMessage = Buffer.concat([
    Buffer.from(`JudgeDesk announcements v1\n${fixture.envelope.keyId}\n`, "utf8"), bytes,
  ]);
  assert.equal(verify(null, expectedMessage, publicKey, Buffer.from(fixture.envelope.signatureBase64, "base64")), true);
  assert.deepEqual(createAnnouncementSigningMessage(fixture.envelope.keyId, bytes), expectedMessage);
  assert.deepEqual(verifyAnnouncementSignature(fixture.envelope, new Map([[fixture.envelope.keyId, publicKey]])), bytes);
});

test("signatures bind the original bytes including whitespace and Unicode", () => {
  const keys = generateKeyPairSync("ed25519");
  const bytes = Buffer.from('{ "title": "Thông báo mới" }\n', "utf8");
  const envelope = signAnnouncementPayload(bytes, "test-only", keys.privateKey);
  assert.equal(envelope.payloadBase64, bytes.toString("base64"));
  const message = Buffer.concat([Buffer.from("JudgeDesk announcements v1\ntest-only\n"), bytes]);
  assert.equal(verify(null, message, keys.publicKey, Buffer.from(envelope.signatureBase64, "base64")), true);
  assert.deepEqual(verifyAnnouncementSignature(envelope, new Map([["test-only", keys.publicKey]])), bytes);
  const reserialized = Buffer.from(JSON.stringify(JSON.parse(bytes.toString("utf8"))));
  assert.throws(() => verifyAnnouncementSignature({ ...envelope, payloadBase64: reserialized.toString("base64") }, new Map([["test-only", keys.publicKey]])), /signature/i);
});

test("verification rejects tampering, unknown keys and wrong domains", () => {
  const keys = generateKeyPairSync("ed25519");
  const other = generateKeyPairSync("ed25519");
  const envelope = signAnnouncementPayload(Buffer.from("{}"), "test-only", keys.privateKey);
  const trusted = new Map([["test-only", keys.publicKey], ["another-id", keys.publicKey]]);
  assert.throws(() => verifyAnnouncementSignature(envelope, new Map()), /trusted/i);
  assert.throws(() => verifyAnnouncementSignature(envelope, new Map([["test-only", other.publicKey]])), /signature/i);
  assert.throws(() => verifyAnnouncementSignature({ ...envelope, keyId: "another-id" }, trusted), /signature/i);
  assert.throws(() => verifyAnnouncementSignature({ ...envelope, signatureBase64: Buffer.alloc(64).toString("base64") }, trusted), /signature/i);
  const wrongDomain = Buffer.from("JudgeDesk toolchains v1\ntest-only\n{}");
  assert.equal(verify(null, wrongDomain, keys.publicKey, Buffer.from(envelope.signatureBase64, "base64")), false);
});

test("base64, signature length and signing key types fail closed", () => {
  const keys = generateKeyPairSync("ed25519");
  const envelope = signAnnouncementPayload(Buffer.from("{}"), "test-only", keys.privateKey);
  const trusted = new Map([["test-only", keys.publicKey]]);
  for (const overrides of [
    { payloadBase64: "e30" }, { payloadBase64: "e31=" }, { payloadBase64: "e30=\n" },
    { signatureBase64: "!".repeat(88) }, { signatureBase64: Buffer.alloc(63).toString("base64") },
    { format: "judgedesk-toolchains-v1" }, { keyId: "test-only\nother" }, { unexpected: true },
  ]) {
    assert.throws(() => verifyAnnouncementSignature({ ...envelope, ...overrides }, trusted), /announcement|base64|signature/i);
  }
  assert.throws(() => signAnnouncementPayload(Buffer.from("{}"), "test-only", keys.publicKey), /private.*ed25519/i);
  assert.throws(() => signAnnouncementPayload(Buffer.from("{}"), "bad\nkey", keys.privateKey), /key/i);
  assert.throws(() => verifyAnnouncementSignature(envelope, new Map([["test-only", keys.privateKey]])), /public.*ed25519/i);
  const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  assert.throws(() => signAnnouncementPayload(Buffer.from("{}"), "test-only", ec.privateKey), /private.*ed25519/i);
});

test("payload bytes are bounded before crypto or base64 allocation", () => {
  const keys = generateKeyPairSync("ed25519");
  assert.throws(() => signAnnouncementPayload(Buffer.alloc(1024 * 1024 + 1), "test-only", keys.privateKey), /payload.*bytes/i);
  const envelope = signAnnouncementPayload(Buffer.from("{}"), "test-only", keys.privateKey);
  assert.throws(() => verifyAnnouncementSignature({ ...envelope, payloadBase64: "A".repeat(1_398_104) }, new Map([["test-only", keys.publicKey]])), /payload.*bytes/i);
  const maximum = Buffer.alloc(1024 * 1024, 0x61);
  assert.deepEqual(verifyAnnouncementSignature(signAnnouncementPayload(maximum, "test-only", keys.privateKey), new Map([["test-only", keys.publicKey]])), maximum);
});
