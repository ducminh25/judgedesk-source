// Kept separate from npm/HTML tooling. The signing job executes this pinned source only.
import { createHash, createPrivateKey } from "node:crypto";
import { lstat, mkdir, open, realpath, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { signBytes, payloadIdentity, assertPublicationBaseline, createBootstrapReceipt } from "./publisher-security.mjs";
import { assertCurrentProtectedMain, deployedIdentity, verifiedBootstrap } from "./publisher-network.mjs";

/** @param {string} file @param {number} maximum */
export async function regularBytes(file, maximum) {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > maximum) throw new Error("Unsafe artifact file or size limit exceeded");
  const handle = await open(file, "r");
  try {
    const bytes = Buffer.alloc(metadata.size + 1); let length = 0;
    while (length < bytes.length) { const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null); if (!bytesRead) break; length += bytesRead; }
    if (length !== metadata.size) throw new Error("Artifact file changed during validation");
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}
/** @param {string} root @param {string} relative @param {number} maximum */
async function artifactBytes(root, relative, maximum) {
  let current = root;
  for (const component of relative.split("/")) {
    if (!component || component === "." || component === ".." || /[\\:]/.test(component)) throw new Error("Unsafe artifact path");
    current = path.join(current, component);
    if ((await lstat(current)).isSymbolicLink()) throw new Error("Artifact path contains a link");
  }
  return regularBytes(current, maximum);
}
/** @param {string} root @param {string} output @param {string} trustFile @param {string} keyId @param {import('node:crypto').KeyObject} privateKey */
export async function signArtifact(root, output, trustFile, keyId, privateKey) {
  if (!(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink()) throw new Error("Unsafe artifact root");
  root = await realpath(root);
  const trust = JSON.parse((await regularBytes(trustFile, 16384)).toString("utf8"));
  const payload = await artifactBytes(root, "payload.json", 1024 * 1024);
  const envelope = signBytes(payload, keyId, privateKey, trust);
  const manifest = JSON.parse((await artifactBytes(root, "media-manifest.json", 4 * 1024 * 1024)).toString("utf8"));
  if (!Array.isArray(manifest) || manifest.length > 20000) throw new Error("Invalid media artifact manifest");
  const names = new Set(); let total = payload.length;
  for (const image of manifest) {
    if (!image || Object.keys(image).sort().join(",") !== "name,sizeBytes" || !/^[0-9a-f]{64}\.(jpg|png)$/.test(image.name) || names.has(image.name) || !Number.isSafeInteger(image.sizeBytes) || image.sizeBytes < 1 || image.sizeBytes > 4 * 1024 * 1024) throw new Error("Unsafe media artifact name/size");
    names.add(image.name); total += image.sizeBytes;
  }
  if (total > 512 * 1024 * 1024) throw new Error("Pages artifact budget exceeded");
  const parsed = JSON.parse(payload.toString("utf8"));
  for (const item of parsed.items) for (const image of item.images) if (!names.has(`${image.sha256}.${image.extension}`)) throw new Error("Signed image is missing from artifact manifest");
  await mkdir(output); const media = path.join(output, "announcements/v1/media"); await mkdir(media, { recursive: true });
  // Rebuild the public tree ourselves; never copy author HTML or a build-supplied index/script.
  await writeFile(path.join(output, "index.html"), '<!doctype html><html lang="vi"><meta charset="utf-8"><title>JudgeDesk</title><p>Thông báo dành cho ứng dụng JudgeDesk.</p></html>\n', { flag: "wx" });
  await writeFile(path.join(output, ".nojekyll"), "", { flag: "wx" });
  for (const image of manifest) {
    const bytes = await artifactBytes(root, `site/announcements/v1/media/${image.name}`, 4 * 1024 * 1024);
    if (bytes.length !== image.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== image.name.split(".")[0]) throw new Error("Artifact image integrity mismatch");
    await writeFile(path.join(media, image.name), bytes, { flag: "wx" });
  }
  await writeFile(path.join(output, "announcements/v1/feed.json"), JSON.stringify(envelope), { flag: "wx" });
  return payloadIdentity(payload);
}

async function main() {
  const [root, output, trustFile, keyId, candidateCommit, publisherCommit] = process.argv.slice(2);
  if (!root || !output || !trustFile || !keyId || !candidateCommit || !/^[0-9a-f]{40}$/.test(publisherCommit ?? "") || process.env.ANNOUNCEMENTS_PUBLISHER_SOURCE_COMMIT !== publisherCommit) throw new Error("Approved publisher source pin and explicit signing arguments are required");
  await assertCurrentProtectedMain(candidateCommit);
  const trust = JSON.parse((await regularBytes(trustFile, 16384)).toString("utf8"));
  const candidate = payloadIdentity(await regularBytes(path.join(root, "payload.json"), 1024 * 1024));
  const deployed = await deployedIdentity(trust);
  const bootstrap = deployed ? false : await verifiedBootstrap(candidateCommit);
  assertPublicationBaseline(candidate, deployed, bootstrap);
  const secret = process.env.ANNOUNCEMENTS_SIGNING_PRIVATE_KEY;
  if (!secret) throw new Error("Announcement signing key is missing");
  const privateKey = createPrivateKey(secret); delete process.env.ANNOUNCEMENTS_SIGNING_PRIVATE_KEY;
  const result = await signArtifact(root, output, trustFile, keyId, privateKey);
  if (bootstrap) {
    if (!process.env.GITHUB_OUTPUT) throw new Error("Bootstrap requires the trusted signing-job output channel");
    const receipt = createBootstrapReceipt({ commit: candidateCommit, runId: process.env.GITHUB_RUN_ID ?? "", attempt: process.env.GITHUB_RUN_ATTEMPT ?? "", payloadSha256: result.payloadSha256 });
    await appendFile(process.env.GITHUB_OUTPUT, `bootstrap_receipt=${receipt}\n`);
  }
  console.log(`Signed announcement sequence ${result.sequence}, payload SHA-256 ${result.payloadSha256}.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error("Announcement signing failed. Check protected main, approved source/key, deployment baseline and artifact integrity; secret values are never logged."); process.exitCode = 1; });
}
