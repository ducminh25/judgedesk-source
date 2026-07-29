import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  CPP_LANGUAGE_PROFILE_ID,
  PYTHON_LANGUAGE_PROFILE_ID,
} from "../languages/registry.js";
import { resetToolchainDiscoveryRuntimeForTests } from "./discovery.js";
import { buildLanguageProfileState } from "./profile-state.js";
import { updateProfileToolchainPreference } from "./storage.js";

function useTemporaryAppData(t: TestContext): void {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "judgedesk-profile-state-"),
  );
  const previous = process.env.THEMIS_APP_DATA_DIR;
  process.env.THEMIS_APP_DATA_DIR = directory;
  resetToolchainDiscoveryRuntimeForTests();
  t.after(() => {
    resetToolchainDiscoveryRuntimeForTests();
    fs.rmSync(directory, { recursive: true, force: true });
    if (previous === undefined) delete process.env.THEMIS_APP_DATA_DIR;
    else process.env.THEMIS_APP_DATA_DIR = previous;
  });
}

test("profile state is registry ordered and reports first-run detection without fallback", (t) => {
  useTemporaryAppData(t);
  const state = buildLanguageProfileState([]);
  assert.equal(state.registryRevision, 1);
  assert.equal(state.discovery.status, "not_started");
  assert.deepEqual(
    state.profiles.map((profile) => profile.id),
    [CPP_LANGUAGE_PROFILE_ID, PYTHON_LANGUAGE_PROFILE_ID],
  );
  for (const profile of state.profiles) {
    assert.equal(profile.selection.mode, "local_auto");
    assert.equal(profile.status, "not_available");
    assert.equal(profile.roles.submissionReady, false);
    assert.equal(profile.roles.checkerReady, false);
    assert.equal(profile.diagnostic?.code, "DETECTION_IN_PROGRESS");
  }
});

test("None remains active intent even when other sources may exist", (t) => {
  useTemporaryAppData(t);
  updateProfileToolchainPreference(CPP_LANGUAGE_PROFILE_ID, { mode: "none" });
  const state = buildLanguageProfileState([]);
  const cpp = state.profiles.find((profile) => profile.id === CPP_LANGUAGE_PROFILE_ID);
  assert.ok(cpp);
  assert.equal(cpp.selection.mode, "none");
  assert.equal(cpp.active.source, "none");
  assert.equal(cpp.status, "not_available");
  assert.equal(cpp.diagnostic?.code, "DISABLED_BY_USER");
});
