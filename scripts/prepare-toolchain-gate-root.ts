import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  TOOLCHAIN_RELEASE_BLUEPRINTS,
} from "../server/toolchains/manifest.js";
import {
  extractToolchainArchive,
  verifyToolchainExecutable,
} from "../server/toolchains/installer.js";
import {
  TOOLCHAIN_PACKAGE_RECEIPT,
  writeToolchainPackageReceipt,
} from "../server/toolchains/package-store.js";
import {
  TOOLCHAIN_SOURCE_PROVENANCE_FILENAME,
} from "../server/toolchains/release-metadata.js";
import type {
  ToolchainDescriptor,
  ToolchainReleaseBlueprint,
} from "../server/toolchains/types.js";
import {
  resolvePackagingHost,
  selectHostToolchainReleases,
  type PackagingHost,
} from "./package-toolchains.js";
import {
  validateToolchainSourceProvenance,
} from "./toolchain-release-sources.js";

const MAX_PROVENANCE_BYTES = 512 * 1024;
const MAX_PACKAGE_FILES = 500_000;
const MAX_INSTALLED_BYTES = 8 * 1024 * 1024 * 1024;

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === ""
    || (
      relative !== ".."
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)
    )
  );
}

function assertBuildChild(candidate: string): void {
  const buildRoot = path.join(path.resolve(process.cwd()), "build");
  const resolved = path.resolve(candidate);
  if (resolved === buildRoot || !isInside(buildRoot, resolved)) {
    throw new Error(
      "Toolchain gate output must be a child of the workspace build directory.",
    );
  }
}

async function sha256(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function inspectPackageTree(
  packageRoot: string,
  blueprint: ToolchainReleaseBlueprint,
): number {
  if (fs.existsSync(path.join(packageRoot, TOOLCHAIN_PACKAGE_RECEIPT))) {
    throw new Error(
      `Archive '${blueprint.archiveFilename}' supplied a trust receipt.`,
    );
  }
  for (const component of blueprint.components) {
    const componentPath = component.relativePath === "."
      ? packageRoot
      : path.join(packageRoot, ...component.relativePath.split("/"));
    const metadata = fs.statSync(componentPath, { throwIfNoEntry: false });
    if (
      !metadata
      || (component.kind === "executable" && !metadata.isFile())
      || (component.kind === "support-root" && !metadata.isDirectory())
    ) {
      throw new Error(
        `Archive '${blueprint.archiveFilename}' is missing '${component.id}'.`,
      );
    }
  }
  for (const relativePath of [
    ...blueprint.license.licenseFiles,
    ...blueprint.license.noticeFiles,
    blueprint.license.sbomPath,
    TOOLCHAIN_SOURCE_PROVENANCE_FILENAME,
  ]) {
    if (
      !fs.statSync(
        path.join(packageRoot, ...relativePath.split("/")),
        { throwIfNoEntry: false },
      )?.isFile()
    ) {
      throw new Error(
        `Archive '${blueprint.archiveFilename}' is missing '${relativePath}'.`,
      );
    }
  }

  const provenancePath = path.join(
    packageRoot,
    TOOLCHAIN_SOURCE_PROVENANCE_FILENAME,
  );
  const provenanceBytes = fs.readFileSync(provenancePath);
  if (
    provenanceBytes.byteLength === 0
    || provenanceBytes.byteLength > MAX_PROVENANCE_BYTES
  ) {
    throw new Error(
      `Archive '${blueprint.archiveFilename}' has invalid source provenance.`,
    );
  }
  let provenance: unknown;
  try {
    provenance = JSON.parse(provenanceBytes.toString("utf8"));
  } catch {
    throw new Error(
      `Archive '${blueprint.archiveFilename}' has invalid source provenance.`,
    );
  }
  validateToolchainSourceProvenance(provenance, blueprint.id);

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
      if (
        fileCount > MAX_PACKAGE_FILES
        || totalBytes > MAX_INSTALLED_BYTES
      ) {
        throw new Error(
          `Archive '${blueprint.archiveFilename}' exceeds gate limits.`,
        );
      }
    }
  }
  return Math.max(1, totalBytes);
}

