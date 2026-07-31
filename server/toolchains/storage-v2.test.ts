import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  C_LANGUAGE_PROFILE_ID,
  CPP_LANGUAGE_PROFILE_ID,
  JAVA_LANGUAGE_PROFILE_ID,
  listRegisteredLanguageProfiles,
  PASCAL_LANGUAGE_PROFILE_ID,
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

test("missing preferences keep legacy auto-detect and initialize new profiles to None", (t) => {
  useTemporaryAppData(t);
  const snapshot = loadToolchainPreferenceSnapshot();
  assert.equal(snapshot.status, "initialized");
  assert.equal(snapshot.preferences.profiles[CPP_LANGUAGE_PROFILE_ID]?.mode, "local_auto");
  assert.equal(
    snapshot.preferences.profiles[PYTHON_LANGUAGE_PROFILE_ID]?.mode,
    "local_auto",
  );
  assert.equal(
    snapshot.preferences.profiles[C_LANGUAGE_PROFILE_ID]?.mode,
    "local_auto",
  );
  const stored = JSON.parse(fs.readFileSync(getPreferencesFilePath(), "utf8"));
  assert.equal(stored.schemaVersion, 2);
  assert.deepEqual(
    new Set(Object.keys(stored.profiles)),
    new Set(
      listRegisteredLanguageProfiles().map((entry) => entry.profile.ref.id),
    ),
  );
  for (const entry of listRegisteredLanguageProfiles()) {
    if (
      entry.profile.ref.id !== CPP_LANGUAGE_PROFILE_ID
      && entry.profile.ref.id !== C_LANGUAGE_PROFILE_ID
      && entry.profile.ref.id !== PYTHON_LANGUAGE_PROFILE_ID
    ) {
      assert.equal(stored.profiles[entry.profile.ref.id]?.mode, "none");
    }
  }
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
  assert.equal(
    snapshot.preferences.profiles[C_LANGUAGE_PROFILE_ID]?.mode,
    process.platform === "win32" ? "managed" : "local_auto",
  );
  for (const profileId of [
    PASCAL_LANGUAGE_PROFILE_ID,
    JAVA_LANGUAGE_PROFILE_ID,
  ]) {
    assert.equal(snapshot.preferences.profiles[profileId]?.mode, "managed");
  }
});

test("a Full upgrade fills newly registered profiles without overwriting existing choices", (t) => {
  useTemporaryAppData(t);
  const previous = process.env.JUDGEDESK_DISTRIBUTION;
  process.env.JUDGEDESK_DISTRIBUTION = "full";
  t.after(() => {
    if (previous === undefined) delete process.env.JUDGEDESK_DISTRIBUTION;
    else process.env.JUDGEDESK_DISTRIBUTION = previous;
  });
  fs.writeFileSync(
    getPreferencesFilePath(),
    JSON.stringify({
      schemaVersion: 2,
      profiles: {
        [CPP_LANGUAGE_PROFILE_ID]: { mode: "none" },
        [PYTHON_LANGUAGE_PROFILE_ID]: { mode: "local_auto" },
      },
    }),
  );

  const migrated = loadToolchainPreferenceSnapshot();

  assert.equal(migrated.status, "migrated");
  assert.equal(
    migrated.preferences.profiles[CPP_LANGUAGE_PROFILE_ID]?.mode,
    "none",
  );
  assert.equal(
    migrated.preferences.profiles[PYTHON_LANGUAGE_PROFILE_ID]?.mode,
    "local_auto",
  );
  assert.equal(
    migrated.preferences.profiles[C_LANGUAGE_PROFILE_ID]?.mode,
    process.platform === "win32" ? "managed" : "local_auto",
  );
  for (const profileId of [
    PASCAL_LANGUAGE_PROFILE_ID,
    JAVA_LANGUAGE_PROFILE_ID,
  ]) {
    assert.equal(migrated.preferences.profiles[profileId]?.mode, "managed");
  }
  assert.equal(loadToolchainPreferenceSnapshot().status, "ready");
});

