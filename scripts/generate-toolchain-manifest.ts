import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TOOLCHAIN_CATALOG } from "../server/toolchains/manifest.js";

const filenames: Record<string, string> = {
  "gcc-windows-x64": "themis-gcc-windows-x64-14.2.0.zip",
  "python-windows-x64": "themis-python-windows-x64-3.12.13.zip",
  "python-macos-x64": "themis-python-macos-x64-3.12.13.tar.gz",
  "python-macos-arm64": "themis-python-macos-arm64-3.12.13.tar.gz",
};

function sha256(filePath: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

const outputDirectory = path.resolve(process.argv[2] || "dist-toolchains");
const releaseBaseUrl = (
  process.env.TOOLCHAIN_RELEASE_BASE_URL ||
  "https://github.com/ducminh25/themis-v2-downloads/releases/download/toolchains-v1"
).replace(/\/$/, "");

const toolchains = TOOLCHAIN_CATALOG.map((entry) => {
  const filename = filenames[entry.id];
  if (!filename)
    throw new Error(`No release filename is configured for '${entry.id}'.`);
  const filePath = path.join(outputDirectory, filename);
  if (!fs.existsSync(filePath))
    throw new Error(`Missing toolchain artifact: ${filename}`);
  return {
    ...entry,
    downloadUrl: `${releaseBaseUrl}/${filename}`,
    sha256: sha256(filePath),
    sizeBytes: fs.statSync(filePath).size,
  };
});

const manifestPath = path.join(outputDirectory, "toolchains-manifest.json");
fs.writeFileSync(
  manifestPath,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      toolchains,
    },
    null,
    2,
  )}\n`,
);

const checksumFiles = [
  ...Object.values(filenames),
  path.basename(manifestPath),
].sort();
const checksums = checksumFiles
  .map(
    (filename) =>
      `${sha256(path.join(outputDirectory, filename))}  ${filename}`,
  )
  .join("\n");
fs.writeFileSync(path.join(outputDirectory, "SHA256SUMS"), `${checksums}\n`);

console.log(
  `Generated ${manifestPath} with ${toolchains.length} verified package entries.`,
);
