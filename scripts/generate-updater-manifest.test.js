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

const VARIANTS = [
  {
    target: "windows-x86_64-core",
    edition: "core",
    platform: "windows",
    arch: "x86_64",
    filename: "JudgeDesk_1.3.4_core_x64_en-US.msi",
  },
  {
    target: "windows-x86_64-full",
    edition: "full",
    platform: "windows",
    arch: "x86_64",
    filename: "JudgeDesk_1.3.4_full_x64_en-US.msi",
  },
  {
    target: "darwin-aarch64-core",
    edition: "core",
    platform: "darwin",
    arch: "aarch64",
    filename: "JudgeDesk_1.3.4_core_aarch64.app.tar.gz",
  },
  {
    target: "darwin-aarch64-full",
    edition: "full",
    platform: "darwin",
    arch: "aarch64",
    filename: "JudgeDesk_1.3.4_full_aarch64.app.tar.gz",
  },
];

function createStaging(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-updater-manifest-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [index, variant] of VARIANTS.entries()) {
    fs.writeFileSync(path.join(root, variant.filename), `bundle:${variant.target}`);
    fs.writeFileSync(path.join(root, `${variant.filename}.sig`), `signature:${variant.target}\n`);
    fs.writeFileSync(path.join(root, `${variant.filename}.metadata.json`), JSON.stringify({
      schemaVersion: 1,
      edition: variant.edition,
      platform: variant.platform,
      arch: variant.arch,
      installedSizeBytes: 100_000 + index,
    }));
  }
  for (const edition of ["core", "full"]) {
    fs.writeFileSync(path.join(root, `JudgeDesk_1.3.4_${edition}_aarch64.dmg`), `dmg:${edition}`);
  }
  return root;
}

test("updater manifest maps signed Core and Full bundles with exact size metadata", (t) => {
  const root = createStaging(t);
  const { manifest, outputPath } = generateUpdaterManifest({
    assetsDirectory: root,
    repository: "owner/repository",
    tag: "v1.3.4",
    publicationDate: new Date("2026-08-13T00:00:00.000Z"),
  });

  assert.equal(manifest.version, "1.3.4");
  assert.deepEqual(Object.keys(manifest.platforms).sort(), VARIANTS.map(({ target }) => target).sort());
  for (const variant of VARIANTS) {
    const entry = manifest.platforms[variant.target];
    assert.equal(entry.signature, `signature:${variant.target}`);
    assert.ok(entry.url.endsWith(variant.filename));
    assert.deepEqual(entry.judgedesk, {
      edition: variant.edition,
      downloadSizeBytes: fs.statSync(path.join(root, variant.filename)).size,
      installedSizeBytes: 100_000 + VARIANTS.indexOf(variant),
    });
  }
  assert.equal(JSON.parse(fs.readFileSync(outputPath, "utf8")).version, "1.3.4");
});

test("updater manifest isolates Linux deb, rpm, and AppImage targets so installers never cross-update", (t) => {
  const root = createStaging(t);
  const linuxBundles = [
    {
      filename: "JudgeDesk_1.3.4_amd64.deb",
      installedSizeBytes: 155_000_000,
    },
    {
      filename: "JudgeDesk-1.3.4-1.x86_64.rpm",
      installedSizeBytes: 156_000_000,
    },
    {
      filename: "JudgeDesk_1.3.4_amd64.AppImage",
      installedSizeBytes: 120_000_000,
    },
  ];
  for (const bundle of linuxBundles) {
    fs.writeFileSync(path.join(root, bundle.filename), `linux-payload:${bundle.filename}`);
    fs.writeFileSync(path.join(root, `${bundle.filename}.sig`), `sig:${bundle.filename}\n`);
    fs.writeFileSync(path.join(root, `${bundle.filename}.metadata.json`), JSON.stringify({
      schemaVersion: 1,
      edition: "core",
      platform: "linux",
      arch: "x86_64",
      installedSizeBytes: bundle.installedSizeBytes,
    }));
  }

  const { manifest } = generateUpdaterManifest({
    assetsDirectory: root,
    repository: "owner/repository",
    tag: "v1.3.4",
    publicationDate: new Date("2026-08-13T00:00:00.000Z"),
  });

  assert.ok(manifest.platforms["linux-x86_64-deb-core"].url.endsWith("JudgeDesk_1.3.4_amd64.deb"));
  assert.ok(manifest.platforms["linux-x86_64-core"].url.endsWith("JudgeDesk_1.3.4_amd64.deb"));
  assert.ok(manifest.platforms["linux-x86_64-rpm-core"].url.endsWith("JudgeDesk-1.3.4-1.x86_64.rpm"));
  assert.ok(manifest.platforms["linux-x86_64-appimage-core"].url.endsWith("JudgeDesk_1.3.4_amd64.AppImage"));

  const publicRoot = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-public-linux-"));
  t.after(() => fs.rmSync(publicRoot, { recursive: true, force: true }));
  const publicFiles = [
    ...expectedPublicReleaseAssets("v1.3.4").filter((name) => name !== "SHA256SUMS"),
    ...linuxBundles.map((b) => b.filename),
  ].sort();
  for (const filename of publicFiles) {
    fs.copyFileSync(path.join(root, filename), path.join(publicRoot, filename));
  }
  const checksumLines = publicFiles.map((filename) => {
    const hash = crypto.createHash("sha256")
      .update(fs.readFileSync(path.join(publicRoot, filename)))
      .digest("hex");
    return `${hash}  ${filename}`;
  });
  fs.writeFileSync(path.join(publicRoot, "SHA256SUMS"), `${checksumLines.join("\n")}\n`);

  const verified = verifyPublicReleaseAssets({ assetsDirectory: publicRoot, tag: "v1.3.4" });
  assert.equal(verified.assets.length, 11);
});

