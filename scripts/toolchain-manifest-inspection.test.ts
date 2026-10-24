import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TOOLCHAIN_RELEASE_BLUEPRINTS } from "../server/toolchains/manifest.js";
import { inspectToolchainReleasePackage } from "./generate-toolchain-manifest.js";

test("package inspection is importable without signing credentials and rejects a damaged archive", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-release-inspection-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const blueprint = TOOLCHAIN_RELEASE_BLUEPRINTS["python-windows-x64"];
  fs.writeFileSync(path.join(root, blueprint.archiveFilename), "damaged archive");
  await assert.rejects(inspectToolchainReleasePackage(root, "https://example.invalid/toolchains", blueprint), /zip/i);
});
