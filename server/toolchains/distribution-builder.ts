import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  OFFICIAL_TOOLCHAIN_MANIFEST_PUBLIC_KEYS,
  TOOLCHAIN_RELEASE_BLUEPRINTS,
  validateManifestDocument,
} from "./manifest.js";
import {
  extractToolchainArchive,
  verifyToolchainArchiveChecksum,
  verifyToolchainExecutable,
} from "./installer.js";
import {
  TOOLCHAIN_PACKAGE_RECEIPT,
  writeToolchainPackageReceipt,
} from "./package-store.js";
import type {
  ToolchainDescriptor,
  ToolchainManifestDocument,
} from "./types.js";

export type DistributionVariant = "full" | "core";

export interface DistributionBuildOptions {
  variant: DistributionVariant;
  inputRoot: string;
  outputRoot: string;
  platform: "win32" | "darwin";
  arch: "x64" | "arm64";
  trustedPublicKeys?: Readonly<Record<string, string>>;
  extractArchive?: typeof extractToolchainArchive;
  verifyExecutable?: typeof verifyToolchainExecutable;
}

interface DistributionLockV1 {
  schemaVersion: 1;
  distribution: DistributionVariant;
  platform: DistributionBuildOptions["platform"];
  arch: DistributionBuildOptions["arch"];
  manifestSha256: string;
  packages: readonly {
    id: string;
    version: string;
    archiveSha256: string;
    installedSizeBytes: number;
  }[];
}

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_PACKAGE_FILES = 500_000;
const MAX_INSTALLED_BYTES = 8 * 1024 * 1024 * 1024;

