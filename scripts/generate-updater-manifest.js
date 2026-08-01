import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

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
  const windowsBundle = requireArtifact(
    files,
    `JudgeDesk_${version}_full_x64_en-US.msi`,
    "Windows Full updater MSI",
  );
  const macBundle = requireArtifact(
    files,
    `JudgeDesk_${version}_full_aarch64.app.tar.gz`,
    "macOS Full updater bundle",
  );
  const releaseUrl = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}`;
  const platform = (fileName) => ({
    signature: fs
      .readFileSync(path.join(assetsDirectory, `${fileName}.sig`), "utf8")
      .trim(),
    url: `${releaseUrl}/${encodeURIComponent(fileName)}`,
  });
  const manifest = {
    version,
    notes: `JudgeDesk ${tag}. See the GitHub release notes for details.`,
    pub_date: publicationDate.toISOString(),
    platforms: {
      "windows-x86_64": platform(windowsBundle),
      "darwin-aarch64": platform(macBundle),
    },
  };
  const outputPath = path.join(assetsDirectory, "latest.json");
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { manifest, outputPath };
}

function requireArtifact(files, filename, label) {
  if (!files.includes(filename)) {
    throw new Error(`Missing exact ${label}: ${filename}`);
  }
  const signature = `${filename}.sig`;
  if (!files.includes(signature)) throw new Error(`Missing updater signature: ${signature}`);
  return filename;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  generateUpdaterManifest({
    assetsDirectory: path.resolve(process.argv[2] || "release-assets"),
    repository: process.env.PUBLIC_RELEASE_REPOSITORY,
    tag: process.env.GITHUB_REF_NAME,
  });
}
