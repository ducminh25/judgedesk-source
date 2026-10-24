// Signing job dependency boundary: Node built-ins only. Never import the HTML publisher here.
import { createHash, createPublicKey, sign, verify } from "node:crypto";
const PREFIX = "JudgeDesk announcements v1\n";
const FORMAT = "judgedesk-announcements-v1";
const LIMIT = 1024 * 1024;

/** @typedef {{keys: {keyId: string, publicKeyBase64: string}[]}} Trust */
/** @typedef {{format: string, keyId: string, payloadBase64: string, signatureBase64: string}} Envelope */
/** @param {string} text @param {number} size */
function decode(text, size) {
  if (typeof text !== "string" || text.length > Math.ceil(size / 3) * 4) throw new Error("Base64 size limit exceeded");
  const bytes = Buffer.from(text, "base64");
  if (bytes.length > size || bytes.toString("base64") !== text) throw new Error("Noncanonical base64");
  return bytes;
}
/** @param {string} id @param {Trust} trust */
function publicKey(id, trust) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error("Invalid signing key ID");
  const matches = trust.keys.filter((key) => key.keyId === id);
  if (matches.length !== 1) throw new Error("Signing key is unconfigured or ambiguous");
  const raw = decode(matches[0].publicKeyBase64, 32);
  if (raw.length !== 32) throw new Error("Public key length must be 32 bytes");
  return createPublicKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") } });
}
/** @param {Uint8Array} payload */
export function payloadIdentity(payload) {
  if (!payload.length || payload.length > LIMIT) throw new Error("Payload size limit exceeded");
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  if (value.schemaVersion !== 1 || value.feedId !== "judgedesk-announcements" || !Number.isSafeInteger(value.sequence) || value.sequence < 1 || !Array.isArray(value.items) || value.items.length > 100 || new Date(value.generatedAt).toISOString() !== value.generatedAt) throw new Error("Payload signing claims are invalid");
  return { sequence: Number(value.sequence), payloadSha256: createHash("sha256").update(payload).digest("hex") };
}
/** @param {Uint8Array} payload @param {string} id @param {import('node:crypto').KeyObject} privateKey @param {Trust} trust @returns {Envelope} */
export function signBytes(payload, id, privateKey, trust) {
  payloadIdentity(payload);
  const approved = publicKey(id, trust);
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519" || !createPublicKey(privateKey).equals(approved)) throw new Error("Private signing key does not match the approved public key");
  const message = Buffer.concat([Buffer.from(`${PREFIX}${id}\n`), payload]);
  return { format: FORMAT, keyId: id, payloadBase64: Buffer.from(payload).toString("base64"), signatureBase64: sign(null, message, privateKey).toString("base64") };
}
/** @param {Envelope} envelope @param {Trust} trust @returns {Buffer} */
export function verifyBytes(envelope, trust) {
  if (!envelope || Object.keys(envelope).sort().join(",") !== "format,keyId,payloadBase64,signatureBase64" || envelope.format !== FORMAT) throw new Error("Envelope format is invalid");
  const key = publicKey(envelope.keyId, trust);
  const payload = decode(envelope.payloadBase64, LIMIT);
  const signature = decode(envelope.signatureBase64, 64);
  if (signature.length !== 64 || !verify(null, Buffer.concat([Buffer.from(`${PREFIX}${envelope.keyId}\n`), payload]), key, signature)) throw new Error("Announcement signature is invalid");
  payloadIdentity(payload); return payload;
}
/** @param {{sequence: number, payloadSha256: string}} candidate @param {{sequence: number, payloadSha256: string} | null} deployed @param {boolean} verifiedNeverDeployed */
export function assertPublicationBaseline(candidate, deployed, verifiedNeverDeployed) {
  if (!deployed) { if (!verifiedNeverDeployed) throw new Error("Production baseline is unknown; approved bootstrap evidence is required"); return; }
  if (candidate.sequence < deployed.sequence) throw new Error("Publication sequence rollback refused");
  if (candidate.sequence === deployed.sequence && candidate.payloadSha256 !== deployed.payloadSha256) throw new Error("Publication sequence equivocation refused");
}

/** @typedef {{commit:string, runId:string, attempt:string, payloadSha256:string}} BootstrapContext */
/**
 * Authorization transported only through trusted signing-job outputs, not from the
 * content/artifact. It is not a public credential or a substitute for signature trust.
 * @param {BootstrapContext} context
 */
export function createBootstrapReceipt(context) {
  if (!context || Object.keys(context).sort().join(",") !== "attempt,commit,payloadSha256,runId" || !/^[0-9a-f]{40}$/.test(context.commit) || !/^[0-9a-f]{64}$/.test(context.payloadSha256) || !/^[1-9][0-9]*$/.test(context.runId) || !/^[1-9][0-9]*$/.test(context.attempt)) throw new Error("Bootstrap run context is incomplete");
  return JSON.stringify({ commit: context.commit, runId: context.runId, attempt: context.attempt, payloadSha256: context.payloadSha256 });
}
/** @param {string} receipt @param {BootstrapContext} expected */
export function verifyBootstrapReceipt(receipt, expected) {
  if (!receipt || receipt.length > 1024) return false;
  try { return createBootstrapReceipt(JSON.parse(receipt)) === createBootstrapReceipt(expected); }
  catch { return false; } // Invalid/mismatched authorization is denied, never treated as a baseline of zero.
}