export async function prepareDistributionResources(
  options: DistributionBuildOptions,
): Promise<DistributionLockV1> {
  const inputRoot = path.resolve(options.inputRoot);
  const outputRoot = path.resolve(options.outputRoot);
  assertOutputRootIsBuildDirectory(outputRoot);
  const manifestPath = path.join(inputRoot, "toolchains-manifest.json");
  const manifestBytes = fs.readFileSync(manifestPath);
  if (
    manifestBytes.byteLength === 0
    || manifestBytes.byteLength > MAX_MANIFEST_BYTES
  ) {
    throw new Error("Toolchain manifest has an invalid size.");
  }
  let manifestDocument: unknown;
  try {
    manifestDocument = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new Error("Toolchain manifest is not valid JSON.");
  }
  const descriptors = validateManifestDocument(manifestDocument, {
    trustedPublicKeys:
      options.trustedPublicKeys ?? OFFICIAL_TOOLCHAIN_MANIFEST_PUBLIC_KEYS,
    requireSignedV2: true,
  });
  const selected = descriptors
    .filter((descriptor) =>
      descriptor.platform === options.platform && descriptor.arch === options.arch
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  if (options.variant === "full" && selected.length === 0) {
    throw new Error("Full distribution has no toolchain packages for this host.");
  }

  const parent = path.dirname(outputRoot);
  fs.mkdirSync(parent, { recursive: true });
  const operationId = `${process.pid}-${crypto.randomUUID()}`;
  const stagingRoot = `${outputRoot}.stage-${operationId}`;
  const backupRoot = `${outputRoot}.backup-${operationId}`;
  const materialized: DistributionLockV1["packages"][number][] = [];
  let backupCreated = false;
  let outputCommitted = false;
  try {
    fs.mkdirSync(stagingRoot, { recursive: false });
    fs.writeFileSync(
      path.join(stagingRoot, "judgedesk-distribution.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        distribution: options.variant,
      }, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    fs.writeFileSync(
      path.join(stagingRoot, "toolchains-manifest.json"),
      manifestBytes,
      { flag: "wx" },
    );

    if (options.variant === "full") {
      const toolchainsRoot = path.join(stagingRoot, "toolchains");
      fs.mkdirSync(toolchainsRoot);
      for (const descriptor of selected) {
        await materializePackage(
          inputRoot,
          toolchainsRoot,
          descriptor,
          options,
        );
        materialized.push({
          id: descriptor.id,
          version: descriptor.version,
          archiveSha256: descriptor.sha256,
          installedSizeBytes: descriptor.installedSizeBytes!,
        });
      }
    }

    const lock: DistributionLockV1 = {
      schemaVersion: 1,
      distribution: options.variant,
      platform: options.platform,
      arch: options.arch,
      manifestSha256: sha256Bytes(manifestBytes),
      packages: materialized,
    };
    fs.writeFileSync(
      path.join(stagingRoot, "judgedesk-distribution-lock.json"),
      `${JSON.stringify(lock, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    if (fs.existsSync(outputRoot)) {
      fs.renameSync(outputRoot, backupRoot);
      backupCreated = true;
    }
    fs.renameSync(stagingRoot, outputRoot);
    outputCommitted = true;
    if (backupCreated) {
      fs.rmSync(backupRoot, { recursive: true, force: true });
      backupCreated = false;
    }
    return lock;
  } catch (error) {
    if (outputCommitted && fs.existsSync(outputRoot)) {
      fs.rmSync(outputRoot, { recursive: true, force: true });
      outputCommitted = false;
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
}

async function materializePackage(
  inputRoot: string,
  toolchainsRoot: string,
  descriptor: ToolchainDescriptor,
  options: DistributionBuildOptions,
): Promise<void> {
  const blueprint = TOOLCHAIN_RELEASE_BLUEPRINTS[descriptor.id];
  if (!blueprint) {
    throw new Error(`No archive filename is trusted for '${descriptor.id}'.`);
  }
  const archivePath = path.join(inputRoot, blueprint.archiveFilename);
  const archive = fs.statSync(archivePath, { throwIfNoEntry: false });
  if (!archive?.isFile() || archive.size !== descriptor.sizeBytes) {
    throw new Error(`Package '${descriptor.id}' has an invalid archive size.`);
  }
  if (!(await verifyToolchainArchiveChecksum(archivePath, descriptor.sha256))) {
    throw new Error(`Package '${descriptor.id}' failed SHA-256 verification.`);
  }
  const packageRoot = path.join(toolchainsRoot, descriptor.id);
  (options.extractArchive ?? extractToolchainArchive)(
    archivePath,
    packageRoot,
    descriptor.archiveFormat,
  );
  if (fs.existsSync(path.join(packageRoot, TOOLCHAIN_PACKAGE_RECEIPT))) {
    throw new Error(
      `Package '${descriptor.id}' attempted to supply its own trust receipt.`,
    );
  }
  const installedSizeBytes = inspectExtractedPackage(packageRoot, descriptor);
  if (installedSizeBytes !== descriptor.installedSizeBytes) {
    throw new Error(
      `Package '${descriptor.id}' installed-size verification failed.`,
    );
  }
  (options.verifyExecutable ?? verifyToolchainExecutable)(
    path.join(
      packageRoot,
      ...descriptor.executableRelativePath.replaceAll("\\", "/").split("/"),
    ),
  );
  writeToolchainPackageReceipt(packageRoot, descriptor);
}

function inspectExtractedPackage(
  packageRoot: string,
  descriptor: ToolchainDescriptor,
): number {
  for (const relativePath of [
    ...(descriptor.license?.licenseFiles ?? []),
    ...(descriptor.license?.noticeFiles ?? []),
    ...(descriptor.license ? [descriptor.license.sbomPath] : []),
  ]) {
    if (
      !fs.statSync(
        path.join(packageRoot, ...relativePath.split("/")),
        { throwIfNoEntry: false },
      )?.isFile()
    ) {
      throw new Error(
        `Package '${descriptor.id}' is missing release metadata '${relativePath}'.`,
      );
    }
  }
  let fileCount = 0;
  let totalBytes = 0;
  const pending = [packageRoot];
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
        throw new Error(`Package '${descriptor.id}' exceeds distribution limits.`);
      }
    }
  }
  return Math.max(1, totalBytes);
}

function assertOutputRootIsBuildDirectory(outputRoot: string): void {
  const workspaceRoot = path.resolve(process.cwd());
  const buildRoot = path.join(workspaceRoot, "build");
  const relative = path.relative(buildRoot, outputRoot);
  if (
    relative === ""
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error("Distribution output must be a child of the workspace build directory.");
  }
}

function sha256Bytes(value: Uint8Array): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

