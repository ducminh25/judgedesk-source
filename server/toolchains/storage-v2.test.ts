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
  getToolchainDistributionStateFilePath,
  getToolchainDistributionTransitionFilePath,
  loadToolchainPreferenceSnapshot,
  setDistributionTransitionFailureForTests,
  tryUpdateProfileToolchainPreferenceAtRevision,
  updateProfileToolchainPreference,
} from "./storage.js";
import {
  getDescriptorForHost,
  TOOLCHAIN_RELEASE_BLUEPRINTS,
} from "./manifest.js";
import type { ToolchainKind } from "./types.js";

function useTemporaryAppData(t: TestContext): { directory: string; builtIn: string } {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "judgedesk-toolchain-storage-v2-"),
  );
  const builtIn = path.join(directory, "built-in");
  fs.mkdirSync(builtIn);
  const previous = {
    appData: process.env.THEMIS_APP_DATA_DIR,
    builtIn: process.env.JUDGEDESK_BUILTIN_TOOLCHAINS_DIR,
  };
  process.env.THEMIS_APP_DATA_DIR = directory;
  process.env.JUDGEDESK_BUILTIN_TOOLCHAINS_DIR = builtIn;
  t.after(() => {
    setDistributionTransitionFailureForTests(undefined);
    fs.rmSync(directory, { recursive: true, force: true });
    if (previous.appData === undefined) delete process.env.THEMIS_APP_DATA_DIR;
    else process.env.THEMIS_APP_DATA_DIR = previous.appData;
    if (previous.builtIn === undefined) {
      delete process.env.JUDGEDESK_BUILTIN_TOOLCHAINS_DIR;
    } else {
      process.env.JUDGEDESK_BUILTIN_TOOLCHAINS_DIR = previous.builtIn;
    }
  });
  return { directory, builtIn };
}

function useDistribution(
  t: TestContext,
  distribution: "full" | "core" | "development",
): void {
  const previous = process.env.JUDGEDESK_DISTRIBUTION;
  process.env.JUDGEDESK_DISTRIBUTION = distribution;
  t.after(() => {
    if (previous === undefined) delete process.env.JUDGEDESK_DISTRIBUTION;
    else process.env.JUDGEDESK_DISTRIBUTION = previous;
  });
}

