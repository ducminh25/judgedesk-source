import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  CPP_LANGUAGE_PROFILE_ID,
  PYTHON_LANGUAGE_PROFILE_ID,
} from "../languages/registry.js";
import {
  getPreferencesFilePath,
  loadToolchainPreferenceSnapshot,
  tryUpdateProfileToolchainPreferenceAtRevision,
  updateProfileToolchainPreference,
} from "./storage.js";

function useTemporaryAppData(t: TestContext): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "judgedesk-toolchain-storage-v2-"),
  );
  const previous = process.env.THEMIS_APP_DATA_DIR;
  process.env.THEMIS_APP_DATA_DIR = directory;
  t.after(() => {
    fs.rmSync(directory, { recursive: true, force: true });
    if (previous === undefined) delete process.env.THEMIS_APP_DATA_DIR;
    else process.env.THEMIS_APP_DATA_DIR = previous;
  });
  return directory;
}

test("missing preferences initialize the two legacy profiles without future-profile fallback", (t) => {
  useTemporaryAppData(t);
  const snapshot = loadToolchainPreferenceSnapshot();
  assert.equal(snapshot.status, "initialized");
  assert.equal(snapshot.preferences.profiles[CPP_LANGUAGE_PROFILE_ID]?.mode, "local_auto");
  assert.equal(
    snapshot.preferences.profiles[PYTHON_LANGUAGE_PROFILE_ID]?.mode,
    "local_auto",
  );
  const stored = JSON.parse(fs.readFileSync(getPreferencesFilePath(), "utf8"));
  assert.equal(stored.schemaVersion, 2);
  assert.deepEqual(Object.keys(stored.profiles), [
    CPP_LANGUAGE_PROFILE_ID,
    PYTHON_LANGUAGE_PROFILE_ID,
  ]);
});

test("a fresh Full install selects supported Stable managed packs without changing migrations", (t) => {
  useTemporaryAppData(t);
  const previous = process.env.JUDGEDESK_DISTRIBUTION;
  process.env.JUDGEDESK_DISTRIBUTION = "full";
  t.after(() => {
    if (previous === undefined) delete process.env.JUDGEDESK_DISTRIBUTION;
    else process.env.JUDGEDESK_DISTRIBUTION = previous;
  });

  const snapshot = loadToolchainPreferenceSnapshot();
  assert.equal(snapshot.status, "initialized");
  assert.equal(
    snapshot.preferences.profiles[PYTHON_LANGUAGE_PROFILE_ID]?.mode,
    "managed",
  );
  assert.equal(
    snapshot.preferences.profiles[CPP_LANGUAGE_PROFILE_ID]?.mode,
    process.platform === "win32" ? "managed" : "local_auto",
  );
});

test("legacy preferences migrate once and preserve dormant local paths", (t) => {
  useTemporaryAppData(t);
  fs.writeFileSync(
    getPreferencesFilePath(),
    JSON.stringify({
      preferredSourceCpp: "system",
      customCppPath: String.raw`C:\remembered\g++.exe`,
      preferredSourcePython: "managed",
      customPythonPath: String.raw`C:\remembered\python.exe`,
      installedToolchains: ["untrusted-hint"],
    }),
  );

  const migrated = loadToolchainPreferenceSnapshot();
  assert.equal(migrated.status, "migrated");
  assert.deepEqual(migrated.preferences.profiles[CPP_LANGUAGE_PROFILE_ID], {
    mode: "local_auto",
    localPath: String.raw`C:\remembered\g++.exe`,
  });
  assert.deepEqual(migrated.preferences.profiles[PYTHON_LANGUAGE_PROFILE_ID], {
    mode: "managed",
    localPath: String.raw`C:\remembered\python.exe`,
  });
  assert.equal(loadToolchainPreferenceSnapshot().status, "ready");
});

test("corrupt preferences remain byte-for-byte intact and block mutation", (t) => {
  useTemporaryAppData(t);
  const invalid = Buffer.from("{not-json", "utf8");
  fs.writeFileSync(getPreferencesFilePath(), invalid);
  const snapshot = loadToolchainPreferenceSnapshot();
  assert.equal(snapshot.status, "recovery");
  assert.equal(snapshot.preferences.profiles[CPP_LANGUAGE_PROFILE_ID]?.mode, "none");
  assert.deepEqual(fs.readFileSync(getPreferencesFilePath()), invalid);
  assert.throws(
    () => updateProfileToolchainPreference(CPP_LANGUAGE_PROFILE_ID, { mode: "managed" }),
    /require recovery/,
  );
  assert.deepEqual(fs.readFileSync(getPreferencesFilePath()), invalid);
});

test("profile updates are atomic and do not erase sibling preferences", (t) => {
  useTemporaryAppData(t);
  loadToolchainPreferenceSnapshot();
  updateProfileToolchainPreference(CPP_LANGUAGE_PROFILE_ID, {
    mode: "local_path",
    localPath: String.raw`D:\compiler\g++.exe`,
  });
  const updated = loadToolchainPreferenceSnapshot();
  assert.deepEqual(updated.preferences.profiles[CPP_LANGUAGE_PROFILE_ID], {
    mode: "local_path",
    localPath: String.raw`D:\compiler\g++.exe`,
  });
  assert.equal(
    updated.preferences.profiles[PYTHON_LANGUAGE_PROFILE_ID]?.mode,
    "local_auto",
  );
  assert.equal(fs.readdirSync(path.dirname(getPreferencesFilePath())).some(
    (name) => name.endsWith(".tmp"),
  ), false);
});

test("an async install result cannot overwrite a newer radio selection", (t) => {
  useTemporaryAppData(t);
  const installationStarted = loadToolchainPreferenceSnapshot();
  updateProfileToolchainPreference(CPP_LANGUAGE_PROFILE_ID, { mode: "none" });

  const applied = tryUpdateProfileToolchainPreferenceAtRevision(
    CPP_LANGUAGE_PROFILE_ID,
    { mode: "managed" },
    installationStarted.revision,
  );
  assert.equal(applied, null);
  assert.equal(
    loadToolchainPreferenceSnapshot().preferences.profiles[CPP_LANGUAGE_PROFILE_ID]?.mode,
    "none",
  );
});
