import fs from "node:fs";
import path from "node:path";
import { TOOLCHAIN_RELEASE_BLUEPRINTS } from "../server/toolchains/manifest.js";

const packageRoot = path.resolve(process.argv[2] || "");
const packageId = process.argv[3] || "";
const created = process.env.TOOLCHAIN_MANIFEST_GENERATED_AT
  || (process.env.SOURCE_DATE_EPOCH
    ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString()
    : new Date().toISOString());
const blueprint = TOOLCHAIN_RELEASE_BLUEPRINTS[packageId];
if (!packageRoot || !blueprint) {
  throw new Error(
    "Usage: npx tsx scripts/write-toolchain-package-metadata.ts <package-root> <package-id>",
  );
}
if (!fs.statSync(packageRoot, { throwIfNoEntry: false })?.isDirectory()) {
  throw new Error(`Package root does not exist: ${packageRoot}`);
}
if (!Number.isFinite(Date.parse(created)) || new Date(created).toISOString() !== created) {
  throw new Error("Package metadata timestamp must be a canonical ISO timestamp.");
}

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
    "This package redistributes an unmodified upstream binary distribution.",
    "See the license and notice files shipped beside this document for terms.",
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
console.log(`Wrote release notice and SPDX SBOM for ${packageId}.`);
