import { sign, verify, type KeyObject } from "node:crypto";
import {
  ANNOUNCEMENT_FORMAT,
  ANNOUNCEMENT_KEY_ID_PATTERN,
  ANNOUNCEMENT_LIMITS,
  ANNOUNCEMENT_SIGNING_PREFIX,
  type AnnouncementEnvelope,
} from "../../shared/announcements.js";
import { assertAnnouncementEnvelope } from "./validate-payload.js";

export function createAnnouncementSigningMessage(keyId: string, payload: Uint8Array): Buffer {
  if (!ANNOUNCEMENT_KEY_ID_PATTERN.test(keyId)) throw new Error("Announcement signing key ID is invalid.");
  if (payload.byteLength === 0 || payload.byteLength > ANNOUNCEMENT_LIMITS.payloadBytes) {
    throw new Error("Announcement payload bytes are outside the allowed limit.");
  }
  return Buffer.concat([Buffer.from(`${ANNOUNCEMENT_SIGNING_PREFIX}${keyId}\n`, "utf8"), payload]);
}

/** Signs opaque bytes. Payload/schema validation and HTML sanitization are separate publisher steps. */
export function signAnnouncementPayload(payload: Uint8Array, keyId: string, privateKey: KeyObject): AnnouncementEnvelope {
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Announcement signing requires a private Ed25519 key.");
  }
  const message = createAnnouncementSigningMessage(keyId, payload);
  return {
    format: ANNOUNCEMENT_FORMAT,
    keyId,
    payloadBase64: Buffer.from(payload).toString("base64"),
    signatureBase64: sign(null, message, privateKey).toString("base64"),
  };
}

function decodeBase64(value: string, label: string, maximumBytes: number): Buffer {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if (value.length / 4 * 3 - padding > maximumBytes) {
    throw new Error(`Announcement ${label} exceeds the maximum bytes.`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error(`Announcement ${label} base64 is not canonical.`);
  return bytes;
}

/** Verifies authenticity only; the returned bytes are not yet a validated or sanitized article. */
export function verifyAnnouncementSignature(value: unknown, trustedKeys: ReadonlyMap<string, KeyObject>): Buffer {
  assertAnnouncementEnvelope(value);
  const key = trustedKeys.get(value.keyId);
  if (!key) throw new Error("Announcement signing key is not trusted.");
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
    throw new Error("Announcement verification requires a public Ed25519 key.");
  }
  const payload = decodeBase64(value.payloadBase64, "payload", ANNOUNCEMENT_LIMITS.payloadBytes);
  const signature = decodeBase64(value.signatureBase64, "signature", 64);
  if (signature.length !== 64 || !verify(null, createAnnouncementSigningMessage(value.keyId, payload), key, signature)) {
    throw new Error("Announcement signature verification failed.");
  }
  return payload;
}
