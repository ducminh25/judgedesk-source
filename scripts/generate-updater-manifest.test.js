import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generateUpdaterManifest } from "./generate-updater-manifest.js";

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
