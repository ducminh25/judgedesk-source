import assert from "node:assert/strict";
import test from "node:test";
import {
  closeUpdateResources,
  formatUpdateBytes,
  parseUpdateCandidate,
  requiresEditionChange,
  requireMatchingUpdateVersions,
  updaterTargetForHost,
} from "./catalog.js";

test("updater targets keep Core and Full separate on supported hosts", () => {
  assert.equal(
    updaterTargetForHost({ platform: "win32", arch: "x64" }, "core"),
    "windows-x86_64-core",
  );
  assert.equal(
    updaterTargetForHost({ platform: "darwin", arch: "arm64" }, "full"),
    "darwin-aarch64-full",
  );
  assert.equal(
    updaterTargetForHost({ platform: "linux", arch: "x64" }, "core"),
    "linux-x86_64-core",
  );
  assert.equal(
    updaterTargetForHost({ platform: "linux", arch: "x64", bundleType: "deb" }, "core"),
    "linux-x86_64-deb-core",
  );
  assert.equal(
    updaterTargetForHost({ platform: "linux", arch: "x64", bundleType: "rpm" }, "core"),
    "linux-x86_64-rpm-core",
  );
  assert.equal(
    updaterTargetForHost({ platform: "linux", arch: "x64", bundleType: "appimage" }, "core"),
    "linux-x86_64-appimage-core",
  );
  assert.throws(
    () => updaterTargetForHost({ platform: "win32", arch: "arm64" }, "core"),
    /Unsupported updater host/,
  );
});

test("candidate parsing requires edition and positive exact sizes", () => {
  const rawJson = {
    platforms: {
      "windows-x86_64-core": {
        judgedesk: {
          edition: "core",
          downloadSizeBytes: 41_000_000,
          installedSizeBytes: 112_000_000,
        },
      },
    },
  };
  assert.deepEqual(
    parseUpdateCandidate(
      { version: "1.3.4", rawJson },
      "windows-x86_64-core",
      "core",
    ),
    {
      edition: "core",
      version: "1.3.4",
      target: "windows-x86_64-core",
      downloadSizeBytes: 41_000_000,
      installedSizeBytes: 112_000_000,
    },
  );
  assert.throws(
    () => parseUpdateCandidate(
      { version: "1.3.4", rawJson },
      "windows-x86_64-core",
      "full",
    ),
    /Invalid JudgeDesk updater metadata/,
  );
});

test("Core and Full must announce the same newest version", () => {
  const candidate = {
    edition: "core" as const,
    target: "windows-x86_64-core",
    version: "1.3.4",
    downloadSizeBytes: 1,
    installedSizeBytes: 2,
  };
  assert.equal(requireMatchingUpdateVersions([
    candidate,
    { ...candidate, edition: "full", target: "windows-x86_64-full" },
  ]), "1.3.4");
  assert.throws(() => requireMatchingUpdateVersions([
    candidate,
    { ...candidate, edition: "full", version: "1.3.5" },
  ]), /versions do not match/);
});

test("only switching edition requires an extra confirmation", () => {
  assert.equal(requiresEditionChange("core", "core"), false);
  assert.equal(requiresEditionChange("full", "full"), false);
  assert.equal(requiresEditionChange("core", "full"), true);
  assert.equal(requiresEditionChange("full", "core"), true);
});

test("discarding an update closes every unique downloaded resource", async () => {
  const calls: string[] = [];
  const core = { close: async () => { calls.push("core"); } };
  const full = { close: async () => { calls.push("full"); } };
  await closeUpdateResources([core, full, core, null]);
  assert.deepEqual(calls.sort(), ["core", "full"]);
});

test("display sizes stay compact for low-tech update choices", () => {
  assert.equal(formatUpdateBytes(41 * 1024 ** 2, "en"), "41 MB");
  assert.equal(formatUpdateBytes(1.9 * 1024 ** 3, "en"), "1.9 GB");
});
