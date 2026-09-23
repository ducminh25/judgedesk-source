import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_TOOLCHAIN_MANIFEST_URL,
  OFFICIAL_TOOLCHAIN_MANIFEST_PUBLIC_KEYS,
  TOOLCHAIN_RELEASE_BLUEPRINTS,
  validateManifestDocument,
} from "../server/toolchains/manifest.js";
import {
  listCurrentReleaseManagedPackageIds,
} from "../server/toolchains/release-scope.js";

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

function mappedHost(): {
  platform: "win32" | "darwin";
  arch: "x64" | "arm64";
} {
  const platform = os.platform();
  const arch = os.arch();
  if (
    (platform !== "win32" && platform !== "darwin")
    || (arch !== "x64" && arch !== "arm64")
  ) {
    throw new Error(`Unsupported toolchain release host: ${platform}/${arch}`);
  }
  return { platform, arch };
}

function assertBuildOutput(outputRoot: string): void {
  const buildRoot = path.join(path.resolve(process.cwd()), "build");
  const relative = path.relative(buildRoot, outputRoot);
  if (
    relative === ""
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error("Toolchain download output must be inside the workspace build directory.");
  }
}

async function downloadArchiveOnce(
  url: string,
  outputPath: string,
  expectedBytes: number,
  expectedSha256: string,
): Promise<void> {
  const response = await fetch(url, {
    redirect: "follow",
    headers: { Accept: "application/octet-stream" },
    signal: AbortSignal.timeout(15 * 60_000),
  });
  if (!response.ok || !response.body) {
    throw new Error(`Toolchain package request failed (${response.status}).`);
  }
  const announcedSize = Number(response.headers.get("content-length") || 0);
  if (announcedSize > 0 && announcedSize !== expectedBytes) {
    throw new Error("Toolchain package server announced an unexpected size.");
  }
  const hash = crypto.createHash("sha256");
  const handle = fs.createWriteStream(outputPath, { flags: "wx" });
  let received = 0;
  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = Buffer.from(value);
      received += bytes.byteLength;
      if (received > expectedBytes) {
        throw new Error("Toolchain package exceeded its signed size.");
      }
      hash.update(bytes);
      if (!handle.write(bytes)) await once(handle, "drain");
    }
    await new Promise<void>((resolve, reject) => {
      handle.once("error", reject);
      handle.end(resolve);
    });
  } catch (error) {
    handle.destroy();
    try { fs.rmSync(outputPath, { force: true }); } catch {}
    throw error;
  }
  if (
    received !== expectedBytes
    || hash.digest("hex") !== expectedSha256
  ) {
    try { fs.rmSync(outputPath, { force: true }); } catch {}
    throw new Error("Toolchain package failed signed size or SHA-256 verification.");
  }
}

