import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getJudgeDeskDistribution } from "../distribution.js";
import {
  CPP_LANGUAGE_PROFILE_ID,
  listRegisteredLanguageProfiles,
  PYTHON_LANGUAGE_PROFILE_ID,
} from "../languages/registry.js";
import type {
  LanguageProfileId,
  StoredProfileToolchainPreference,
} from "../languages/contracts.js";
import { getDescriptorForHost } from "./manifest.js";
import {
  decodeAndMigrateToolchainPreferences,
  decodeToolchainPreferencesBytes,
  encodeToolchainPreferencesV2,
  getStoredProfilePreference,
  type LegacyProfileMapping,
  type ToolchainPreferenceRecoveryDiagnostic,
  type ToolchainPreferencesV2,
} from "./preferences-v2.js";

export interface ToolchainPreferences {
  customCppPath?: string;
  customPythonPath?: string;
  preferredSourceCpp?: "managed" | "custom" | "system";
  preferredSourcePython?: "managed" | "custom" | "system";
  /** Legacy hint only; installed state is always derived from verified disk content. */
  installedToolchains?: string[];
}

export const LEGACY_PROFILE_MAPPING: LegacyProfileMapping = {
  cpp: CPP_LANGUAGE_PROFILE_ID,
  python: PYTHON_LANGUAGE_PROFILE_ID,
};

export interface ToolchainPreferenceSnapshot {
  preferences: ToolchainPreferencesV2;
  revision: string;
  status: "ready" | "initialized" | "migrated" | "recovery";
  recoveryDiagnostics: readonly ToolchainPreferenceRecoveryDiagnostic[];
}

class ToolchainPreferenceConflictError extends Error {
  constructor() {
    super("Toolchain preferences changed while an update was being committed.");
    this.name = "ToolchainPreferenceConflictError";
  }
}

export function getAppDataDir(): string {
  if (process.env.THEMIS_APP_DATA_DIR) {
    return process.env.THEMIS_APP_DATA_DIR;
  }
  const platform = os.platform();
  if (platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "ThemisV2",
    );
  }
  if (platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "ThemisV2",
    );
  }
  return path.join(os.homedir(), ".themisv2-dev");
}

export function getDownloadedToolchainsDir(): string {
  const dir = path.join(getAppDataDir(), "toolchains");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Compatibility alias. New code should use getDownloadedToolchainsDir() so a
 * per-user downloaded pack is never confused with a read-only pack bundled by
 * the JudgeDesk Full installer.
 */
export function getToolchainsDir(): string {
  return getDownloadedToolchainsDir();
}

export function getPreferencesFilePath(): string {
  const dir = getAppDataDir();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "toolchains.json");
}

export function createInitialToolchainPreferences(): ToolchainPreferencesV2 {
  const profiles: Record<string, StoredProfileToolchainPreference> = {};
  const distribution = getJudgeDeskDistribution();
  for (const entry of listRegisteredLanguageProfiles()) {
    const managedSupported = !!getDescriptorForHost(
      os.platform(),
      os.arch(),
      entry.toolchainKind,
    );
    profiles[entry.profile.ref.id] = {
      mode:
        distribution === "full"
        && entry.profile.stability === "stable"
        && managedSupported
          ? "managed"
          : entry.freshInstallMode,
    };
  }
  return { schemaVersion: 2, profiles };
}

function createFailClosedToolchainPreferences(): ToolchainPreferencesV2 {
  const profiles: Record<string, StoredProfileToolchainPreference> = {};
  for (const entry of listRegisteredLanguageProfiles()) {
    profiles[entry.profile.ref.id] = { mode: "none" };
  }
  return { schemaVersion: 2, profiles };
}

