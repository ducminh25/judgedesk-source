import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getJudgeDeskDistribution } from "../distribution.js";
import { RESOURCE_ROOT } from "../runtime.js";
import {
  C_LANGUAGE_PROFILE_ID,
  CPP_LANGUAGE_PROFILE_ID,
  JAVA_LANGUAGE_PROFILE_ID,
  listRegisteredLanguageProfiles,
  PASCAL_LANGUAGE_PROFILE_ID,
  PYTHON_LANGUAGE_PROFILE_ID,
} from "../languages/registry.js";
import type {
  LanguageProfileId,
  StoredProfileToolchainPreference,
} from "../languages/contracts.js";
import {
  getDescriptorForHost,
  TOOLCHAIN_RELEASE_BLUEPRINTS,
} from "./manifest.js";
import {
  decodeAndMigrateToolchainPreferences,
  decodeToolchainPreferencesBytes,
  encodeToolchainPreferencesV2,
  getStoredProfilePreference,
  type LegacyProfileMapping,
  type ToolchainPreferenceRecoveryDiagnostic,
  type ToolchainPreferencesV2,
} from "./preferences-v2.js";
import type { ToolchainCatalogEntry, ToolchainKind } from "./types.js";

const DISTRIBUTION_AUTOCONFIG_REVISION = 1;
const DISTRIBUTION_STATE_SCHEMA_VERSION = 1;
const DISTRIBUTION_TRANSITION_SCHEMA_VERSION = 1;
const MAX_DISTRIBUTION_STATE_BYTES = 2 * 1024 * 1024;

type PersistedDistribution = "full" | "core" | "development";

interface DistributionStateV1 {
  schemaVersion: 1;
  lastDistribution: PersistedDistribution;
  autoConfiguredRevision: number;
}

interface DistributionTransitionV1 {
  schemaVersion: 1;
  fromDistribution: PersistedDistribution | "unknown";
  toDistribution: PersistedDistribution;
  beforeRevision: string;
  afterRevision: string;
  backupFile: string;
  targetPreferences: ToolchainPreferencesV2;
}

let distributionTransitionFailureForTests:
  | "after-preferences"
  | undefined;

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

export function getToolchainDistributionStateFilePath(): string {
  return path.join(getAppDataDir(), "toolchain-distribution-state-v1.json");
}

export function getToolchainDistributionTransitionFilePath(): string {
  return path.join(getAppDataDir(), "toolchain-distribution-transition-v1.json");
}

export function setDistributionTransitionFailureForTests(
  point: "after-preferences" | undefined,
): void {
  distributionTransitionFailureForTests = point;
}

function builtInToolchainsRoot(): string {
  const override = process.env.JUDGEDESK_BUILTIN_TOOLCHAINS_DIR;
  return override
    ? path.resolve(override)
    : path.join(RESOURCE_ROOT, "toolchains");
}

function isDescendantOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isRegularPackagePath(
  packageRoot: string,
  relativePath: string,
  expected: "file" | "directory",
): boolean {
  try {
    const candidate = relativePath === "."
      ? packageRoot
      : path.join(packageRoot, ...relativePath.split("/"));
    const canonical = fs.realpathSync(candidate);
    if (!isDescendantOrEqual(packageRoot, canonical)) return false;
    const metadata = fs.statSync(canonical);
    return expected === "file" ? metadata.isFile() : metadata.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Transition admission is intentionally a bounded structural check. The
 * package resolver still performs the signed-manifest/integrity validation;
 * startup only needs to avoid selecting a missing or obviously corrupt pack.
 */
function isUsablePackageRoot(
  root: string,
  descriptor: ToolchainCatalogEntry,
  kind: ToolchainKind,
  receiptRequired: boolean,
): boolean {
  const packagePath = path.join(root, descriptor.id);
  let packageRoot: string;
  try {
    const metadata = fs.lstatSync(packagePath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return false;
    packageRoot = fs.realpathSync(packagePath);
  } catch {
    return false;
  }
  const entrypoint = descriptor.entrypoints.find(
    (candidate) => candidate.kind === kind,
  );
  if (
    !entrypoint
    || !isRegularPackagePath(
      packageRoot,
      entrypoint.executableRelativePath,
      "file",
    )
  ) {
    return false;
  }

  const receiptPath = path.join(packageRoot, ".judgedesk-package.json");
  if (!fs.existsSync(receiptPath)) return !receiptRequired;
  try {
    const bytes = fs.readFileSync(receiptPath);
    if (bytes.byteLength === 0 || bytes.byteLength > 16 * 1024) return false;
    const receipt = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    const blueprint = TOOLCHAIN_RELEASE_BLUEPRINTS[descriptor.id];
    if (
      !blueprint
      || receipt.schemaVersion !== 1
      || receipt.packageId !== descriptor.id
      || receipt.version !== blueprint.version
      || typeof receipt.archiveSha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(receipt.archiveSha256)
      || receipt.entrypointComponentId !== blueprint.entrypointComponentId
      || JSON.stringify(receipt.components) !== JSON.stringify(blueprint.components)
    ) {
      return false;
    }
    return blueprint.components.every((component) =>
      isRegularPackagePath(
        packageRoot,
        component.relativePath,
        component.kind === "executable" ? "file" : "directory",
      )
    );
  } catch {
    return false;
  }
}

function isBuiltInManagedPackageAvailable(kind: ToolchainKind): boolean {
  const descriptor = getDescriptorForHost(os.platform(), os.arch(), kind);
  return !!descriptor
    && isUsablePackageRoot(builtInToolchainsRoot(), descriptor, kind, true);
}

function isAnyManagedPackageAvailable(kind: ToolchainKind): boolean {
  const descriptor = getDescriptorForHost(os.platform(), os.arch(), kind);
  if (!descriptor) return false;
  return isUsablePackageRoot(
    builtInToolchainsRoot(),
    descriptor,
    kind,
    true,
  ) || isUsablePackageRoot(
    getDownloadedToolchainsDir(),
    descriptor,
    kind,
    false,
  );
}

export function createInitialToolchainPreferences(): ToolchainPreferencesV2 {
  const profiles: Record<string, StoredProfileToolchainPreference> = {};
  const distribution = getJudgeDeskDistribution();
  for (const entry of listRegisteredLanguageProfiles()) {
    const builtInManagedAvailable = isBuiltInManagedPackageAvailable(
      entry.toolchainKind,
    );
    profiles[entry.profile.ref.id] = {
      mode:
        distribution === "full"
        && entry.profile.stability === "stable"
        && builtInManagedAvailable
          ? "managed"
          : entry.freshInstallMode,
    };
  }
  return { schemaVersion: 2, profiles };
}

function addMissingRegisteredProfilePreferences(
  preferences: ToolchainPreferencesV2,
): {
  preferences: ToolchainPreferencesV2;
  changed: boolean;
} {
  const defaults = createInitialToolchainPreferences();
  const profiles = { ...preferences.profiles };
  let changed = false;
  for (const entry of listRegisteredLanguageProfiles()) {
    const profileId = entry.profile.ref.id;
    if (Object.hasOwn(profiles, profileId)) continue;
    profiles[profileId] = defaults.profiles[profileId] || { mode: "none" };
    changed = true;
  }
  if (!changed) return { preferences, changed: false };
  return {
    preferences: {
      ...preferences,
      profiles,
    },
    changed: true,
  };
}

/**
 * The first internal Windows Full candidate initialized the newly registered
 * profiles with the Judger-only defaults before the Full distribution policy
 * was applied. That candidate also migrated the legacy installed-toolchain
 * hint, which gives us a narrow, one-time fingerprint for repairing its saved
 * document without treating an ordinary None/auto-detect choice as implicit
 * consent to change sources.
 */
function migrateMaterializedBrokenWindowsFullDefaults(
  preferences: ToolchainPreferencesV2,
): {
  preferences: ToolchainPreferencesV2;
  changed: boolean;
} {
  if (
    getJudgeDeskDistribution() !== "full"
    || os.platform() !== "win32"
    || os.arch() !== "x64"
  ) {
    return { preferences, changed: false };
  }

  const diagnostics = preferences.migrationDiagnostics;
  if (
    diagnostics?.length !== 1
    || diagnostics[0]?.code !== "LEGACY_INSTALLED_HINT_IGNORED"
  ) {
    return { preferences, changed: false };
  }

  const fingerprint = new Map<LanguageProfileId, StoredProfileToolchainPreference["mode"]>([
    [CPP_LANGUAGE_PROFILE_ID, "managed"],
    [PYTHON_LANGUAGE_PROFILE_ID, "managed"],
    [C_LANGUAGE_PROFILE_ID, "local_auto"],
    [PASCAL_LANGUAGE_PROFILE_ID, "none"],
    [JAVA_LANGUAGE_PROFILE_ID, "none"],
  ]);
  const storedProfileIds = Object.keys(preferences.profiles);
  if (
    storedProfileIds.length !== fingerprint.size
    || storedProfileIds.some((profileId) => !fingerprint.has(profileId))
  ) {
    return { preferences, changed: false };
  }
  for (const [profileId, expectedMode] of fingerprint) {
    const preference = preferences.profiles[profileId];
    if (
      !preference
      || preference.mode !== expectedMode
      || preference.localPath !== undefined
    ) {
      return { preferences, changed: false };
    }
  }

  const defaults = createInitialToolchainPreferences();
  const profiles = { ...preferences.profiles };
  for (const profileId of fingerprint.keys()) {
    const preference = defaults.profiles[profileId];
    if (!preference || preference.mode !== "managed") {
      return { preferences, changed: false };
    }
    profiles[profileId] = preference;
  }
  return {
    preferences: {
      schemaVersion: 2,
      profiles,
    },
    changed: true,
  };
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

function atomicWritePrivateFile(filePath: string, contents: string | Buffer): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, filePath);
    syncDirectory(directory);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporaryPath, { force: true });
  }
}

