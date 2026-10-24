import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { verifyBytes, payloadIdentity, assertPublicationBaseline, verifyBootstrapReceipt } from "./publisher-security.mjs";
import { assertCurrentProtectedMain, boundedGet, deployedIdentity } from "./publisher-network.mjs";
import { regularBytes } from "./sign-publish.mjs";

/** @param {string} trustFile @param {string} envelopeFile */
async function candidate(trustFile, envelopeFile) {
  const trust = JSON.parse((await regularBytes(trustFile, 16384)).toString("utf8"));
  const envelope = JSON.parse((await regularBytes(envelopeFile, 1536 * 1024)).toString("utf8"));
  const payload = verifyBytes(envelope, trust);
  return { trust, payload, identity: payloadIdentity(payload) };
}
/** @param {string} trustFile @param {string} envelopeFile @param {string} commit */
export async function predeploy(trustFile, envelopeFile, commit) {
  await assertCurrentProtectedMain(commit);
  const expected = await candidate(trustFile, envelopeFile);
  const deployed = await deployedIdentity(expected.trust);
  // The github-pages environment creates this job's own deployment record before
  // steps run. Never reinterpret that as a prior publication or re-run bootstrap.
  // Only the signing job can authorize the first deployment for this exact attempt.
  const bootstrap = verifyBootstrapReceipt(process.env.ANNOUNCEMENTS_BOOTSTRAP_RECEIPT ?? "", { commit, runId: process.env.GITHUB_RUN_ID ?? "", attempt: process.env.GITHUB_RUN_ATTEMPT ?? "", payloadSha256: expected.identity.payloadSha256 });
  assertPublicationBaseline(expected.identity, deployed, bootstrap);
  console.log(`Deployment guard passed for sequence ${expected.identity.sequence}.`);
}
/** @param {string} trustFile @param {string} envelopeFile */
export async function smoke(trustFile, envelopeFile) {
  const expected = await candidate(trustFile, envelopeFile);
  for (let attempt = 0; attempt < 6; ++attempt) {
    try {
      const actual = await deployedIdentity(expected.trust);
      if (!actual || actual.sequence !== expected.identity.sequence || actual.payloadSha256 !== expected.identity.payloadSha256) throw new Error("Propagation pending");
      const payload = JSON.parse(expected.payload.toString("utf8"));
      const samples = payload.items.flatMap((item) => item.images).slice(0, 3);
      for (const image of samples) {
        const response = await boundedGet(`${expected.trust.mediaPrefix}${image.sha256}.${image.extension}`, 4 * 1024 * 1024);
        if (response.status !== 200 || response.bytes.length !== image.sizeBytes || response.contentType?.split(";")[0].trim() !== image.mime || createHash("sha256").update(response.bytes).digest("hex") !== image.sha256) throw new Error("Media propagation pending");
      }
      console.log(`Live signed sequence ${actual.sequence} verified; ${samples.length} image samples passed. No client-delivery claim.`); return;
    } catch (error) {
      if (attempt === 5) throw new Error("Pages propagation/verification remains pending after bounded retry; do not roll back the signed sequence", { cause: error });
      await new Promise((resolve) => setTimeout(resolve, Math.min(8000, 2000 * (attempt + 1))));
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, trust, envelope, commit] = process.argv.slice(2);
  const run = mode === "predeploy" && trust && envelope && commit ? predeploy(trust, envelope, commit) : mode === "smoke" && trust && envelope ? smoke(trust, envelope) : Promise.reject(new Error("Usage: publication-guard.mjs predeploy TRUST ENVELOPE COMMIT | smoke TRUST ENVELOPE"));
  run.catch((error) => { console.error(error instanceof Error ? error.message : "Publication guard failed"); process.exitCode = 1; });
}
