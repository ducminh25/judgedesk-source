import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const outputDirectory = path.resolve(
  process.argv[2]
    || path.join(
      process.env.LOCALAPPDATA || process.cwd(),
      "JudgeDesk",
      "release-secrets",
    ),
);
const keyId = process.argv[3] || "judgedesk-toolchains-2026-07";
if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(keyId)) {
  throw new Error("Signing key ID is invalid.");
}

fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
const privateKeyPath = path.join(outputDirectory, `${keyId}.private.pem`);
const publicKeyPath = path.join(outputDirectory, `${keyId}.public.pem`);
for (const candidate of [privateKeyPath, publicKeyPath]) {
  if (fs.existsSync(candidate)) {
    throw new Error(`Refusing to overwrite an existing signing key: ${candidate}`);
  }
}

const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
const publicPem = publicKey.export({ type: "spki", format: "pem" });
fs.writeFileSync(privateKeyPath, privatePem, {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600,
});
fs.writeFileSync(publicKeyPath, publicPem, {
  encoding: "utf8",
  flag: "wx",
  mode: 0o644,
});
const fingerprint = crypto
  .createHash("sha256")
  .update(publicKey.export({ type: "spki", format: "der" }))
  .digest("hex");

console.log(`Generated JudgeDesk toolchain signing key '${keyId}'.`);
console.log(`Private key: ${privateKeyPath}`);
console.log(`Public key:  ${publicKeyPath}`);
console.log(`Public key SHA-256: ${fingerprint}`);
console.log("Back up the private key securely; never commit it to the repository.");