async function downloadArchive(
  url: string,
  outputPath: string,
  expectedBytes: number,
  expectedSha256: string,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      try { fs.rmSync(outputPath, { force: true }); } catch {}
      await downloadArchiveOnce(url, outputPath, expectedBytes, expectedSha256);
      return;
    } catch (err) {
      lastError = err;
      console.warn(`Download attempt ${attempt}/3 failed: ${(err as Error)?.message || err}. Retrying...`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastError;
}

const mode = (process.argv[2] || "full").toLowerCase();
if (mode !== "full" && mode !== "core") {
  throw new Error("Usage: npx tsx scripts/fetch-toolchain-release.ts <full|core> [output]");
}
const outputRoot = path.resolve(
  process.argv[3] || "build/toolchain-release-input",
);
assertBuildOutput(outputRoot);
const manifestUrl =
  process.env.THEMIS_TOOLCHAIN_MANIFEST_URL
  || DEFAULT_TOOLCHAIN_MANIFEST_URL;
const manifestResponse = await fetch(manifestUrl, {
  redirect: "follow",
  headers: { Accept: "application/json" },
  signal: AbortSignal.timeout(15_000),
});
if (!manifestResponse.ok) {
  throw new Error(`Toolchain manifest request failed (${manifestResponse.status}).`);
}
const manifestBytes = Buffer.from(await manifestResponse.arrayBuffer());
if (
  manifestBytes.byteLength === 0
  || manifestBytes.byteLength > MAX_MANIFEST_BYTES
) {
  throw new Error("Toolchain manifest has an invalid size.");
}
let document: unknown;
try {
  document = JSON.parse(manifestBytes.toString("utf8"));
} catch {
  throw new Error("Toolchain manifest is not valid JSON.");
}
const descriptors = validateManifestDocument(document, {
  trustedPublicKeys: OFFICIAL_TOOLCHAIN_MANIFEST_PUBLIC_KEYS,
  requireSignedV2: true,
});
const host = mappedHost();
const requiredPackageIds = new Set(
  listCurrentReleaseManagedPackageIds(host.platform, host.arch),
);
const selected = mode === "full"
  ? descriptors.filter((descriptor) =>
      descriptor.platform === host.platform
      && descriptor.arch === host.arch
      && requiredPackageIds.has(descriptor.id)
    )
  : [];
if (mode === "full" && selected.length !== requiredPackageIds.size) {
  throw new Error(
    "Signed catalog does not contain the complete current Full package set for this host.",
  );
}

const operationId = `${process.pid}-${crypto.randomUUID()}`;
const stagingRoot = `${outputRoot}.stage-${operationId}`;
const backupRoot = `${outputRoot}.backup-${operationId}`;
let backupCreated = false;
let committed = false;
try {
  fs.mkdirSync(path.dirname(outputRoot), { recursive: true });
  fs.mkdirSync(stagingRoot);
  fs.writeFileSync(
    path.join(stagingRoot, "toolchains-manifest.json"),
    manifestBytes,
    { flag: "wx" },
  );
  for (const descriptor of selected) {
    const blueprint = TOOLCHAIN_RELEASE_BLUEPRINTS[descriptor.id];
    if (!blueprint) {
      throw new Error(`No trusted archive filename for '${descriptor.id}'.`);
    }
    const targetFile = path.join(stagingRoot, blueprint.archiveFilename);
    const cacheCandidates = [
      path.join(outputRoot, blueprint.archiveFilename),
      path.resolve("build", "gh-toolchains", blueprint.archiveFilename),
    ];
    let reused = false;
    for (const existingCandidate of cacheCandidates) {
      if (fs.existsSync(existingCandidate)) {
        const stat = fs.statSync(existingCandidate);
        if (stat.size === descriptor.sizeBytes) {
          const hash = crypto.createHash("sha256").update(fs.readFileSync(existingCandidate)).digest("hex");
          if (hash === descriptor.sha256) {
            console.log(`Reusing verified cached archive for ${descriptor.id}.`);
            fs.copyFileSync(existingCandidate, targetFile);
            reused = true;
            break;
          }
        }
      }
    }
    if (!reused) {
      console.log(
        `Downloading ${descriptor.id} (${descriptor.sizeBytes} signed bytes)...`,
      );
      await downloadArchive(
        descriptor.downloadUrl,
        targetFile,
        descriptor.sizeBytes,
        descriptor.sha256,
      );
    }
  }
  if (fs.existsSync(outputRoot)) {
    fs.renameSync(outputRoot, backupRoot);
    backupCreated = true;
  }
  fs.renameSync(stagingRoot, outputRoot);
  committed = true;
  if (backupCreated) {
    fs.rmSync(backupRoot, { recursive: true, force: true });
    backupCreated = false;
  }
} catch (error) {
  if (committed && fs.existsSync(outputRoot)) {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
  if (backupCreated && fs.existsSync(backupRoot)) {
    fs.renameSync(backupRoot, outputRoot);
    backupCreated = false;
  }
  throw error;
} finally {
  for (const candidate of [stagingRoot, backupRoot]) {
    if (fs.existsSync(candidate)) {
      fs.rmSync(candidate, { recursive: true, force: true });
    }
  }
}
console.log(
  `Fetched JudgeDesk ${mode} release input for ${host.platform}/${host.arch}.`,
);
