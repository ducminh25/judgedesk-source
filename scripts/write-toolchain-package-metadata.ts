import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { TOOLCHAIN_RELEASE_BLUEPRINTS } from "../server/toolchains/manifest.js";
import {
  buildToolchainSourceProvenance,
  TOOLCHAIN_RELEASE_SOURCES,
  TOOLCHAIN_SOURCE_PROVENANCE_FILENAME,
} from "./toolchain-release-sources.js";

function canonicalCreatedAt(configured?: string): string {
  const created = configured
    || process.env.TOOLCHAIN_MANIFEST_GENERATED_AT
    || (process.env.SOURCE_DATE_EPOCH
      ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString()
      : new Date().toISOString());
  if (
    !Number.isFinite(Date.parse(created))
    || new Date(created).toISOString() !== created
  ) {
    throw new Error("Package metadata timestamp must be a canonical ISO timestamp.");
  }
  return created;
}

export function writeToolchainPackageMetadata(
  configuredRoot: string,
  packageId: string,
  options: { createdAt?: string } = {},
): void {
  const packageRoot = path.resolve(configuredRoot);
  const blueprint = TOOLCHAIN_RELEASE_BLUEPRINTS[packageId];
  const source = TOOLCHAIN_RELEASE_SOURCES[packageId];
  if (!configuredRoot || !blueprint || !source) {
    throw new Error(
      "Unknown toolchain package. Expected a package root and a catalog package ID.",
    );
  }
  if (!fs.statSync(packageRoot, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Package root does not exist: ${packageRoot}`);
  }
  const created = canonicalCreatedAt(options.createdAt);

  for (const relativePath of blueprint.license.licenseFiles) {
    if (
      !fs.statSync(
        path.join(packageRoot, ...relativePath.split("/")),
        { throwIfNoEntry: false },
      )?.isFile()
    ) {
      throw new Error(`Required upstream license is missing: ${relativePath}`);
    }
  }

  const provenance = buildToolchainSourceProvenance(packageId, created);
  fs.writeFileSync(
    path.join(packageRoot, TOOLCHAIN_SOURCE_PROVENANCE_FILENAME),
    `${JSON.stringify(provenance, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );

  const noticePath = path.join(packageRoot, "THIRD-PARTY-NOTICES.txt");
  if (!blueprint.license.noticeFiles.includes("THIRD-PARTY-NOTICES.txt")) {
    throw new Error(`Package '${packageId}' has no standard notice declaration.`);
  }
  fs.writeFileSync(
    noticePath,
    [
      `JudgeDesk managed toolchain: ${blueprint.id} ${blueprint.version}`,
      `Upstream: ${blueprint.upstreamUrl}`,
      `Declared license: ${blueprint.license.spdxExpression}`,
      "",
      "This package was assembled from checksum-pinned upstream release inputs.",
      `Packaging: ${source.packagingDescription}`,
      `Exact URLs and checksums: ${TOOLCHAIN_SOURCE_PROVENANCE_FILENAME}`,
      "See the license and upstream notice files shipped beside this document for terms.",
      "",
    ].join("\n"),
    { encoding: "utf8", flag: "wx" },
  );

  const sbomPath = path.join(
    packageRoot,
    ...blueprint.license.sbomPath.split("/"),
  );
  const sbom = {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `${blueprint.id}-${blueprint.version}`,
    documentNamespace:
      `https://github.com/ducminh25/judgedesk/sbom/${blueprint.id}/${blueprint.version}`,
    creationInfo: {
      created,
      creators: ["Organization: JudgeDesk"],
    },
    packages: [
      {
        SPDXID: "SPDXRef-Package",
        name: blueprint.id,
        versionInfo: blueprint.version,
        downloadLocation: blueprint.upstreamUrl,
        filesAnalyzed: false,
        licenseConcluded: blueprint.license.spdxExpression,
        licenseDeclared: blueprint.license.spdxExpression,
        copyrightText: "NOASSERTION",
        externalRefs: provenance.inputs.map((input) => ({
          referenceCategory: "OTHER",
          referenceType: "judgedesk-upstream-source",
          referenceLocator:
            `${input.url}#sha256=${input.sha256}`,
        })),
      },
    ],
    relationships: [
      {
        spdxElementId: "SPDXRef-DOCUMENT",
        relationshipType: "DESCRIBES",
        relatedSpdxElement: "SPDXRef-Package",
      },
    ],
  };
  fs.writeFileSync(
    sbomPath,
    `${JSON.stringify(sbom, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const packageRoot = process.argv[2] || "";
  const packageId = process.argv[3] || "";
  if (!packageRoot || !packageId) {
    throw new Error(
      "Usage: npx tsx scripts/write-toolchain-package-metadata.ts <package-root> <package-id>",
    );
  }
  writeToolchainPackageMetadata(packageRoot, packageId);
  console.log(`Wrote release notice, provenance and SPDX SBOM for ${packageId}.`);
}
