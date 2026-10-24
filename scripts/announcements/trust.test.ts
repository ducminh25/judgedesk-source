import assert from "node:assert/strict";
import { createHash, createPublicKey } from "node:crypto";
import { test } from "node:test";
import trust from "../../shared/announcements-trust.json";
import fixture from "../../shared/test-fixtures/announcements/signed-feed.json";
import { verifyBytes } from "./publisher-security.mjs";

test("production trust contains only the owner-approved announcement key and fixed Pages scope", () => {
  assert.deepEqual(trust, {
    endpoint: "https://ducminh25.github.io/judgedesk/announcements/v1/feed.json",
    mediaPrefix: "https://ducminh25.github.io/judgedesk/announcements/v1/media/",
    keys: [{ keyId: "announcements-v1", publicKeyBase64: "PeSS4z5N+TqCun8CLre2XbaOK0BNT+18zFLyAIq0d+0=" }],
  });
  const raw = Buffer.from(trust.keys[0].publicKeyBase64, "base64");
  assert.equal(raw.length, 32);
  assert.equal(raw.toString("base64"), trust.keys[0].publicKeyBase64);
  assert.equal(createHash("sha256").update(raw).digest("hex"), "77b1610dfaef5f7a5d09c9e698cdc329b28708cf1880360669ea838381dce195");
  const key = createPublicKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") } });
  assert.equal(key.type, "public");
  assert.equal(key.asymmetricKeyType, "ed25519");
  assert.equal(key.export({ format: "jwk" }).x, raw.toString("base64url"));
});

test("production trust refuses the test signing key even when its envelope claims the production key ID", () => {
  assert.throws(() => verifyBytes(fixture.envelope, trust), /unconfigured|ambiguous/i);
  assert.throws(() => verifyBytes({ ...fixture.envelope, keyId: "announcements-v1" }, trust), /signature/i);
});
