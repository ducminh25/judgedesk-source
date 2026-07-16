import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generateUpdaterManifest } from "./generate-updater-manifest.js";

test("updater manifest maps universal macOS and Windows signed bundles", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "themis-updater-manifest-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "ThemisV2_1.1.2_x64_en-US.msi"), "msi");
  fs.writeFileSync(path.join(root, "ThemisV2_1.1.2_x64_en-US.msi.sig"), "windows-signature\n");
  fs.writeFileSync(path.join(root, "ThemisV2.app.tar.gz"), "mac");
  fs.writeFileSync(path.join(root, "ThemisV2.app.tar.gz.sig"), "mac-signature\n");

  const { manifest, outputPath } = generateUpdaterManifest({
    assetsDirectory: root,
    repository: "owner/repository",
    tag: "v1.1.2",
    publicationDate: new Date("2026-07-16T00:00:00.000Z"),
  });

  assert.equal(manifest.version, "1.1.2");
  assert.equal(manifest.platforms["windows-x86_64"].signature, "windows-signature");
  assert.deepEqual(
    manifest.platforms["darwin-x86_64"],
    manifest.platforms["darwin-aarch64"],
  );
  assert.ok(manifest.platforms["darwin-aarch64"].url.endsWith("ThemisV2.app.tar.gz"));
  assert.equal(JSON.parse(fs.readFileSync(outputPath, "utf8")).version, "1.1.2");
});
