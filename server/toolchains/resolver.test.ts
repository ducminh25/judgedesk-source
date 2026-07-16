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
import {
  compareVersions,
  buildCompilerProbeArgs,
  buildToolchainEnvironment,
  MIN_GNU_CPP_VERSION,
  MIN_GNU_GDB_VERSION,
} from "./resolver.js";

test("toolchain environment prepends the detected executable directory", () => {
  const environment = buildToolchainEnvironment(
    "D:\\Portable Themis\\GCC\\bin\\g++.exe",
    { Path: "C:\\Windows\\System32;C:\\Windows" },
    "win32",
  );
  assert.equal(
    environment.Path,
    "D:\\Portable Themis\\GCC\\bin;C:\\Windows\\System32;C:\\Windows",
  );

  const unchanged = buildToolchainEnvironment(
    "D:\\Portable Themis\\GCC\\bin\\g++.exe",
    environment,
    "win32",
  );
  assert.equal(unchanged.Path, environment.Path);
});

test("toolchain version floors match the supported Themis bundle", () => {
  assert.equal(MIN_GNU_CPP_VERSION, "9.2.0");
  assert.equal(MIN_GNU_GDB_VERSION, "7.6.1");
  assert.equal(compareVersions("9.2.0", MIN_GNU_CPP_VERSION), 0);
  assert.ok(compareVersions("9.1.9", MIN_GNU_CPP_VERSION) < 0);
  assert.ok(compareVersions("14.2", MIN_GNU_CPP_VERSION) > 0);
  assert.equal(compareVersions("7.6.1", MIN_GNU_GDB_VERSION), 0);
  assert.ok(compareVersions("7.6.0", MIN_GNU_GDB_VERSION) < 0);
});

test("compiler probe uses production-compatible flags on Windows and macOS", () => {
  const windows = buildCompilerProbeArgs("win32", "probe.cpp", "probe.exe");
  assert.ok(windows.includes("-static"));
  assert.ok(windows.includes("-Wl,--stack,66060288"));
  assert.equal(windows.at(-3), "probe.cpp");

  const mac = buildCompilerProbeArgs("darwin", "probe.cpp", "probe");
  assert.equal(mac.includes("-static"), false);
  assert.equal(mac.some((flag) => flag.includes("--stack")), false);
  assert.equal(mac.at(-3), "probe.cpp");
});

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
