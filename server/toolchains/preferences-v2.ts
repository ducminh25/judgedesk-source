import { TextDecoder } from "node:util";
import { isLanguageProfileId } from "../languages/contracts.js";
import type {
  LanguageProfileId,
  StoredProfileToolchainPreference,
  ToolchainSourceMode,
  ToolchainSourceSelection,
} from "../languages/contracts.js";

const MAX_PROFILE_COUNT = 256;
const MAX_DIAGNOSTIC_COUNT = 256;
const MAX_LOCAL_PATH_LENGTH = 32_768;
export const MAX_TOOLCHAIN_PREFERENCES_BYTES = 1024 * 1024;

const LEGACY_KEYS = new Set([
  "customCppPath",
  "customPythonPath",
  "preferredSourceCpp",
  "preferredSourcePython",
  "installedToolchains",
]);

const SOURCE_MODES = new Set<ToolchainSourceMode>([
  "none",
  "managed",
  "local_path",
  "local_auto",
]);

export interface LegacyProfileMapping {
  cpp: LanguageProfileId;
  python: LanguageProfileId;
}

export type ToolchainMigrationDiagnosticCode =
  | "LEGACY_SOURCE_MISSING"
  | "LEGACY_SOURCE_INVALID"
  | "LEGACY_LOCAL_PATH_REQUIRED"
  | "LEGACY_LOCAL_PATH_INVALID"
  | "LEGACY_INSTALLED_HINT_IGNORED";

export type ToolchainPreferenceRecoveryCode =
  | "INVALID_JSON"
  | "INVALID_UTF8"
  | "INVALID_V2_DOCUMENT"
  | "UNSUPPORTED_SCHEMA_VERSION"
  | "PREFERENCES_TOO_LARGE";

export type ToolchainPreferenceDiagnosticField =
  | "source"
  | "localPath"
  | "installedToolchains";

export type ToolchainMigrationDiagnostic =
  | {
      code: "LEGACY_SOURCE_MISSING" | "LEGACY_SOURCE_INVALID";
      profileId: LanguageProfileId;
      field: "source";
    }
  | {
      code: "LEGACY_LOCAL_PATH_REQUIRED" | "LEGACY_LOCAL_PATH_INVALID";
      profileId: LanguageProfileId;
      field: "localPath";
    }
  | {
      code: "LEGACY_INSTALLED_HINT_IGNORED";
      field: "installedToolchains";
    };

export interface ToolchainPreferenceRecoveryDiagnostic {
  code: ToolchainPreferenceRecoveryCode;
  field: "document";
}

export interface ToolchainPreferencesV2 {
  schemaVersion: 2;
  profiles: Readonly<
    Record<LanguageProfileId, StoredProfileToolchainPreference | undefined>
  >;
  migrationDiagnostics?: readonly ToolchainMigrationDiagnostic[];
}

interface ReadyV2PreferenceDecode {
  status: "ready-v2";
  preferences: ToolchainPreferencesV2;
  canonicalJson: string;
  migrationWriteRequired: false;
}

interface MigratedV1PreferenceDecode {
  status: "migrated-v1";
  preferences: ToolchainPreferencesV2;
  canonicalJson: string;
  migrationWriteRequired: true;
}

interface FailedPreferenceDecode {
  status: "invalid" | "unsupported-version";
  preferences: ToolchainPreferencesV2;
  diagnostics: readonly ToolchainPreferenceRecoveryDiagnostic[];
  migrationWriteRequired: false;
}

export type ToolchainPreferenceDecodeResult =
  | ReadyV2PreferenceDecode
  | MigratedV1PreferenceDecode
  | FailedPreferenceDecode;

export type StoredSelectionResolution =
  | { ok: true; selection: ToolchainSourceSelection }
  | {
      ok: false;
      mode: "local_path";
      diagnostic: "LOCAL_PATH_REQUIRED";
    };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isValidLocalPath(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= MAX_LOCAL_PATH_LENGTH
    && value.trim().length > 0
    && !value.includes("\0")
    && isWellFormedUtf16(value);
}