function contentRevision(bytes: Uint8Array | null): string {
  if (bytes === null) return "missing";
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function readPreferenceBytes(filePath: string): Buffer | null {
  try {
    return fs.readFileSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function syncDirectory(directory: string): void {
  if (os.platform() === "win32") return;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function writeCanonicalPreferences(
  canonicalJson: string,
  expectedRevision: string,
): string {
  const filePath = getPreferencesFilePath();
  const directory = path.dirname(filePath);
  const before = readPreferenceBytes(filePath);
  if (contentRevision(before) !== expectedRevision) {
    throw new ToolchainPreferenceConflictError();
  }

  const temporaryPath = path.join(
    directory,
    `.toolchains.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(descriptor, canonicalJson, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;

    const current = readPreferenceBytes(filePath);
    if (contentRevision(current) !== expectedRevision) {
      throw new ToolchainPreferenceConflictError();
    }
    fs.renameSync(temporaryPath, filePath);
    syncDirectory(directory);
    return contentRevision(Buffer.from(canonicalJson, "utf8"));
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporaryPath, { force: true });
  }
}

export function loadToolchainPreferenceSnapshot(): ToolchainPreferenceSnapshot {
  const filePath = getPreferencesFilePath();
  const bytes = readPreferenceBytes(filePath);
  if (bytes === null) {
    const preferences = createInitialToolchainPreferences();
    const canonicalJson = encodeToolchainPreferencesV2(
      preferences,
      LEGACY_PROFILE_MAPPING,
    );
    const revision = writeCanonicalPreferences(canonicalJson, "missing");
    return {
      preferences,
      revision,
      status: "initialized",
      recoveryDiagnostics: [],
    };
  }

  const decoded = decodeToolchainPreferencesBytes(bytes, LEGACY_PROFILE_MAPPING);
  if (decoded.status === "invalid" || decoded.status === "unsupported-version") {
    return {
      preferences: createFailClosedToolchainPreferences(),
      revision: contentRevision(bytes),
      status: "recovery",
      recoveryDiagnostics: decoded.diagnostics,
    };
  }

  if (decoded.status === "migrated-v1") {
    const revision = writeCanonicalPreferences(
      decoded.canonicalJson,
      contentRevision(bytes),
    );
    return {
      preferences: decoded.preferences,
      revision,
      status: "migrated",
      recoveryDiagnostics: [],
    };
  }

  return {
    preferences: decoded.preferences,
    revision: contentRevision(bytes),
    status: "ready",
    recoveryDiagnostics: [],
  };
}

export function updateProfileToolchainPreference(
  profileId: LanguageProfileId,
  preference: StoredProfileToolchainPreference,
): ToolchainPreferenceSnapshot {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const snapshot = loadToolchainPreferenceSnapshot();
    if (snapshot.status === "recovery") {
      throw new Error(
        "Toolchain preferences require recovery before they can be modified.",
      );
    }
    const migrationDiagnostics = snapshot.preferences.migrationDiagnostics?.filter(
      (diagnostic) => !("profileId" in diagnostic) || diagnostic.profileId !== profileId,
    );
    const preferences: ToolchainPreferencesV2 = {
      schemaVersion: 2,
      profiles: {
        ...snapshot.preferences.profiles,
        [profileId]: preference,
      },
      ...(migrationDiagnostics && migrationDiagnostics.length > 0
        ? { migrationDiagnostics }
        : {}),
    };
    const canonicalJson = encodeToolchainPreferencesV2(
      preferences,
      LEGACY_PROFILE_MAPPING,
    );
    try {
      const revision = writeCanonicalPreferences(canonicalJson, snapshot.revision);
      return {
        preferences,
        revision,
        status: "ready",
        recoveryDiagnostics: [],
      };
    } catch (error) {
      if (!(error instanceof ToolchainPreferenceConflictError) || attempt === 2) {
        throw error;
      }
    }
  }
  throw new ToolchainPreferenceConflictError();
}

/**
 * Applies an asynchronous action result only if the user's preference document
 * is still exactly the revision captured when that action began.
 */
export function tryUpdateProfileToolchainPreferenceAtRevision(
  profileId: LanguageProfileId,
  preference: StoredProfileToolchainPreference,
  expectedRevision: string,
): ToolchainPreferenceSnapshot | null {
  const snapshot = loadToolchainPreferenceSnapshot();
  if (snapshot.status === "recovery" || snapshot.revision !== expectedRevision) {
    return null;
  }
  const migrationDiagnostics = snapshot.preferences.migrationDiagnostics?.filter(
    (diagnostic) => !("profileId" in diagnostic) || diagnostic.profileId !== profileId,
  );
  const preferences: ToolchainPreferencesV2 = {
    schemaVersion: 2,
    profiles: {
      ...snapshot.preferences.profiles,
      [profileId]: preference,
    },
    ...(migrationDiagnostics && migrationDiagnostics.length > 0
      ? { migrationDiagnostics }
      : {}),
  };
  const canonicalJson = encodeToolchainPreferencesV2(
    preferences,
    LEGACY_PROFILE_MAPPING,
  );
  try {
    const revision = writeCanonicalPreferences(canonicalJson, expectedRevision);
    return {
      preferences,
      revision,
      status: "ready",
      recoveryDiagnostics: [],
    };
  } catch (error) {
    if (error instanceof ToolchainPreferenceConflictError) return null;
    throw error;
  }
}

function sourceModeToLegacy(
  mode: StoredProfileToolchainPreference["mode"],
): "managed" | "custom" | "system" | undefined {
  if (mode === "managed") return "managed";
  if (mode === "local_path") return "custom";
  if (mode === "local_auto") return "system";
  return undefined;
}

/** Compatibility view for judge paths while callers migrate to profile IDs. */
export function loadPreferences(): ToolchainPreferences {
  const snapshot = loadToolchainPreferenceSnapshot();
  const cpp = getStoredProfilePreference(snapshot.preferences, CPP_LANGUAGE_PROFILE_ID);
  const python = getStoredProfilePreference(
    snapshot.preferences,
    PYTHON_LANGUAGE_PROFILE_ID,
  );
  return {
    preferredSourceCpp: sourceModeToLegacy(cpp.mode),
    ...(cpp.localPath ? { customCppPath: cpp.localPath } : {}),
    preferredSourcePython: sourceModeToLegacy(python.mode),
    ...(python.localPath ? { customPythonPath: python.localPath } : {}),
    installedToolchains: [],
  };
}

/** Compatibility writer used by the existing installer until manifest v2. */
export function savePreferences(prefs: ToolchainPreferences): void {
  const decoded = decodeAndMigrateToolchainPreferences(
    {
      ...(prefs.customCppPath === undefined ? {} : { customCppPath: prefs.customCppPath }),
      ...(prefs.customPythonPath === undefined
        ? {}
        : { customPythonPath: prefs.customPythonPath }),
      ...(prefs.preferredSourceCpp === undefined
        ? {}
        : { preferredSourceCpp: prefs.preferredSourceCpp }),
      ...(prefs.preferredSourcePython === undefined
        ? {}
        : { preferredSourcePython: prefs.preferredSourcePython }),
      ...(prefs.installedToolchains === undefined
        ? {}
        : { installedToolchains: prefs.installedToolchains }),
    },
    LEGACY_PROFILE_MAPPING,
  );
  if (decoded.status !== "migrated-v1") {
    throw new Error("Legacy toolchain preferences could not be migrated safely.");
  }

  const filePath = getPreferencesFilePath();
  const current = readPreferenceBytes(filePath);
  writeCanonicalPreferences(decoded.canonicalJson, contentRevision(current));
}
