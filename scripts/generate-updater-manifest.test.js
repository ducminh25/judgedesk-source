import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generateUpdaterManifest } from "./generate-updater-manifest.js";
import {
  expectedPublicReleaseAssets,
  verifyPublicReleaseAssets,
} from "./verify-public-release-assets.js";

test("updater manifest maps only the signed Full bundles when Core artifacts coexist", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "themis-updater-manifest-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "JudgeDesk_1.3.0_core_x64_en-US.msi"), "core-msi");
  fs.writeFileSync(path.join(root, "JudgeDesk_1.3.0_full_x64_en-US.msi"), "full-msi");
  fs.writeFileSync(path.join(root, "JudgeDesk_1.3.0_full_x64_en-US.msi.sig"), "windows-signature\n");
  fs.writeFileSync(path.join(root, "JudgeDesk_1.3.0_core_aarch64.dmg"), "core-dmg");
  fs.writeFileSync(path.join(root, "JudgeDesk_1.3.0_full_aarch64.dmg"), "full-dmg");
  fs.writeFileSync(path.join(root, "JudgeDesk_1.3.0_full_aarch64.app.tar.gz"), "full-mac");
  fs.writeFileSync(path.join(root, "JudgeDesk_1.3.0_full_aarch64.app.tar.gz.sig"), "mac-signature\n");

  const { manifest, outputPath } = generateUpdaterManifest({
    assetsDirectory: root,
    repository: "owner/repository",
    tag: "v1.3.0",
    publicationDate: new Date("2026-08-01T00:00:00.000Z"),
  });

  assert.equal(manifest.version, "1.3.0");
  assert.equal(manifest.platforms["windows-x86_64"].signature, "windows-signature");
  assert.ok(manifest.platforms["windows-x86_64"].url.endsWith("JudgeDesk_1.3.0_full_x64_en-US.msi"));
  assert.equal(manifest.platforms["darwin-x86_64"], undefined);
  assert.ok(manifest.platforms["darwin-aarch64"].url.endsWith("JudgeDesk_1.3.0_full_aarch64.app.tar.gz"));
  assert.equal(JSON.parse(fs.readFileSync(outputPath, "utf8")).version, "1.3.0");
});

test("updater manifest rejects stale-version and wrong-architecture Full bundles", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "themis-updater-mismatch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const filename of [
    "JudgeDesk_1.2.7_full_x64_en-US.msi",
    "JudgeDesk_1.2.7_full_x64_en-US.msi.sig",
    "JudgeDesk_1.3.0_full_x86_en-US.msi",
    "JudgeDesk_1.3.0_full_x86_en-US.msi.sig",
    "JudgeDesk_1.3.0_full_x86_64.app.tar.gz",
    "JudgeDesk_1.3.0_full_x86_64.app.tar.gz.sig",
  ]) {
    fs.writeFileSync(path.join(root, filename), "mismatch");
  }

  assert.throws(
    () => generateUpdaterManifest({
      assetsDirectory: root,
      repository: "owner/repository",
      tag: "v1.3.0",
    }),
    /Missing exact Windows Full updater MSI: JudgeDesk_1\.3\.0_full_x64_en-US\.msi/,
  );

  fs.writeFileSync(path.join(root, "JudgeDesk_1.3.0_full_x64_en-US.msi"), "windows");
  fs.writeFileSync(path.join(root, "JudgeDesk_1.3.0_full_x64_en-US.msi.sig"), "signature");
  assert.throws(
    () => generateUpdaterManifest({
      assetsDirectory: root,
      repository: "owner/repository",
      tag: "v1.3.0",
    }),
    /Missing exact macOS Full updater bundle: JudgeDesk_1\.3\.0_full_aarch64\.app\.tar\.gz/,
  );
});

function createPublicAssets(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-public-assets-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tag = "v1.3.2";
  const version = tag.slice(1);
  const windowsBundle = `JudgeDesk_${version}_full_x64_en-US.msi`;
  const macBundle = `JudgeDesk_${version}_full_aarch64.app.tar.gz`;
  const manifest = {
    version,
    platforms: {
      "windows-x86_64": {
        signature: "windows-signature",
        url: `https://github.com/ducminh25/judgedesk/releases/download/${tag}/${windowsBundle}`,
      },
      "darwin-aarch64": {
        signature: "mac-signature",
        url: `https://github.com/ducminh25/judgedesk/releases/download/${tag}/${macBundle}`,
      },
    },
  };

  for (const filename of expectedPublicReleaseAssets(tag)) {
    if (filename === "SHA256SUMS") continue;
    const contents = filename === "latest.json"
      ? `${JSON.stringify(manifest, null, 2)}\n`
      : `fixture:${filename}`;
    fs.writeFileSync(path.join(root, filename), contents);
  }
  const checksumTargets = expectedPublicReleaseAssets(tag)
    .filter((filename) => filename !== "SHA256SUMS")
    .sort();
  const checksumLines = checksumTargets.map((filename) => {
    const hash = crypto
      .createHash("sha256")
      .update(fs.readFileSync(path.join(root, filename)))
      .digest("hex");
    return `${hash}  ${filename}`;
  });
  fs.writeFileSync(path.join(root, "SHA256SUMS"), `${checksumLines.join("\n")}\n`);
  return { root, tag };
}

test("public release allowlist keeps the macOS updater archive but excludes standalone signatures", (t) => {
  const { root, tag } = createPublicAssets(t);
  const result = verifyPublicReleaseAssets({ assetsDirectory: root, tag });

  assert.equal(result.assets.length, 7);
  assert.ok(result.assets.includes("JudgeDesk_1.3.2_full_aarch64.app.tar.gz"));
  assert.ok(result.assets.every((filename) => !filename.endsWith(".sig")));
});

test("public release allowlist rejects a standalone signature", (t) => {
  const { root, tag } = createPublicAssets(t);
  fs.writeFileSync(path.join(root, "JudgeDesk_1.3.2_full_x64_en-US.msi.sig"), "signature");

  assert.throws(
    () => verifyPublicReleaseAssets({ assetsDirectory: root, tag }),
    /Unexpected public release assets: JudgeDesk_1\.3\.2_full_x64_en-US\.msi\.sig/,
  );
});

test("public release allowlist rejects a missing updater archive and checksum drift", (t) => {
  const { root, tag } = createPublicAssets(t);
  fs.rmSync(path.join(root, "JudgeDesk_1.3.2_full_aarch64.app.tar.gz"));
  assert.throws(
    () => verifyPublicReleaseAssets({ assetsDirectory: root, tag }),
    /Missing public release assets: JudgeDesk_1\.3\.2_full_aarch64\.app\.tar\.gz/,
  );

  const restored = createPublicAssets(t);
  fs.appendFileSync(path.join(restored.root, "latest.json"), " ");
  assert.throws(
    () => verifyPublicReleaseAssets({ assetsDirectory: restored.root, tag: restored.tag }),
    /SHA-256 mismatch for latest\.json/,
  );
});
