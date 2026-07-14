import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadPreferences,
  savePreferences,
  getToolchainsDir,
} from "./storage.js";
import { resolveToolchain } from "./resolver.js";

test("toolchain storage preferences are saved and loaded correctly", (t) => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "themis-storage-test-"),
  );
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  process.env.THEMIS_APP_DATA_DIR = tempDir;

  const initial = loadPreferences();
  assert.equal(initial.preferredSourceCpp, "system");

  savePreferences({
    preferredSourceCpp: "custom",
    customCppPath: "C:\\mock\\g++.exe",
    installedToolchains: ["gcc-windows-x64"],
  });

  const loaded = loadPreferences();
  assert.equal(loaded.preferredSourceCpp, "custom");
  assert.equal(loaded.customCppPath, "C:\\mock\\g++.exe");
  assert.deepEqual(loaded.installedToolchains, ["gcc-windows-x64"]);

  delete process.env.THEMIS_APP_DATA_DIR;
});

test("toolchainsDir resolves and creates directories", (t) => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "themis-storage-test-"),
  );
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  process.env.THEMIS_APP_DATA_DIR = tempDir;

  const toolchainsDir = getToolchainsDir();
  assert.ok(fs.existsSync(toolchainsDir));
  assert.ok(toolchainsDir.endsWith("toolchains"));

  delete process.env.THEMIS_APP_DATA_DIR;
});