function parseDistributionState(bytes: Buffer): DistributionStateV1 | null {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_DISTRIBUTION_STATE_BYTES) {
    return null;
  }
  try {
    const value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    if (
      !value
      || typeof value !== "object"
      || Array.isArray(value)
      || Object.keys(value).some((key) => ![
        "schemaVersion",
        "lastDistribution",
        "autoConfiguredRevision",
      ].includes(key))
      || value.schemaVersion !== DISTRIBUTION_STATE_SCHEMA_VERSION
      || !["full", "core", "development"].includes(
        String(value.lastDistribution),
      )
      || typeof value.autoConfiguredRevision !== "number"
      || !Number.isSafeInteger(value.autoConfiguredRevision)
      || value.autoConfiguredRevision < 0
      || value.autoConfiguredRevision > DISTRIBUTION_AUTOCONFIG_REVISION
    ) {
      return null;
    }
    return value as unknown as DistributionStateV1;
  } catch {
    return null;
  }
}

function readDistributionState(): {
  status: "missing" | "ready" | "invalid";
  state?: DistributionStateV1;
} {
  try {
    const bytes = fs.readFileSync(getToolchainDistributionStateFilePath());
    const state = parseDistributionState(bytes);
    return state ? { status: "ready", state } : { status: "invalid" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing" };
    }
    return { status: "invalid" };
  }
}