test(
  "a Windows Full upgrade repairs only the exact defaults materialized by the broken candidate",
  { skip: process.platform !== "win32" || process.arch !== "x64" },
  (t) => {
    useTemporaryAppData(t);
    const previous = process.env.JUDGEDESK_DISTRIBUTION;
    process.env.JUDGEDESK_DISTRIBUTION = "full";
    t.after(() => {
      if (previous === undefined) delete process.env.JUDGEDESK_DISTRIBUTION;
      else process.env.JUDGEDESK_DISTRIBUTION = previous;
    });
    fs.writeFileSync(
      getPreferencesFilePath(),
      JSON.stringify({
        schemaVersion: 2,
        profiles: {
          [CPP_LANGUAGE_PROFILE_ID]: { mode: "managed" },
          [PYTHON_LANGUAGE_PROFILE_ID]: { mode: "managed" },
          [C_LANGUAGE_PROFILE_ID]: { mode: "local_auto" },
          [JAVA_LANGUAGE_PROFILE_ID]: { mode: "none" },
          [PASCAL_LANGUAGE_PROFILE_ID]: { mode: "none" },
        },
        migrationDiagnostics: [
          {
            code: "LEGACY_INSTALLED_HINT_IGNORED",
            field: "installedToolchains",
          },
        ],
      }),
    );

    const migrated = loadToolchainPreferenceSnapshot();

    assert.equal(migrated.status, "migrated");
    for (const profileId of [
      CPP_LANGUAGE_PROFILE_ID,
      C_LANGUAGE_PROFILE_ID,
      PYTHON_LANGUAGE_PROFILE_ID,
      PASCAL_LANGUAGE_PROFILE_ID,
      JAVA_LANGUAGE_PROFILE_ID,
    ]) {
      assert.equal(migrated.preferences.profiles[profileId]?.mode, "managed");
    }
    assert.equal(migrated.preferences.migrationDiagnostics, undefined);
    assert.equal(loadToolchainPreferenceSnapshot().status, "ready");
  },
);

test(
  "a Windows Full upgrade preserves an explicit source choice near the broken-default fingerprint",
  { skip: process.platform !== "win32" || process.arch !== "x64" },
  (t) => {
    useTemporaryAppData(t);
    const previous = process.env.JUDGEDESK_DISTRIBUTION;
    process.env.JUDGEDESK_DISTRIBUTION = "full";
    t.after(() => {
      if (previous === undefined) delete process.env.JUDGEDESK_DISTRIBUTION;
      else process.env.JUDGEDESK_DISTRIBUTION = previous;
    });
    fs.writeFileSync(
      getPreferencesFilePath(),
      JSON.stringify({
        schemaVersion: 2,
        profiles: {
          [CPP_LANGUAGE_PROFILE_ID]: { mode: "managed" },
          [PYTHON_LANGUAGE_PROFILE_ID]: { mode: "managed" },
          [C_LANGUAGE_PROFILE_ID]: {
            mode: "local_path",
            localPath: String.raw`C:\teacher\gcc.exe`,
          },
          [JAVA_LANGUAGE_PROFILE_ID]: { mode: "none" },
          [PASCAL_LANGUAGE_PROFILE_ID]: { mode: "none" },
        },
        migrationDiagnostics: [
          {
            code: "LEGACY_INSTALLED_HINT_IGNORED",
            field: "installedToolchains",
          },
        ],
      }),
    );

    const preserved = loadToolchainPreferenceSnapshot();

    assert.equal(preserved.status, "ready");
    assert.deepEqual(
      preserved.preferences.profiles[C_LANGUAGE_PROFILE_ID],
      {
        mode: "local_path",
        localPath: String.raw`C:\teacher\gcc.exe`,
      },
    );
    assert.equal(
      preserved.preferences.profiles[PASCAL_LANGUAGE_PROFILE_ID]?.mode,
      "none",
    );
    assert.equal(
      preserved.preferences.profiles[JAVA_LANGUAGE_PROFILE_ID]?.mode,
      "none",
    );
  },
);

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
