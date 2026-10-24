import { verifyBytes, payloadIdentity } from "./publisher-security.mjs";

/** @param {string} url @param {number} maximum @param {HeadersInit} [headers] */
export async function boundedGet(url, maximum, headers = {}) {
  if (new URL(url).protocol !== "https:") throw new Error("Publisher endpoints must use HTTPS");
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(10_000), headers: { "Accept-Encoding": "identity", ...headers } });
  if (![200, 404].includes(response.status)) throw new Error(`Remote endpoint returned HTTP ${response.status}`);
  const encoding = response.headers.get("content-encoding");
  if (encoding && encoding.toLowerCase() !== "identity") throw new Error("Compressed publisher responses are not supported");
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > maximum)) throw new Error("Remote body exceeds its byte limit");
  const chunks = []; let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.length;
        if (size > maximum) throw new Error("Remote streamed body exceeds its byte limit");
        chunks.push(Buffer.from(chunk.value));
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
  }
  return { status: response.status, bytes: Buffer.concat(chunks, size), contentType: response.headers.get("content-type") };
}

/** @param {string} route */
async function github(route) {
  const token = process.env.GH_TOKEN;
  const result = await boundedGet(`https://api.github.com/repos/ducminh25/judgedesk${route}`, 4 * 1024 * 1024, {
    Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}),
  });
  if (result.status !== 200) throw new Error("GitHub publication state is unavailable");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.bytes));
}
/** @param {string} candidateCommit */
export async function assertCurrentProtectedMain(candidateCommit) {
  if (!/^[0-9a-f]{40}$/.test(candidateCommit)) throw new Error("A full publication commit SHA is required");
  const branch = await github("/branches/main");
  if (branch.commit?.sha !== candidateCommit || branch.protected !== true) throw new Error("Publication requires current protected main; stale rerun or unprotected branch refused");
}
/** @param {string} candidateCommit */
export async function verifiedBootstrap(candidateCommit) {
  if (process.env.ANNOUNCEMENTS_BOOTSTRAP_COMMIT !== candidateCommit) return false;
  const deployments = await github("/deployments?environment=github-pages&per_page=1");
  if (!Array.isArray(deployments) || deployments.length !== 0) throw new Error("Bootstrap cannot be reused after a Pages deployment exists");
  return true;
}
/** @param {{endpoint: string, keys: {keyId:string, publicKeyBase64:string}[]}} trust */
export async function deployedIdentity(trust) {
  const response = await boundedGet(trust.endpoint, 1536 * 1024);
  if (response.status === 404) return null; // Caller must prove never-deployed; 404 alone grants nothing.
  const payload = verifyBytes(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.bytes)), trust);
  return payloadIdentity(payload);
}