function writeDistributionState(
  distribution: PersistedDistribution,
  autoConfiguredRevision: number,
): void {
  const state: DistributionStateV1 = {
    schemaVersion: 1,
    lastDistribution: distribution,
    autoConfiguredRevision,
  };
  atomicWritePrivateFile(
    getToolchainDistributionStateFilePath(),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

function quarantineInvalidStateFile(filePath: string): void {
  try {
    const bytes = fs.readFileSync(filePath);
    const quarantine = `${filePath}.invalid.${Date.now()}.${crypto.randomUUID()}`;
    atomicWritePrivateFile(quarantine, bytes);
    fs.rmSync(filePath, { force: true });
  } catch {
    // Recovery must preserve preferences even when diagnostics cannot be copied.
  }
}

function parseDistributionTransition(
  bytes: Buffer,
): DistributionTransitionV1 | null {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_DISTRIBUTION_STATE_BYTES) {
    return null;
  }
  try {
    const value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    if (
      !value
      || typeof value !== "object"
      || Array.isArray(value)
      || Object.keys(value).some((key) => ![
        "schemaVersion",
        "fromDistribution",
        "toDistribution",
        "beforeRevision",
        "afterRevision",
        "backupFile",
        "targetPreferences",
      ].includes(key))
      || value.schemaVersion !== DISTRIBUTION_TRANSITION_SCHEMA_VERSION
      || !["full", "core", "development", "unknown"].includes(
        String(value.fromDistribution),
      )
      || !["full", "core", "development"].includes(
        String(value.toDistribution),
      )
      || typeof value.beforeRevision !== "string"
      || typeof value.afterRevision !== "string"
      || typeof value.backupFile !== "string"
      || path.basename(value.backupFile) !== value.backupFile
    ) {
      return null;
    }
    const decoded = decodeAndMigrateToolchainPreferences(
      value.targetPreferences,
      LEGACY_PROFILE_MAPPING,
    );
    if (decoded.status !== "ready-v2") return null;
    if (contentRevision(Buffer.from(decoded.canonicalJson, "utf8"))
      !== value.afterRevision) {
      return null;
    }
    return {
      schemaVersion: 1,
      fromDistribution: value.fromDistribution as DistributionTransitionV1["fromDistribution"],
      toDistribution: value.toDistribution as PersistedDistribution,
      beforeRevision: value.beforeRevision,
      afterRevision: value.afterRevision,
      backupFile: value.backupFile,
      targetPreferences: decoded.preferences,
    };
  } catch {
    return null;
  }
}

function recoverPendingDistributionTransition(
  snapshot: ToolchainPreferenceSnapshot,
): ToolchainPreferenceSnapshot | null {
  const transitionPath = getToolchainDistributionTransitionFilePath();
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(transitionPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return snapshot;
  }
  const transition = parseDistributionTransition(bytes);
  if (!transition) {
    quarantineInvalidStateFile(transitionPath);
    const distribution = getJudgeDeskDistribution();
    writeDistributionState(
      distribution,
      distribution === "full" ? DISTRIBUTION_AUTOCONFIG_REVISION : 0,
    );
    return snapshot;
  }

  let recovered = snapshot;
  if (snapshot.revision === transition.beforeRevision) {
    const canonicalJson = encodeToolchainPreferencesV2(
      transition.targetPreferences,
      LEGACY_PROFILE_MAPPING,
    );
    const revision = writeCanonicalPreferences(
      canonicalJson,
      transition.beforeRevision,
    );
    recovered = {
      preferences: transition.targetPreferences,
      revision,
      status: "migrated",
      recoveryDiagnostics: [],
    };
  } else if (snapshot.revision !== transition.afterRevision) {
    // A concurrent/manual preference edit is more valuable than replaying an
    // uncertain startup transaction. Preserve it and quarantine the journal.
    quarantineInvalidStateFile(transitionPath);
    const distribution = getJudgeDeskDistribution();
    writeDistributionState(
      distribution,
      distribution === "full" ? DISTRIBUTION_AUTOCONFIG_REVISION : 0,
    );
    return snapshot;
  }

  writeDistributionState(
    transition.toDistribution,
    transition.toDistribution === "full"
      ? DISTRIBUTION_AUTOCONFIG_REVISION
      : readDistributionState().state?.autoConfiguredRevision ?? 0,
  );
  fs.rmSync(transitionPath, { force: true });
  syncDirectory(path.dirname(transitionPath));
  return recovered;
}

function preferencesForDistributionTransition(
  preferences: ToolchainPreferencesV2,
  distribution: PersistedDistribution,
  previous: DistributionStateV1 | undefined,
): ToolchainPreferencesV2 {
  const profiles = { ...preferences.profiles };
  let changed = false;
  const enteringFull = distribution === "full"
    && (
      previous?.lastDistribution !== "full"
      || previous.autoConfiguredRevision < DISTRIBUTION_AUTOCONFIG_REVISION
    );
  const enteringCore = distribution === "core"
    && previous?.lastDistribution !== "core";

  if (enteringFull) {
    for (const entry of listRegisteredLanguageProfiles()) {
      if (
        entry.profile.stability !== "stable"
        || !isBuiltInManagedPackageAvailable(entry.toolchainKind)
      ) {
        continue;
      }
      const current = getStoredProfilePreference(
        preferences,
        entry.profile.ref.id,
      );
      const next = current.localPath
        ? { mode: "managed" as const, localPath: current.localPath }
        : { mode: "managed" as const };
      if (JSON.stringify(current) !== JSON.stringify(next)) {
        profiles[entry.profile.ref.id] = next;
        changed = true;
      }
    }
  } else if (enteringCore) {
    for (const entry of listRegisteredLanguageProfiles()) {
      const current = getStoredProfilePreference(
        preferences,
        entry.profile.ref.id,
      );
      if (
        current.mode !== "managed"
        || isAnyManagedPackageAvailable(entry.toolchainKind)
      ) {
        continue;
      }
      const next = current.localPath
        ? { mode: entry.freshInstallMode, localPath: current.localPath }
        : { mode: entry.freshInstallMode };
      profiles[entry.profile.ref.id] = next;
      changed = true;
    }
  }

  return changed ? { ...preferences, profiles } : preferences;
}

function applyDistributionTransition(
  snapshot: ToolchainPreferenceSnapshot,
): ToolchainPreferenceSnapshot {
  const pending = recoverPendingDistributionTransition(snapshot);
  // Recovery may finish a transition created by a different edition than the
  // one now launching (for example Full crashed, then Core was restored).
  // Continue from the recovered bytes so this launch also reaches the current
  // distribution's final state instead of exposing an intermediate profile.
  const currentSnapshot = pending || snapshot;

  const distribution = getJudgeDeskDistribution();
  const storedState = readDistributionState();
  if (storedState.status === "invalid") {
    quarantineInvalidStateFile(getToolchainDistributionStateFilePath());
    writeDistributionState(
      distribution,
      distribution === "full" ? DISTRIBUTION_AUTOCONFIG_REVISION : 0,
    );
    return currentSnapshot;
  }

  const previous = storedState.state;
  const target = preferencesForDistributionTransition(
    currentSnapshot.preferences,
    distribution,
    previous,
  );
  const canonicalTarget = encodeToolchainPreferencesV2(
    target,
    LEGACY_PROFILE_MAPPING,
  );
  const afterRevision = contentRevision(Buffer.from(canonicalTarget, "utf8"));
  if (afterRevision === currentSnapshot.revision) {
    const autoRevision = distribution === "full"
      ? DISTRIBUTION_AUTOCONFIG_REVISION
      : previous?.autoConfiguredRevision ?? 0;
    if (
      storedState.status !== "ready"
      || previous?.lastDistribution !== distribution
      || previous.autoConfiguredRevision !== autoRevision
    ) {
      writeDistributionState(distribution, autoRevision);
    }
    return currentSnapshot;
  }

  const preferenceBytes = readPreferenceBytes(getPreferencesFilePath());
  if (!preferenceBytes || contentRevision(preferenceBytes) !== currentSnapshot.revision) {
    throw new ToolchainPreferenceConflictError();
  }
  const backupDirectory = path.join(
    getAppDataDir(),
    "toolchain-distribution-backups",
  );
  const backupFile = `toolchains.${Date.now()}.${currentSnapshot.revision.slice(0, 12)}.json`;
  atomicWritePrivateFile(path.join(backupDirectory, backupFile), preferenceBytes);
  const transition: DistributionTransitionV1 = {
    schemaVersion: 1,
    fromDistribution: previous?.lastDistribution ?? "unknown",
    toDistribution: distribution,
    beforeRevision: currentSnapshot.revision,
    afterRevision,
    backupFile,
    targetPreferences: target,
  };
  atomicWritePrivateFile(
    getToolchainDistributionTransitionFilePath(),
    `${JSON.stringify(transition, null, 2)}\n`,
  );
  const revision = writeCanonicalPreferences(canonicalTarget, currentSnapshot.revision);
  if (distributionTransitionFailureForTests === "after-preferences") {
    throw new Error("SIMULATED_DISTRIBUTION_TRANSITION_INTERRUPTION");
  }
  writeDistributionState(
    distribution,
    distribution === "full"
      ? DISTRIBUTION_AUTOCONFIG_REVISION
      : previous?.autoConfiguredRevision ?? 0,
  );
  fs.rmSync(getToolchainDistributionTransitionFilePath(), { force: true });
  syncDirectory(getAppDataDir());
  return {
    preferences: target,
    revision,
    status: "migrated",
    recoveryDiagnostics: [],
  };
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
    return applyDistributionTransition({
      preferences,
      revision,
      status: "initialized",
      recoveryDiagnostics: [],
    });
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

  const completed = addMissingRegisteredProfilePreferences(decoded.preferences);
  const repaired = migrateMaterializedBrokenWindowsFullDefaults(
    completed.preferences,
  );
  if (
    decoded.status === "migrated-v1"
    || completed.changed
    || repaired.changed
  ) {
    const canonicalJson = encodeToolchainPreferencesV2(
      repaired.preferences,
      LEGACY_PROFILE_MAPPING,
    );
    const revision = writeCanonicalPreferences(
      canonicalJson,
      contentRevision(bytes),
    );
    return applyDistributionTransition({
      preferences: repaired.preferences,
      revision,
      status: "migrated",
      recoveryDiagnostics: [],
    });
  }

  return applyDistributionTransition({
    preferences: repaired.preferences,
    revision: contentRevision(bytes),
    status: "ready",
    recoveryDiagnostics: [],
  });
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