function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (!(nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function assertValidMapping(mapping: LegacyProfileMapping): void {
  if (
    !isLanguageProfileId(mapping.cpp)
    || !isLanguageProfileId(mapping.python)
    || mapping.cpp === mapping.python
  ) {
    throw new Error("Legacy profile mapping must contain two distinct valid profile IDs.");
  }
}

function createFailClosedPreferences(
  mapping: LegacyProfileMapping,
): ToolchainPreferencesV2 {
  return {
    schemaVersion: 2,
    profiles: {
      [mapping.cpp]: { mode: "none" },
      [mapping.python]: { mode: "none" },
    },
  };
}

function createFailedDecode(
  mapping: LegacyProfileMapping,
  status: FailedPreferenceDecode["status"],
  code: ToolchainPreferenceRecoveryCode,
): FailedPreferenceDecode {
  return {
    status,
    preferences: createFailClosedPreferences(mapping),
    diagnostics: [{ code, field: "document" }],
    migrationWriteRequired: false,
  };
}

function getOwnValue(
  record: Record<string, unknown>,
  key: string,
): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function diagnosticKey(diagnostic: ToolchainMigrationDiagnostic): string {
  return [
    diagnostic.code,
    "profileId" in diagnostic ? diagnostic.profileId : "",
    diagnostic.field,
  ].join("\0");
}

function normalizeDiagnostics(
  diagnostics: readonly ToolchainMigrationDiagnostic[],
): readonly ToolchainMigrationDiagnostic[] {
  const unique = new Map<string, ToolchainMigrationDiagnostic>();
  for (const diagnostic of diagnostics) {
    unique.set(diagnosticKey(diagnostic), diagnostic);
  }
  return [...unique.values()].sort((left, right) => {
    const leftKey = diagnosticKey(left);
    const rightKey = diagnosticKey(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function canonicalizePreferences(
  preferences: ToolchainPreferencesV2,
  mapping: LegacyProfileMapping,
): string {
  const orderedIds = [
    mapping.cpp,
    mapping.python,
    ...Object.keys(preferences.profiles)
      .filter((profileId) => profileId !== mapping.cpp && profileId !== mapping.python)
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
  ];
  const profiles: Record<string, StoredProfileToolchainPreference> = {};
  for (const profileId of orderedIds) {
    const preference = Object.hasOwn(preferences.profiles, profileId)
      ? preferences.profiles[profileId]
      : undefined;
    if (!preference) continue;
    profiles[profileId] = preference.localPath === undefined
      ? { mode: preference.mode }
      : { mode: preference.mode, localPath: preference.localPath };
  }

  const diagnostics = preferences.migrationDiagnostics
    ? normalizeDiagnostics(preferences.migrationDiagnostics)
    : [];
  const canonical: ToolchainPreferencesV2 = {
    schemaVersion: 2,
    profiles,
    ...(diagnostics.length > 0 ? { migrationDiagnostics: diagnostics } : {}),
  };
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

function parseStoredProfilePreference(
  value: unknown,
): StoredProfileToolchainPreference | null {
  if (!isPlainRecord(value)) return null;
  if (Object.keys(value).some((key) => key !== "mode" && key !== "localPath")) {
    return null;
  }
  const mode = getOwnValue(value, "mode");
  if (typeof mode !== "string" || !SOURCE_MODES.has(mode as ToolchainSourceMode)) {
    return null;
  }
  const localPath = getOwnValue(value, "localPath");
  if (localPath === undefined) {
    return { mode: mode as ToolchainSourceMode };
  }
  if (!isValidLocalPath(localPath)) return null;
  return { mode: mode as ToolchainSourceMode, localPath };
}

function isDiagnosticCode(value: unknown): value is ToolchainMigrationDiagnosticCode {
  return typeof value === "string" && [
    "LEGACY_SOURCE_MISSING",
    "LEGACY_SOURCE_INVALID",
    "LEGACY_LOCAL_PATH_REQUIRED",
    "LEGACY_LOCAL_PATH_INVALID",
    "LEGACY_INSTALLED_HINT_IGNORED",
  ].includes(value);
}

function isDiagnosticField(value: unknown): value is ToolchainPreferenceDiagnosticField {
  return typeof value === "string" && [
    "source",
    "localPath",
    "installedToolchains",
  ].includes(value);
}

function parseStoredDiagnostics(
  value: unknown,
): readonly ToolchainMigrationDiagnostic[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_DIAGNOSTIC_COUNT) return null;
  const diagnostics: ToolchainMigrationDiagnostic[] = [];
  for (const candidate of value) {
    if (!isPlainRecord(candidate)) return null;
    if (Object.keys(candidate).some((key) => !["code", "profileId", "field"].includes(key))) {
      return null;
    }
    const code = getOwnValue(candidate, "code");
    const profileId = getOwnValue(candidate, "profileId");
    const field = getOwnValue(candidate, "field");
    if (!isDiagnosticCode(code)) return null;
    let parsedProfileId: LanguageProfileId | undefined;
    if (profileId !== undefined) {
      if (!isLanguageProfileId(profileId)) return null;
      parsedProfileId = profileId;
    }
    if (!isDiagnosticField(field)) return null;
    if (code === "LEGACY_INSTALLED_HINT_IGNORED") {
      if (parsedProfileId !== undefined || field !== "installedToolchains") {
        return null;
      }
      diagnostics.push({ code, field });
      continue;
    }
    if (parsedProfileId === undefined) return null;
    if (code === "LEGACY_SOURCE_MISSING" || code === "LEGACY_SOURCE_INVALID") {
      if (field !== "source") return null;
      diagnostics.push({ code, profileId: parsedProfileId, field });
      continue;
    }
    if (field !== "localPath") return null;
    diagnostics.push({ code, profileId: parsedProfileId, field });
  }
  return normalizeDiagnostics(diagnostics);
}

function parseV2Preferences(
  raw: Record<string, unknown>,
): ToolchainPreferencesV2 | null {
  if (Object.keys(raw).some((key) => !["schemaVersion", "profiles", "migrationDiagnostics"].includes(key))) {
    return null;
  }
  const schemaVersion = getOwnValue(raw, "schemaVersion");
  const storedProfiles = getOwnValue(raw, "profiles");
  if (schemaVersion !== 2 || !isPlainRecord(storedProfiles)) return null;
  const profileEntries = Object.entries(storedProfiles);
  if (profileEntries.length > MAX_PROFILE_COUNT) return null;

  const profiles: Record<string, StoredProfileToolchainPreference> = {};
  for (const [profileId, value] of profileEntries) {
    if (!isLanguageProfileId(profileId)) return null;
    const preference = parseStoredProfilePreference(value);
    if (!preference) return null;
    profiles[profileId] = preference;
  }
  const diagnostics = parseStoredDiagnostics(
    getOwnValue(raw, "migrationDiagnostics"),
  );
  if (!diagnostics) return null;
  return {
    schemaVersion: 2,
    profiles,
    ...(diagnostics.length > 0 ? { migrationDiagnostics: diagnostics } : {}),
  };
}

function migrateLegacyProfile(
  raw: Record<string, unknown>,
  profileId: LanguageProfileId,
  sourceKey: "preferredSourceCpp" | "preferredSourcePython",
  pathKey: "customCppPath" | "customPythonPath",
): {
  preference: StoredProfileToolchainPreference;
  diagnostics: ToolchainMigrationDiagnostic[];
} {
  const diagnostics: ToolchainMigrationDiagnostic[] = [];
  const source = getOwnValue(raw, sourceKey);
  const storedPath = getOwnValue(raw, pathKey);
  const localPath = isValidLocalPath(storedPath) ? storedPath : undefined;
  const localPathIsBlank = typeof storedPath === "string"
    && storedPath.trim().length === 0;

  if (
    storedPath !== undefined
    && localPath === undefined
    && !(source === "custom" && localPathIsBlank)
  ) {
    diagnostics.push({
      code: "LEGACY_LOCAL_PATH_INVALID",
      profileId,
      field: "localPath",
    });
  }

  let mode: ToolchainSourceMode;
  if (source === "managed") mode = "managed";
  else if (source === "system") mode = "local_auto";
  else if (source === "custom") {
    mode = "local_path";
    if (storedPath === undefined || localPathIsBlank) {
      diagnostics.push({
        code: "LEGACY_LOCAL_PATH_REQUIRED",
        profileId,
        field: "localPath",
      });
    }
  } else if (source === undefined) {
    mode = "none";
    diagnostics.push({
      code: "LEGACY_SOURCE_MISSING",
      profileId,
      field: "source",
    });
  } else {
    mode = "none";
    diagnostics.push({
      code: "LEGACY_SOURCE_INVALID",
      profileId,
      field: "source",
    });
  }

  return {
    preference: localPath === undefined ? { mode } : { mode, localPath },
    diagnostics,
  };
}

function migrateLegacyPreferences(
  raw: Record<string, unknown>,
  mapping: LegacyProfileMapping,
): ToolchainPreferencesV2 {
  const cpp = migrateLegacyProfile(
    raw,
    mapping.cpp,
    "preferredSourceCpp",
    "customCppPath",
  );
  const python = migrateLegacyProfile(
    raw,
    mapping.python,
    "preferredSourcePython",
    "customPythonPath",
  );
  const diagnostics = [...cpp.diagnostics, ...python.diagnostics];
  const installedToolchains = getOwnValue(raw, "installedToolchains");
  if (
    installedToolchains !== undefined
    && (!Array.isArray(installedToolchains) || installedToolchains.length > 0)
  ) {
    diagnostics.push({
      code: "LEGACY_INSTALLED_HINT_IGNORED",
      field: "installedToolchains",
    });
  }
  const normalizedDiagnostics = normalizeDiagnostics(diagnostics);
  return {
    schemaVersion: 2,
    profiles: {
      [mapping.cpp]: cpp.preference,
      [mapping.python]: python.preference,
    },
    ...(normalizedDiagnostics.length > 0
      ? { migrationDiagnostics: normalizedDiagnostics }
      : {}),
  };
}

function isStrictLegacyPreferences(
  raw: Record<string, unknown>,
): boolean {
  const keys = Object.keys(raw);
  return keys.length > 0 && keys.every((key) => LEGACY_KEYS.has(key));
}

export function decodeAndMigrateToolchainPreferences(
  raw: unknown,
  mapping: LegacyProfileMapping,
): ToolchainPreferenceDecodeResult {
  assertValidMapping(mapping);
  if (!isPlainRecord(raw)) {
    return createFailedDecode(mapping, "invalid", "INVALID_V2_DOCUMENT");
  }

  if (Object.hasOwn(raw, "schemaVersion")) {
    if (getOwnValue(raw, "schemaVersion") !== 2) {
      return createFailedDecode(
        mapping,
        "unsupported-version",
        "UNSUPPORTED_SCHEMA_VERSION",
      );
    }
    const preferences = parseV2Preferences(raw);
    if (!preferences) {
      return createFailedDecode(mapping, "invalid", "INVALID_V2_DOCUMENT");
    }
    const canonicalJson = canonicalizePreferences(preferences, mapping);
    if (Buffer.byteLength(canonicalJson, "utf8") > MAX_TOOLCHAIN_PREFERENCES_BYTES) {
      return createFailedDecode(mapping, "invalid", "PREFERENCES_TOO_LARGE");
    }
    return {
      status: "ready-v2",
      preferences,
      canonicalJson,
      migrationWriteRequired: false,
    };
  }

  if (!isStrictLegacyPreferences(raw)) {
    return createFailedDecode(mapping, "invalid", "INVALID_V2_DOCUMENT");
  }

  const preferences = migrateLegacyPreferences(raw, mapping);
  const canonicalJson = canonicalizePreferences(preferences, mapping);
  if (Buffer.byteLength(canonicalJson, "utf8") > MAX_TOOLCHAIN_PREFERENCES_BYTES) {
    return createFailedDecode(mapping, "invalid", "PREFERENCES_TOO_LARGE");
  }
  return {
    status: "migrated-v1",
    preferences,
    canonicalJson,
    migrationWriteRequired: true,
  };
}

function decodeToolchainPreferencesJson(
  rawJson: string,
  mapping: LegacyProfileMapping,
): ToolchainPreferenceDecodeResult {
  assertValidMapping(mapping);
  if (Buffer.byteLength(rawJson, "utf8") > MAX_TOOLCHAIN_PREFERENCES_BYTES) {
    return createFailedDecode(mapping, "invalid", "PREFERENCES_TOO_LARGE");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(rawJson) as unknown;
  } catch {
    return createFailedDecode(mapping, "invalid", "INVALID_JSON");
  }
  return decodeAndMigrateToolchainPreferences(raw, mapping);
}

/** Storage boundaries must pass raw bytes so malformed UTF-8 cannot be repaired. */
export function decodeToolchainPreferencesBytes(
  rawBytes: Uint8Array,
  mapping: LegacyProfileMapping,
): ToolchainPreferenceDecodeResult {
  assertValidMapping(mapping);
  if (rawBytes.byteLength > MAX_TOOLCHAIN_PREFERENCES_BYTES) {
    return createFailedDecode(mapping, "invalid", "PREFERENCES_TOO_LARGE");
  }

  let rawJson: string;
  try {
    rawJson = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
  } catch {
    return createFailedDecode(mapping, "invalid", "INVALID_UTF8");
  }
  return decodeToolchainPreferencesJson(rawJson, mapping);
}

export function getStoredProfilePreference(
  preferences: ToolchainPreferencesV2,
  profileId: LanguageProfileId,
): StoredProfileToolchainPreference {
  return Object.hasOwn(preferences.profiles, profileId)
    ? preferences.profiles[profileId] || { mode: "none" }
    : { mode: "none" };
}

export function resolveStoredToolchainSelection(
  preference: StoredProfileToolchainPreference,
): StoredSelectionResolution {
  if (preference.mode === "local_path") {
    if (!isValidLocalPath(preference.localPath)) {
      return {
        ok: false,
        mode: "local_path",
        diagnostic: "LOCAL_PATH_REQUIRED",
      };
    }
    return {
      ok: true,
      selection: { mode: "local_path", path: preference.localPath },
    };
  }
  return { ok: true, selection: { mode: preference.mode } };
}
