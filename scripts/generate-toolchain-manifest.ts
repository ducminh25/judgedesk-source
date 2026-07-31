import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  OFFICIAL_TOOLCHAIN_MANIFEST_PUBLIC_KEYS,
  TOOLCHAIN_RELEASE_BLUEPRINTS,
  canonicalizeManifestPayload,
  validateManifestDocument,
} from "../server/toolchains/manifest.js";
import {
  TOOLCHAIN_PACKAGE_RECEIPT,
} from "../server/toolchains/package-store.js";
import type {
  ToolchainManifestV2Document,
  ToolchainManifestV2Package,
  ToolchainManifestV2Payload,
  ToolchainReleaseBlueprint,
} from "../server/toolchains/types.js";
import {
  TOOLCHAIN_SOURCE_PROVENANCE_FILENAME,
  validateToolchainSourceProvenance,
} from "./toolchain-release-sources.js";
import {
  listCurrentReleaseManagedPackageIds,
} from "../server/toolchains/release-scope.js";
import {
  extractToolchainReleaseArchive,
  type ReleaseArchiveExtractionSummary,
} from "./release-archive-extractor.js";

const MAX_PACKAGE_FILES = 500_000;
const MAX_INSTALLED_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_SBOM_BYTES = 16 * 1024 * 1024;

async function sha256(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function canonicalGeneratedAt(): string {
  const configured = process.env.TOOLCHAIN_MANIFEST_GENERATED_AT;
  if (configured) {
    const timestamp = Date.parse(configured);
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== configured) {
      throw new Error("TOOLCHAIN_MANIFEST_GENERATED_AT must be a canonical ISO timestamp.");
    }
    return configured;
  }
  const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH;
  if (sourceDateEpoch) {
    if (!/^(0|[1-9][0-9]{0,15})$/.test(sourceDateEpoch)) {
      throw new Error("SOURCE_DATE_EPOCH must be a non-negative integer.");
    }
    return new Date(Number(sourceDateEpoch) * 1000).toISOString();
  }
  return new Date().toISOString();
}

function loadSigningKey(): {
  keyId: string;
  privateKey: crypto.KeyObject;
} {
  const keyId = process.env.TOOLCHAIN_MANIFEST_SIGNING_KEY_ID;
  if (!keyId || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(keyId)) {
    throw new Error("TOOLCHAIN_MANIFEST_SIGNING_KEY_ID is required.");
  }
  const keyPath = process.env.TOOLCHAIN_MANIFEST_SIGNING_PRIVATE_KEY_PATH;
  const keyBase64 = process.env.TOOLCHAIN_MANIFEST_SIGNING_PRIVATE_KEY_B64;
  if (!!keyPath === !!keyBase64) {
    throw new Error(
      "Configure exactly one of TOOLCHAIN_MANIFEST_SIGNING_PRIVATE_KEY_PATH or TOOLCHAIN_MANIFEST_SIGNING_PRIVATE_KEY_B64.",
    );
  }
  const pem = keyPath
    ? fs.readFileSync(path.resolve(keyPath), "utf8")
    : Buffer.from(keyBase64!, "base64").toString("utf8");
  const privateKey = crypto.createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Toolchain manifest signing key must be Ed25519.");
  }
  const trustedPublicKey = OFFICIAL_TOOLCHAIN_MANIFEST_PUBLIC_KEYS[keyId];
  if (!trustedPublicKey) {
    throw new Error(`Signing key '${keyId}' is not present in the app trust store.`);
  }
  const actualPublicDer = crypto
    .createPublicKey(privateKey)
    .export({ type: "spki", format: "der" });
  const trustedPublicDer = crypto
    .createPublicKey(trustedPublicKey)
    .export({ type: "spki", format: "der" });
  if (!crypto.timingSafeEqual(actualPublicDer, trustedPublicDer)) {
    throw new Error(`Private key does not match trusted key '${keyId}'.`);
  }
  return { keyId, privateKey };
}

function inspectPackageTree(
  root: string,
  blueprint: ToolchainReleaseBlueprint,
  extraction: ReleaseArchiveExtractionSummary,
): number {
  if (fs.existsSync(path.join(root, TOOLCHAIN_PACKAGE_RECEIPT))) {
    throw new Error(
      `Archive '${blueprint.archiveFilename}' must not contain ${TOOLCHAIN_PACKAGE_RECEIPT}.`,
    );
  }
  for (const component of blueprint.components) {
    const componentPath = component.relativePath === "."
      ? root
      : path.join(root, ...component.relativePath.split("/"));
    const metadata = fs.statSync(componentPath, { throwIfNoEntry: false });
    if (
      !metadata
      || (component.kind === "executable" && !metadata.isFile())
      || (component.kind === "support-root" && !metadata.isDirectory())
    ) {
      throw new Error(
        `Archive '${blueprint.archiveFilename}' is missing component '${component.id}'.`,
      );
    }
  }
  for (const relativePath of [
    ...blueprint.license.licenseFiles,
    ...blueprint.license.noticeFiles,
    blueprint.license.sbomPath,
  ]) {
    const filePath = path.join(root, ...relativePath.split("/"));
    if (!fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(
        `Archive '${blueprint.archiveFilename}' is missing release metadata '${relativePath}'.`,
      );
    }
  }
  const sbomPath = path.join(root, ...blueprint.license.sbomPath.split("/"));
  const sbomBytes = fs.readFileSync(sbomPath);
  if (sbomBytes.byteLength === 0 || sbomBytes.byteLength > MAX_SBOM_BYTES) {
    throw new Error(`Archive '${blueprint.archiveFilename}' has an invalid SBOM size.`);
  }
  let sbom: unknown;
  try {
    sbom = JSON.parse(sbomBytes.toString("utf8"));
  } catch {
    throw new Error(`Archive '${blueprint.archiveFilename}' has an invalid SBOM.`);
  }
  if (
    !sbom
    || typeof sbom !== "object"
    || Array.isArray(sbom)
    || (sbom as Record<string, unknown>).spdxVersion !== "SPDX-2.3"
  ) {
    throw new Error(
      `Archive '${blueprint.archiveFilename}' must contain an SPDX 2.3 SBOM.`,
    );
  }
  const provenancePath = path.join(
    root,
    TOOLCHAIN_SOURCE_PROVENANCE_FILENAME,
  );
  let provenance: unknown;
  try {
    provenance = JSON.parse(fs.readFileSync(provenancePath, "utf8"));
  } catch {
    throw new Error(
      `Archive '${blueprint.archiveFilename}' has invalid source provenance.`,
    );
  }
  validateToolchainSourceProvenance(provenance, blueprint.id);

  let fileCount = 0;
  let totalBytes = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const metadata = fs.lstatSync(entryPath);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      fileCount += 1;
      totalBytes += metadata.size;
      if (fileCount > MAX_PACKAGE_FILES || totalBytes > MAX_INSTALLED_BYTES) {
        throw new Error(
          `Archive '${blueprint.archiveFilename}' exceeds release inspection limits.`,
        );
      }
    }
  }
  if (
    fileCount !== extraction.fileCount
    || totalBytes !== extraction.materializedSizeBytes
  ) {
    throw new Error(
      `Archive '${blueprint.archiveFilename}' extraction summary did not match its materialized tree.`,
    );
  }
  return Math.max(1, extraction.installedSizeBytes);
}

