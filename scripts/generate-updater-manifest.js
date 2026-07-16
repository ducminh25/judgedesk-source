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
  const windowsBundle = findOne(files, (name) => name.endsWith(".msi"));
  const macBundle = findOne(files, (name) => name.endsWith(".app.tar.gz"));
  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  const releaseUrl = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}`;
  const platform = (fileName) => ({
    signature: fs
      .readFileSync(path.join(assetsDirectory, `${fileName}.sig`), "utf8")
      .trim(),
    url: `${releaseUrl}/${encodeURIComponent(fileName)}`,
  });
  const manifest = {
    version,
    notes: `ThemisV2 ${tag}. See the GitHub release notes for details.`,
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

function findOne(files, predicate) {
  const matches = files.filter(predicate);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one matching updater bundle, found ${matches.length}`);
  }
  const signature = `${matches[0]}.sig`;
  if (!files.includes(signature)) throw new Error(`Missing updater signature: ${signature}`);
  return matches[0];
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  generateUpdaterManifest({
    assetsDirectory: path.resolve(process.argv[2] || "release-assets"),
    repository: process.env.PUBLIC_RELEASE_REPOSITORY,
    tag: process.env.GITHUB_REF_NAME,
  });
}
