import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function expectedPublicReleaseAssets(tag) {
  const version = tag?.startsWith("v") ? tag.slice(1) : tag;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version || "")) {
    throw new Error(`Invalid release tag: ${tag}`);
  }

  return [
    `JudgeDesk_${version}_core_aarch64.app.tar.gz`,
    `JudgeDesk_${version}_core_aarch64.dmg`,
    `JudgeDesk_${version}_core_x64_en-US.msi`,
    `JudgeDesk_${version}_full_aarch64.app.tar.gz`,
    `JudgeDesk_${version}_full_aarch64.dmg`,
    `JudgeDesk_${version}_full_x64_en-US.msi`,
    "SHA256SUMS",
    "latest.json",
  ].sort();
}

export function optionalLinuxReleaseAssets(tag) {
  const version = tag?.startsWith("v") ? tag.slice(1) : tag;
  return ["core", "full"].flatMap((edition) => [
    {
      platform: `linux-x86_64-deb-${edition}`,
      platforms: [`linux-x86_64-deb-${edition}`, `linux-x86_64-${edition}`],
      filename: `JudgeDesk_${version}_${edition === "full" ? "full_" : ""}amd64.deb`,
      edition,
    },
    {
      platform: `linux-x86_64-rpm-${edition}`,
      platforms: [`linux-x86_64-rpm-${edition}`],
      filename: `JudgeDesk-${version}-${edition === "full" ? "full-" : ""}1.x86_64.rpm`,
      edition,
    },
    {
      platform: `linux-x86_64-appimage-${edition}`,
      platforms: [`linux-x86_64-appimage-${edition}`],
      filename: `JudgeDesk_${version}_${edition === "full" ? "full_" : ""}amd64.AppImage`,
      edition,
    },
  ]);
}

export function verifyPublicReleaseAssets({ assetsDirectory, tag }) {
  const required = expectedPublicReleaseAssets(tag);
  const optionalLinux = optionalLinuxReleaseAssets(tag);
  const entries = fs.readdirSync(assetsDirectory, { withFileTypes: true });
  const nonFiles = entries.filter((entry) => !entry.isFile()).map((entry) => entry.name);
  if (nonFiles.length > 0) {
    throw new Error(`Public release directory contains non-files: ${nonFiles.join(", ")}`);
  }

  const actual = entries.map((entry) => entry.name).sort();
  const presentOptionalLinux = optionalLinux.filter((item) => actual.includes(item.filename));
  const expected = [...required, ...presentOptionalLinux.map((item) => item.filename)].sort();
  const missing = required.filter((name) => !actual.includes(name));
  const unexpected = actual.filter((name) => !expected.includes(name));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error([
      missing.length > 0 ? `Missing public release assets: ${missing.join(", ")}` : "",
      unexpected.length > 0 ? `Unexpected public release assets: ${unexpected.join(", ")}` : "",
    ].filter(Boolean).join("; "));
  }

  for (const filename of expected) {
    const filePath = path.join(assetsDirectory, filename);
    if (fs.statSync(filePath).size === 0) {
      throw new Error(`Empty public release asset: ${filename}`);
    }
  }

  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  const manifest = JSON.parse(fs.readFileSync(path.join(assetsDirectory, "latest.json"), "utf8"));
  if (manifest.version !== version) {
    throw new Error(`latest.json version mismatch: expected ${version}, got ${manifest.version}`);
  }
  verifyManifestPlatform(
    manifest,
    "windows-x86_64-core",
    `JudgeDesk_${version}_core_x64_en-US.msi`,
    "core",
    assetsDirectory,
    tag,
  );
  verifyManifestPlatform(
    manifest,
    "windows-x86_64-full",
    `JudgeDesk_${version}_full_x64_en-US.msi`,
    "full",
    assetsDirectory,
    tag,
  );
  verifyManifestPlatform(
    manifest,
    "darwin-aarch64-core",
    `JudgeDesk_${version}_core_aarch64.app.tar.gz`,
    "core",
    assetsDirectory,
    tag,
  );
  verifyManifestPlatform(
    manifest,
    "darwin-aarch64-full",
    `JudgeDesk_${version}_full_aarch64.app.tar.gz`,
    "full",
    assetsDirectory,
    tag,
  );
  for (const item of presentOptionalLinux) {
    for (const targetPlatform of item.platforms || [item.platform]) {
      verifyManifestPlatform(
        manifest,
        targetPlatform,
        item.filename,
        item.edition,
        assetsDirectory,
        tag,
      );
    }
  }
  const expectedPlatforms = [
    "darwin-aarch64-core",
    "darwin-aarch64-full",
    "windows-x86_64-core",
    "windows-x86_64-full",
    ...presentOptionalLinux.flatMap((item) => item.platforms || [item.platform]),
  ].sort();
  const platformNames = Object.keys(manifest.platforms || {}).sort();
  if (platformNames.join(",") !== expectedPlatforms.join(",")) {
    throw new Error(`latest.json has unexpected platforms: ${platformNames.join(", ")}`);
  }

  const checksumTargets = expected.filter((name) => name !== "SHA256SUMS").sort();
  const checksums = parseChecksums(
    fs.readFileSync(path.join(assetsDirectory, "SHA256SUMS"), "utf8"),
  );
  const checksumNames = [...checksums.keys()].sort();
  if (checksumNames.join("\n") !== checksumTargets.join("\n")) {
    throw new Error(
      `SHA256SUMS must cover exactly the public assets other than itself; got: ${checksumNames.join(", ")}`,
    );
  }
  for (const filename of checksumTargets) {
    const actualHash = sha256(path.join(assetsDirectory, filename));
    if (checksums.get(filename) !== actualHash) {
      throw new Error(`SHA-256 mismatch for ${filename}`);
    }
  }

  return { assets: expected, checksumTargets };
}

