import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  toolchainExecutableProbeArgs,
  uninstallToolchain,
  validateExtractedLinks,
} from "./installer.js";

test("toolchain executable probes use each CLI's supported version syntax", () => {
  assert.deepEqual(
    toolchainExecutableProbeArgs("fpc.single-file-v1"),
    ["-iV"],
  );
  assert.deepEqual(
    toolchainExecutableProbeArgs("go.cgo-disabled-v1"),
    ["version"],
  );
  assert.deepEqual(
    toolchainExecutableProbeArgs("dotnet10.offline-console-v1"),
    ["--version"],
  );
});

test("uninstall rejects unknown and traversal-like toolchain IDs", async () => {
  await assert.rejects(
    uninstallToolchain(".."),
    /Unknown toolchain package/,
  );
  await assert.rejects(
    uninstallToolchain("not-in-the-catalog"),
    /Unknown toolchain package/,
  );
});

test("archive link validation accepts internal links through a canonical root alias", {
  skip: process.platform === "win32" ? "symlinks require elevated privileges on Windows" : false,
}, () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-installer-links-"));
  try {
    const realRoot = path.join(temporaryRoot, "real");
    const aliasRoot = path.join(temporaryRoot, "alias");
    const binDirectory = path.join(realRoot, "bin");
    fs.mkdirSync(binDirectory, { recursive: true });
    fs.writeFileSync(path.join(binDirectory, "2to3-3.12"), "python");
    fs.symlinkSync("2to3-3.12", path.join(binDirectory, "2to3"));
    fs.symlinkSync(realRoot, aliasRoot, "dir");

    assert.doesNotThrow(() => validateExtractedLinks(aliasRoot));
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("archive link validation rejects links outside the canonical installation root", {
  skip: process.platform === "win32" ? "symlinks require elevated privileges on Windows" : false,
}, () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-installer-escape-"));
  try {
    const installRoot = path.join(temporaryRoot, "install");
    const binDirectory = path.join(installRoot, "bin");
    const outsideTarget = path.join(temporaryRoot, "outside");
    fs.mkdirSync(binDirectory, { recursive: true });
    fs.writeFileSync(outsideTarget, "outside");
    fs.symlinkSync(outsideTarget, path.join(binDirectory, "escape"));

    assert.throws(
      () => validateExtractedLinks(installRoot),
      /symbolic link escapes the installation directory/,
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
