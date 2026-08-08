import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { getHostStatus } from "../platform/host-status.js";
import {
  CPP_LANGUAGE_PROFILE_ID,
  LANGUAGE_REGISTRY_REVISION,
  listRegisteredLanguageProfiles,
} from "../languages/registry.js";
import {
  getToolchainDiscoveryFilePath,
  resetToolchainDiscoveryRuntimeForTests,
  setToolchainDiscoveryProbeForTests,
} from "./discovery.js";
import { buildLanguageProfileState } from "./profile-state.js";
import { updateProfileToolchainPreference } from "./storage.js";

function useFixture(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-cached-status-"));
  const previous = {
    appData: process.env.THEMIS_APP_DATA_DIR,
    distribution: process.env.JUDGEDESK_DISTRIBUTION,
    builtIn: process.env.JUDGEDESK_BUILTIN_TOOLCHAINS_DIR,
  };
  process.env.THEMIS_APP_DATA_DIR = path.join(root, "app-data");
  process.env.JUDGEDESK_DISTRIBUTION = "core";
  process.env.JUDGEDESK_BUILTIN_TOOLCHAINS_DIR = path.join(root, "built-in");
  fs.mkdirSync(process.env.JUDGEDESK_BUILTIN_TOOLCHAINS_DIR);
  resetToolchainDiscoveryRuntimeForTests();
  t.after(() => {
    setToolchainDiscoveryProbeForTests(undefined);
    resetToolchainDiscoveryRuntimeForTests();
    fs.rmSync(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) {
      const environmentKey = key === "appData"
        ? "THEMIS_APP_DATA_DIR"
        : key === "distribution"
          ? "JUDGEDESK_DISTRIBUTION"
          : "JUDGEDESK_BUILTIN_TOOLCHAINS_DIR";
      if (value === undefined) delete process.env[environmentKey];
      else process.env[environmentKey] = value;
    }
  });
  return root;
}

test("profile and host status consume the persisted discovery cache without probing", (t) => {
  const root = useFixture(t);
  updateProfileToolchainPreference(CPP_LANGUAGE_PROFILE_ID, { mode: "local_auto" });
  const compilerPath = path.join(root, os.platform() === "win32" ? "g++.exe" : "g++");
  const profiles = Object.fromEntries(
    listRegisteredLanguageProfiles().map((entry) => [entry.profile.ref.id, []]),
  ) as Record<string, unknown[]>;
  profiles[CPP_LANGUAGE_PROFILE_ID] = [{
    candidateId: "a".repeat(24),
    profileId: CPP_LANGUAGE_PROFILE_ID,
    kind: "cpp",
    canonicalPath: compilerPath,
    displayPath: compilerPath,
    origin: "path",
    pathRank: 0,
    family: "gnu-gcc",
    version: "14.2.0",
    target: "x86_64-w64-mingw32",
    lastSeenAt: "2026-08-02T00:00:00.000Z",
    error: null,
  }];
  fs.mkdirSync(path.dirname(getToolchainDiscoveryFilePath()), { recursive: true });
  fs.writeFileSync(
    getToolchainDiscoveryFilePath(),
    `${JSON.stringify({
      schemaVersion: 2,
      registryRevision: LANGUAGE_REGISTRY_REVISION,
      status: "complete",
      refreshing: false,
      completedAt: "2026-08-02T00:00:00.000Z",
      profiles,
    })}\n`,
  );
  resetToolchainDiscoveryRuntimeForTests();
  let probeCalls = 0;
  setToolchainDiscoveryProbeForTests(async () => {
    probeCalls += 1;
    throw new Error("status paths must not probe");
  });

  const profileState = buildLanguageProfileState([]);
  const cpp = profileState.profiles.find((entry) => entry.kind === "cpp");
  assert.ok(cpp);
  assert.equal(cpp.detected, true);
  assert.equal(cpp.active.version, "14.2.0");
  assert.equal(cpp.active.ready, false, "detected is distinct from certified readiness");
  const hostStatus = getHostStatus();
  assert.equal(hostStatus.gpp.installed, true);
  assert.equal(hostStatus.gpp.version, "14.2.0");
  assert.equal(probeCalls, 0);
});