async function buildPackage(
  outputDirectory: string,
  releaseBaseUrl: string,
  blueprint: ToolchainReleaseBlueprint,
): Promise<ToolchainManifestV2Package> {
  const archivePath = path.join(outputDirectory, blueprint.archiveFilename);
  const archiveMetadata = fs.statSync(archivePath, { throwIfNoEntry: false });
  if (!archiveMetadata?.isFile() || archiveMetadata.size <= 0) {
    throw new Error(`Missing toolchain artifact: ${blueprint.archiveFilename}`);
  }
  const inspectionRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), `judgedesk-release-${blueprint.id}-`),
  );
  let installedSizeBytes: number;
  try {
    if (
      blueprint.archiveFormat !== "zip"
      && blueprint.archiveFormat !== "tar.gz"
    ) {
      throw new Error(
        `Unsupported release inspection format '${blueprint.archiveFormat}'.`,
      );
    }
    const extraction = extractToolchainReleaseArchive(
      archivePath,
      inspectionRoot,
      blueprint.archiveFormat,
    );
    installedSizeBytes = inspectPackageTree(
      inspectionRoot,
      blueprint,
      extraction,
    );
  } finally {
    fs.rmSync(inspectionRoot, { recursive: true, force: true });
  }
  const { archiveFilename, ...signedBlueprint } = blueprint;
  return {
    ...signedBlueprint,
    downloadUrl: `${releaseBaseUrl}/${encodeURIComponent(archiveFilename)}`,
    sha256: await sha256(archivePath),
    sizeBytes: archiveMetadata.size,
    installedSizeBytes,
  };
}

const outputDirectory = path.resolve(process.argv[2] || "dist-toolchains");
const releaseBaseUrl = (
  process.env.TOOLCHAIN_RELEASE_BASE_URL
  || "https://github.com/ducminh25/judgedesk/releases/download/toolchains-v2"
).replace(/\/$/, "");
const { keyId, privateKey } = loadSigningKey();
const blueprints = [
  ...listCurrentReleaseManagedPackageIds("win32", "x64"),
  ...listCurrentReleaseManagedPackageIds("darwin", "arm64"),
]
  .map((packageId) => {
    const blueprint = TOOLCHAIN_RELEASE_BLUEPRINTS[packageId];
    if (!blueprint) {
      throw new Error(
        `Current release package '${packageId}' has no trusted blueprint.`,
      );
    }
    return blueprint;
  })
  .sort((left, right) => left.id.localeCompare(right.id));
const packages: ToolchainManifestV2Package[] = [];
for (const blueprint of blueprints) {
  packages.push(await buildPackage(outputDirectory, releaseBaseUrl, blueprint));
}

const payload: ToolchainManifestV2Payload = {
  generatedAt: canonicalGeneratedAt(),
  packages,
};
const signature = crypto.sign(
  null,
  Buffer.from(canonicalizeManifestPayload(payload), "utf8"),
  privateKey,
);
const document: ToolchainManifestV2Document = {
  schemaVersion: 2,
  signed: payload,
  signature: {
    algorithm: "ed25519",
    keyId,
    value: signature.toString("base64"),
  },
};
validateManifestDocument(document, { requireSignedV2: true });

fs.mkdirSync(outputDirectory, { recursive: true });
const manifestPath = path.join(outputDirectory, "toolchains-manifest.json");
fs.writeFileSync(manifestPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");

const checksumFiles = [
  ...blueprints.map((blueprint) => blueprint.archiveFilename),
  path.basename(manifestPath),
].sort();
const checksumLines: string[] = [];
for (const filename of checksumFiles) {
  checksumLines.push(`${await sha256(path.join(outputDirectory, filename))}  ${filename}`);
}
fs.writeFileSync(
  path.join(outputDirectory, "SHA256SUMS"),
  `${checksumLines.join("\n")}\n`,
  "utf8",
);

console.log(
  `Generated signed manifest v2 at ${manifestPath} with ${packages.length} verified packages.`,
);