function verifyManifestPlatform(
  manifest,
  platform,
  expectedFilename,
  expectedEdition,
  assetsDirectory,
  tag,
) {
  const entry = manifest.platforms?.[platform];
  if (!entry || typeof entry.signature !== "string" || entry.signature.trim() === "") {
    throw new Error(`latest.json is missing an embedded signature for ${platform}`);
  }
  let url;
  try {
    url = new URL(entry.url);
  } catch {
    throw new Error(`latest.json has an invalid URL for ${platform}`);
  }
  const expectedSuffix = `/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(expectedFilename)}`;
  if (!url.pathname.endsWith(expectedSuffix)) {
    throw new Error(`latest.json must select ${expectedFilename} for ${platform}`);
  }
  if (
    entry.judgedesk?.edition !== expectedEdition
    || !Number.isSafeInteger(entry.judgedesk?.downloadSizeBytes)
    || entry.judgedesk.downloadSizeBytes !== fs.statSync(
      path.join(assetsDirectory, expectedFilename),
    ).size
    || !Number.isSafeInteger(entry.judgedesk?.installedSizeBytes)
    || entry.judgedesk.installedSizeBytes <= 0
  ) {
    throw new Error(`latest.json has invalid JudgeDesk metadata for ${platform}`);
  }
}

function parseChecksums(contents) {
  const checksums = new Map();
  for (const line of contents.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const match = /^([0-9a-fA-F]{64}) [ *](?:\.\/)?([^/\\]+)$/.exec(line);
    if (!match) throw new Error(`Invalid SHA256SUMS line: ${line}`);
    const [, hash, filename] = match;
    if (checksums.has(filename)) throw new Error(`Duplicate SHA256SUMS entry: ${filename}`);
    checksums.set(filename, hash.toLowerCase());
  }
  return checksums;
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const assetsDirectory = path.resolve(process.argv[2] || "public-release-assets");
  const tag = process.argv[3] || process.env.GITHUB_REF_NAME;
  const result = verifyPublicReleaseAssets({ assetsDirectory, tag });
  console.log(`Verified ${result.assets.length} public release assets for ${tag}.`);
}