function stageBuiltInPackage(root: string, kind: ToolchainKind): void {
  const descriptor = getDescriptorForHost(os.platform(), os.arch(), kind);
  assert.ok(descriptor, `missing host descriptor for ${kind}`);
  const blueprint = TOOLCHAIN_RELEASE_BLUEPRINTS[descriptor.id];
  assert.ok(blueprint, `missing release blueprint for ${descriptor.id}`);
  const packageRoot = path.join(root, descriptor.id);
  if (fs.existsSync(path.join(packageRoot, ".judgedesk-package.json"))) return;
  fs.mkdirSync(packageRoot, { recursive: true });
  for (const component of blueprint.components) {
    const componentPath = component.relativePath === "."
      ? packageRoot
      : path.join(packageRoot, ...component.relativePath.split("/"));
    if (component.kind === "support-root") {
      fs.mkdirSync(componentPath, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(componentPath), { recursive: true });
      fs.writeFileSync(componentPath, `fixture:${component.id}`);
      if (os.platform() !== "win32") fs.chmodSync(componentPath, 0o700);
    }
  }
  fs.writeFileSync(
    path.join(packageRoot, ".judgedesk-package.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      packageId: descriptor.id,
      version: blueprint.version,
      archiveSha256: "a".repeat(64),
      entrypointComponentId: blueprint.entrypointComponentId,
      components: blueprint.components,
    }, null, 2)}\n`,
  );
}

function stageStableBuiltIns(root: string, omitted?: ToolchainKind): void {
  const staged = new Set<string>();
  for (const entry of listRegisteredLanguageProfiles()) {
    if (entry.profile.stability !== "stable" || entry.toolchainKind === omitted) {
      continue;
    }
    const descriptor = getDescriptorForHost(
      os.platform(),
      os.arch(),
      entry.toolchainKind,
    );
    if (!descriptor || staged.has(descriptor.id)) continue;
    stageBuiltInPackage(root, entry.toolchainKind);
    staged.add(descriptor.id);
  }
}

function hostHasStableManagedPackage(): boolean {
  return listRegisteredLanguageProfiles().some((entry) =>
    entry.profile.stability === "stable"
    && !!getDescriptorForHost(os.platform(), os.arch(), entry.toolchainKind)
  );
}

test("missing preferences keep legacy auto-detect and initialize new profiles to None", (t) => {
  useTemporaryAppData(t);
  useDistribution(t, "core");
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
  const { builtIn } = useTemporaryAppData(t);
  useDistribution(t, "full");
  stageStableBuiltIns(builtIn);

  const snapshot = loadToolchainPreferenceSnapshot();
  assert.equal(snapshot.status, "initialized");
  for (const entry of listRegisteredLanguageProfiles()) {
    const descriptor = getDescriptorForHost(
      os.platform(),
      os.arch(),
      entry.toolchainKind,
    );
    const legacyAutoDetect = entry.profile.ref.id === CPP_LANGUAGE_PROFILE_ID
      || entry.profile.ref.id === C_LANGUAGE_PROFILE_ID
      || entry.profile.ref.id === PYTHON_LANGUAGE_PROFILE_ID;
    const expectedMode = entry.profile.stability === "stable" && descriptor
      ? "managed"
      : legacyAutoDetect
        ? "local_auto"
        : "none";
    assert.equal(
      snapshot.preferences.profiles[entry.profile.ref.id]?.mode,
      expectedMode,
    );
  }
  const marker = JSON.parse(
    fs.readFileSync(getToolchainDistributionStateFilePath(), "utf8"),
  );
  assert.equal(marker.lastDistribution, "full");
  assert.equal(marker.autoConfiguredRevision, 1);
});

test("Core to Full overrides every available Stable built-in exactly once", (t) => {
  const { builtIn } = useTemporaryAppData(t);
  useDistribution(t, "core");
  loadToolchainPreferenceSnapshot();
  updateProfileToolchainPreference(CPP_LANGUAGE_PROFILE_ID, { mode: "none" });
  updateProfileToolchainPreference(PYTHON_LANGUAGE_PROFILE_ID, {
    mode: "local_path",
    localPath: path.resolve("remembered-python"),
  });
  stageStableBuiltIns(builtIn);

  process.env.JUDGEDESK_DISTRIBUTION = "full";
  const migrated = loadToolchainPreferenceSnapshot();
  assert.equal(
    migrated.status,
    hostHasStableManagedPackage() ? "migrated" : "ready",
  );
  for (const entry of listRegisteredLanguageProfiles()) {
    const descriptor = getDescriptorForHost(
      os.platform(),
      os.arch(),
      entry.toolchainKind,
    );
    if (entry.profile.stability === "stable" && descriptor) {
      assert.equal(
        migrated.preferences.profiles[entry.profile.ref.id]?.mode,
        "managed",
      );
    }
  }
  assert.equal(
    migrated.preferences.profiles[PYTHON_LANGUAGE_PROFILE_ID]?.localPath,
    path.resolve("remembered-python"),
  );

  updateProfileToolchainPreference(PYTHON_LANGUAGE_PROFILE_ID, { mode: "none" });
  const repeated = loadToolchainPreferenceSnapshot();
  assert.equal(repeated.status, "ready");
  assert.equal(
    repeated.preferences.profiles[PYTHON_LANGUAGE_PROFILE_ID]?.mode,
    "none",
  );
});

test("Full transition leaves a missing built-in selection untouched", (t) => {
  const { builtIn } = useTemporaryAppData(t);
  useDistribution(t, "core");
  loadToolchainPreferenceSnapshot();
  updateProfileToolchainPreference(PYTHON_LANGUAGE_PROFILE_ID, { mode: "none" });
  stageStableBuiltIns(builtIn, "python");

  process.env.JUDGEDESK_DISTRIBUTION = "full";
  const migrated = loadToolchainPreferenceSnapshot();
  assert.equal(
    migrated.preferences.profiles[PYTHON_LANGUAGE_PROFILE_ID]?.mode,
    "none",
  );
  assert.equal(
    migrated.preferences.profiles[PASCAL_LANGUAGE_PROFILE_ID]?.mode,
    getDescriptorForHost(os.platform(), os.arch(), "pascal")
      ? "managed"
      : "none",
  );
});

test("Full to Core replaces dangling managed selections with registry defaults", (t) => {
  const { builtIn } = useTemporaryAppData(t);
  useDistribution(t, "full");
  stageStableBuiltIns(builtIn);
  loadToolchainPreferenceSnapshot();
  fs.rmSync(builtIn, { recursive: true, force: true });
  fs.mkdirSync(builtIn);

  process.env.JUDGEDESK_DISTRIBUTION = "core";
  const migrated = loadToolchainPreferenceSnapshot();
  for (const profileId of [
    CPP_LANGUAGE_PROFILE_ID,
    C_LANGUAGE_PROFILE_ID,
    PYTHON_LANGUAGE_PROFILE_ID,
  ]) {
    assert.equal(migrated.preferences.profiles[profileId]?.mode, "local_auto");
  }
  for (const profileId of [PASCAL_LANGUAGE_PROFILE_ID, JAVA_LANGUAGE_PROFILE_ID]) {
    assert.equal(migrated.preferences.profiles[profileId]?.mode, "none");
  }
});

test("an interrupted distribution transaction is recovered from its journal", {
  skip: hostHasStableManagedPackage()
    ? false
    : "distribution transactions require a managed package for the current host",
}, (t) => {
  const { directory, builtIn } = useTemporaryAppData(t);
  useDistribution(t, "core");
  loadToolchainPreferenceSnapshot();
  const before = fs.readFileSync(getPreferencesFilePath());
  stageStableBuiltIns(builtIn);
  process.env.JUDGEDESK_DISTRIBUTION = "full";
  setDistributionTransitionFailureForTests("after-preferences");
  assert.throws(
    () => loadToolchainPreferenceSnapshot(),
    /SIMULATED_DISTRIBUTION_TRANSITION_INTERRUPTION/,
  );
  assert.ok(fs.existsSync(getToolchainDistributionTransitionFilePath()));
  const backups = fs.readdirSync(
    path.join(directory, "toolchain-distribution-backups"),
  );
  assert.equal(backups.length, 1);
  assert.deepEqual(
    fs.readFileSync(path.join(
      directory,
      "toolchain-distribution-backups",
      backups[0],
    )),
    before,
  );

  setDistributionTransitionFailureForTests(undefined);
  const recovered = loadToolchainPreferenceSnapshot();
  assert.equal(
    recovered.preferences.profiles[PYTHON_LANGUAGE_PROFILE_ID]?.mode,
    "managed",
  );
  assert.equal(fs.existsSync(getToolchainDistributionTransitionFilePath()), false);
  assert.equal(
    JSON.parse(
      fs.readFileSync(getToolchainDistributionStateFilePath(), "utf8"),
    ).lastDistribution,
    "full",
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