export async function prepareToolchainGateRoot(options: {
  inputRoot: string;
  outputRoot: string;
  requestedPackageIds?: readonly string[];
  host?: PackagingHost;
  extractArchive?: typeof extractToolchainArchive;
  verifyExecutable?: typeof verifyToolchainExecutable;
}): Promise<void> {
  const host = options.host ?? resolvePackagingHost();
  const actualHost = resolvePackagingHost();
  if (
    host.platform !== actualHost.platform
    || host.arch !== actualHost.arch
  ) {
    throw new Error("Toolchain gates cannot prepare packages for another host.");
  }
  const inputRoot = path.resolve(options.inputRoot);
  const outputRoot = path.resolve(options.outputRoot);
  assertBuildChild(outputRoot);
  const selected = selectHostToolchainReleases(
    host,
    options.requestedPackageIds,
  );
  const operationId = `${process.pid}-${crypto.randomUUID()}`;
  const stagingRoot = `${outputRoot}.stage-${operationId}`;
  const backupRoot = `${outputRoot}.backup-${operationId}`;
  for (const candidate of [stagingRoot, backupRoot]) assertBuildChild(candidate);
  let backupCreated = false;
  let committed = false;
  const lockPackages: {
    id: string;
    archiveSha256: string;
    installedSizeBytes: number;
  }[] = [];
  try {
    fs.mkdirSync(path.dirname(outputRoot), { recursive: true });
    fs.mkdirSync(stagingRoot);
    for (const release of selected) {
      const blueprint = TOOLCHAIN_RELEASE_BLUEPRINTS[release.packageId];
      console.log(`Preparing ${release.packageId} for local release gates...`);
      const archivePath = path.join(inputRoot, blueprint.archiveFilename);
      const archive = fs.statSync(archivePath, { throwIfNoEntry: false });
      if (!archive?.isFile() || archive.size <= 0) {
        throw new Error(`Missing gate archive '${blueprint.archiveFilename}'.`);
      }
      const packageRoot = path.join(stagingRoot, release.packageId);
      (options.extractArchive ?? extractToolchainArchive)(
        archivePath,
        packageRoot,
        blueprint.archiveFormat,
      );
      const installedSizeBytes = inspectPackageTree(packageRoot, blueprint);
      const entrypoint = blueprint.entrypoints.find(
        (candidate) =>
          candidate.componentId === blueprint.entrypointComponentId,
      );
      if (!entrypoint) {
        throw new Error(
          `Package '${release.packageId}' has no declared primary entrypoint.`,
        );
      }
      const executablePath = path.join(
        packageRoot,
        ...entrypoint.executableRelativePath.split("/"),
      );
      try {
        (options.verifyExecutable ?? verifyToolchainExecutable)(
          executablePath,
          blueprint.healthProbeId,
        );
      } catch (error) {
        throw new Error(
          `Package '${release.packageId}' failed executable verification.`,
          { cause: error },
        );
      }
      const archiveSha256 = await sha256(archivePath);
      const { archiveFilename: _archiveFilename, ...packagePolicy } = blueprint;
      const descriptor: ToolchainDescriptor = {
        ...packagePolicy,
        executableRelativePath: entrypoint.executableRelativePath,
        licenseFiles: [...blueprint.license.licenseFiles],
        downloadUrl: `https://invalid.local/${encodeURIComponent(blueprint.archiveFilename)}`,
        sha256: archiveSha256,
        sizeBytes: archive.size,
        installedSizeBytes,
      };
      writeToolchainPackageReceipt(packageRoot, descriptor);
      lockPackages.push({
        id: release.packageId,
        archiveSha256,
        installedSizeBytes,
      });
    }
    fs.writeFileSync(
      path.join(stagingRoot, ".judgedesk-local-gate-root.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        platform: host.platform,
        arch: host.arch,
        packages: lockPackages,
      }, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
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
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const inputRoot = process.argv[2] || "dist-toolchains";
  const outputRoot = process.argv[3] || "build/toolchain-gate-root";
  const requestedPackageIds = process.argv.slice(4);
  await prepareToolchainGateRoot({
    inputRoot,
    outputRoot,
    requestedPackageIds,
  });
  console.log(
    `Prepared local ${os.platform()}/${os.arch()} toolchain gate root at ${path.resolve(outputRoot)}.`,
  );
}