test("updater manifest rejects a missing edition bundle and mismatched metadata", (t) => {
  const root = createStaging(t);
  fs.rmSync(path.join(root, VARIANTS[0].filename));
  assert.throws(
    () => generateUpdaterManifest({ assetsDirectory: root, repository: "owner/repository", tag: "v1.3.4" }),
    /Missing exact windows core updater bundle/,
  );

  fs.writeFileSync(path.join(root, VARIANTS[0].filename), "restored");
  fs.writeFileSync(path.join(root, `${VARIANTS[0].filename}.metadata.json`), JSON.stringify({
    schemaVersion: 1,
    edition: "full",
    platform: "windows",
    arch: "x86_64",
    installedSizeBytes: 100,
  }));
  assert.throws(
    () => generateUpdaterManifest({ assetsDirectory: root, repository: "owner/repository", tag: "v1.3.4" }),
    /does not match windows\/x86_64\/core/,
  );
});

function createPublicAssets(t) {
  const staging = createStaging(t);
  const tag = "v1.3.4";
  generateUpdaterManifest({
    assetsDirectory: staging,
    repository: "ducminh25/judgedesk",
    tag,
    publicationDate: new Date("2026-08-13T00:00:00.000Z"),
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-public-assets-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const filename of expectedPublicReleaseAssets(tag)) {
    if (filename === "SHA256SUMS") continue;
    fs.copyFileSync(path.join(staging, filename), path.join(root, filename));
  }
  const checksumTargets = expectedPublicReleaseAssets(tag)
    .filter((filename) => filename !== "SHA256SUMS")
    .sort();
  const checksumLines = checksumTargets.map((filename) => {
    const hash = crypto.createHash("sha256")
      .update(fs.readFileSync(path.join(root, filename)))
      .digest("hex");
    return `${hash}  ${filename}`;
  });
  fs.writeFileSync(path.join(root, "SHA256SUMS"), `${checksumLines.join("\n")}\n`);
  return { root, tag };
}

test("public release requires both updater editions but excludes standalone signatures and metadata", (t) => {
  const { root, tag } = createPublicAssets(t);
  const result = verifyPublicReleaseAssets({ assetsDirectory: root, tag });
  assert.equal(result.assets.length, 8);
  assert.ok(result.assets.includes("JudgeDesk_1.3.4_core_aarch64.app.tar.gz"));
  assert.ok(result.assets.includes("JudgeDesk_1.3.4_full_aarch64.app.tar.gz"));
  assert.ok(result.assets.every((filename) => !filename.endsWith(".sig")));
  assert.ok(result.assets.every((filename) => !filename.endsWith(".metadata.json")));
});

test("public release gate rejects signatures, missing variants, and size drift", (t) => {
  const first = createPublicAssets(t);
  fs.writeFileSync(path.join(first.root, "JudgeDesk_1.3.4_full_x64_en-US.msi.sig"), "signature");
  assert.throws(
    () => verifyPublicReleaseAssets({ assetsDirectory: first.root, tag: first.tag }),
    /Unexpected public release assets/,
  );

  const second = createPublicAssets(t);
  fs.rmSync(path.join(second.root, "JudgeDesk_1.3.4_core_aarch64.app.tar.gz"));
  assert.throws(
    () => verifyPublicReleaseAssets({ assetsDirectory: second.root, tag: second.tag }),
    /Missing public release assets/,
  );

  const third = createPublicAssets(t);
  const manifestPath = path.join(third.root, "latest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.platforms["windows-x86_64-core"].judgedesk.downloadSizeBytes += 1;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(
    () => verifyPublicReleaseAssets({ assetsDirectory: third.root, tag: third.tag }),
    /invalid JudgeDesk metadata/,
  );
});
