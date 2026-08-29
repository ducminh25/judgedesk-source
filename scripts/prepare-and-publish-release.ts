import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { generateUpdaterManifest } from "./generate-updater-manifest.js";

const REPO = "ducminh25/judgedesk";
const TAG = "v1.4.43";
const VERSION = "1.4.43";

async function main() {
  const stagingDir = path.resolve("release-staging");
  const winDir = path.join(stagingDir, "release-assets-windows");
  const macDir = path.join(stagingDir, "release-assets-mac");

  // Flatten files into stagingDir
  if (fs.existsSync(winDir)) {
    for (const f of fs.readdirSync(winDir)) {
      fs.copyFileSync(path.join(winDir, f), path.join(stagingDir, f));
    }
  }
  if (fs.existsSync(macDir)) {
    for (const f of fs.readdirSync(macDir)) {
      fs.copyFileSync(path.join(macDir, f), path.join(stagingDir, f));
    }
  }

  console.log("Generating latest.json updater manifest...");
  generateUpdaterManifest({
    assetsDirectory: stagingDir,
    repository: REPO,
    tag: TAG,
  });

  const publicDir = path.resolve("public-release-assets");
  if (fs.existsSync(publicDir)) {
    fs.rmSync(publicDir, { recursive: true, force: true });
  }
  fs.mkdirSync(publicDir, { recursive: true });

  const publicFiles = [
    `JudgeDesk_${VERSION}_core_aarch64.app.tar.gz`,
    `JudgeDesk_${VERSION}_core_aarch64.dmg`,
    `JudgeDesk_${VERSION}_core_x64_en-US.msi`,
    `JudgeDesk_${VERSION}_full_aarch64.app.tar.gz`,
    `JudgeDesk_${VERSION}_full_aarch64.dmg`,
    `JudgeDesk_${VERSION}_full_x64_en-US.msi`,
    "latest.json",
  ];

  for (const file of publicFiles) {
    fs.copyFileSync(path.join(stagingDir, file), path.join(publicDir, file));
  }

  function sha256(file: string) {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  }

  const checksumLines = publicFiles.map((file) => {
    const hash = sha256(path.join(publicDir, file));
    return `${hash}  ${file}`;
  });

  fs.writeFileSync(path.join(publicDir, "SHA256SUMS"), `${checksumLines.join("\n")}\n`, "utf8");

  console.log("8 public release assets ready:");
  const finalAssets = fs.readdirSync(publicDir);
  console.log(finalAssets);

  // Extract changelog for v1.4.43
  const changelog = fs.readFileSync("CHANGELOG.md", "utf8");
  const startIdx = changelog.indexOf(`## [${VERSION}]`);
  const endIdx = changelog.indexOf(`## [`, startIdx + 1);
  const releaseNotes = startIdx !== -1
    ? (endIdx !== -1 ? changelog.slice(startIdx, endIdx) : changelog.slice(startIdx)).trim()
    : `JudgeDesk ${TAG} release.`;

  const notesFile = path.join(stagingDir, "RELEASE_NOTES.md");
  fs.writeFileSync(notesFile, releaseNotes, "utf8");

  console.log("Creating public release on GitHub...");
  const assetPaths = finalAssets.map((f) => path.join(publicDir, f));

  execFileSync(
    "gh",
    [
      "release",
      "create",
      TAG,
      ...assetPaths,
      "--repo",
      REPO,
      "--title",
      `JudgeDesk ${TAG}`,
      "--notes-file",
      notesFile,
    ],
    { stdio: "inherit" },
  );

  console.log("Deleting staging release on GitHub...");
  try {
    execFileSync(
      "gh",
      ["release", "delete", `${TAG}-staging`, "--repo", REPO, "--yes", "--cleanup-tag"],
      { stdio: "inherit" },
    );
  } catch (e) {
    console.warn("Could not delete staging release:", e);
  }

  console.log("Cleaning up local staging and build artifacts...");
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.rmSync(publicDir, { recursive: true, force: true });
  if (fs.existsSync("release-assets-windows")) {
    fs.rmSync("release-assets-windows", { recursive: true, force: true });
  }
  if (fs.existsSync("scripts/get-failed-build-log.ts")) {
    fs.unlinkSync("scripts/get-failed-build-log.ts");
  }
  if (fs.existsSync("scripts/resume-codemagic-download.ts")) {
    fs.unlinkSync("scripts/resume-codemagic-download.ts");
  }
  if (fs.existsSync("scripts/trigger-codemagic-builds.ts")) {
    fs.unlinkSync("scripts/trigger-codemagic-builds.ts");
  }
  if (fs.existsSync("scripts/get-codemagic-apps.ts")) {
    fs.unlinkSync("scripts/get-codemagic-apps.ts");
  }

  console.log("Release v1.4.43 published successfully and cleanup finished!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
