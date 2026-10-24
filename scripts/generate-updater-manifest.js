import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { optionalLinuxReleaseAssets } from "./verify-public-release-assets.js";

export function generateUpdaterManifest({
  assetsDirectory,
  repository,
  tag,
  publicationDate = new Date(),
}) {
  if (!repository || !tag) throw new Error("repository and tag are required");
  const files = fs.readdirSync(assetsDirectory);
  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid updater tag: ${tag}`);
  }
  const releaseUrl = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}`;
  const platform = ({ edition, platform, arch, fileName }) => {
    requireArtifact(files, fileName, `${platform} ${edition} updater bundle`);
    const signatureFile = `${fileName}.sig`;
    requireArtifact(files, signatureFile, `${platform} ${edition} updater signature`);
    const metadataFile = `${fileName}.metadata.json`;
    requireArtifact(files, metadataFile, `${platform} ${edition} size metadata`);
    const metadata = readBundleMetadata(
      path.join(assetsDirectory, metadataFile),
      { edition, platform, arch },
    );
    return {
      signature: fs
        .readFileSync(path.join(assetsDirectory, signatureFile), "utf8")
        .trim(),
      url: `${releaseUrl}/${encodeURIComponent(fileName)}`,
      judgedesk: {
        edition,
        downloadSizeBytes: fs.statSync(path.join(assetsDirectory, fileName)).size,
        installedSizeBytes: metadata.installedSizeBytes,
      },
    };
  };
  const manifest = {
    version,
    notes: `JudgeDesk ${tag}. See the GitHub release notes for details.`,
    pub_date: publicationDate.toISOString(),
    platforms: {
      "windows-x86_64-core": platform({
        edition: "core",
        platform: "windows",
        arch: "x86_64",
        fileName: `JudgeDesk_${version}_core_x64_en-US.msi`,
      }),
      "windows-x86_64-full": platform({
        edition: "full",
        platform: "windows",
        arch: "x86_64",
        fileName: `JudgeDesk_${version}_full_x64_en-US.msi`,
      }),
      "darwin-aarch64-core": platform({
        edition: "core",
        platform: "darwin",
        arch: "aarch64",
        fileName: `JudgeDesk_${version}_core_aarch64.app.tar.gz`,
      }),
      "darwin-aarch64-full": platform({
        edition: "full",
        platform: "darwin",
        arch: "aarch64",
        fileName: `JudgeDesk_${version}_full_aarch64.app.tar.gz`,
      }),
    },
  };
  const optionalLinuxPlatforms = optionalLinuxReleaseAssets(tag).map((variant) => ({
    targets: variant.platforms,
    edition: variant.edition,
    platform: "linux",
    arch: "x86_64",
    fileName: variant.filename,
  }));
  for (const linuxVariant of optionalLinuxPlatforms) {
    if (files.includes(linuxVariant.fileName)) {
      const entry = platform(linuxVariant);
      for (const target of linuxVariant.targets) {
        manifest.platforms[target] = entry;
      }
    }
  }
  const outputPath = path.join(assetsDirectory, "latest.json");
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { manifest, outputPath };
}

function readBundleMetadata(filePath, expected) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`Invalid updater size metadata '${path.basename(filePath)}': ${error.message}`);
  }
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || value.schemaVersion !== 1
    || value.edition !== expected.edition
    || value.platform !== expected.platform
    || value.arch !== expected.arch
    || !Number.isSafeInteger(value.installedSizeBytes)
    || value.installedSizeBytes <= 0
  ) {
    throw new Error(
      `Updater size metadata '${path.basename(filePath)}' does not match ${expected.platform}/${expected.arch}/${expected.edition}`,
    );
  }
  return value;
}

function requireArtifact(files, filename, label) {
  if (!files.includes(filename)) {
    throw new Error(`Missing exact ${label}: ${filename}`);
  }
  return filename;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  generateUpdaterManifest({
    assetsDirectory: path.resolve(process.argv[2] || "release-assets"),
    repository: process.env.PUBLIC_RELEASE_REPOSITORY,
    tag: process.env.GITHUB_REF_NAME,
  });
}
