import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeAndMigrateToolchainPreferences,
  decodeToolchainPreferencesBytes,
  getStoredProfilePreference,
  MAX_TOOLCHAIN_PREFERENCES_BYTES,
  resolveStoredToolchainSelection,
  type LegacyProfileMapping,
} from "./preferences-v2.js";

const mapping = {
  cpp: "cpp14",
  python: "python312",
} satisfies LegacyProfileMapping;

test("migration maps legacy sources and preserves dormant local paths", () => {
  const result = decodeAndMigrateToolchainPreferences({
    preferredSourceCpp: "managed",
    customCppPath: String.raw`C:\remembered\g++.exe`,
    preferredSourcePython: "system",
    customPythonPath: String.raw`C:\remembered\python.exe`,
  }, mapping);

  assert.equal(result.status, "migrated-v1");
  assert.equal(result.migrationWriteRequired, true);
  assert.deepEqual(result.preferences.profiles.cpp14, {
    mode: "managed",
    localPath: String.raw`C:\remembered\g++.exe`,
  });
  assert.deepEqual(result.preferences.profiles.python312, {
    mode: "local_auto",
    localPath: String.raw`C:\remembered\python.exe`,
  });
});

test("migration activates valid custom paths without inspecting the filesystem", () => {
  const localPath = "D:\\Bộ dịch có khoảng trắng\\g++.exe";
  const result = decodeAndMigrateToolchainPreferences({
    preferredSourceCpp: "custom",
    customCppPath: localPath,
    preferredSourcePython: "managed",
  }, mapping);

  assert.equal(result.status, "migrated-v1");
  assert.deepEqual(result.preferences.profiles.cpp14, {
    mode: "local_path",
    localPath,
  });
  assert.deepEqual(
    resolveStoredToolchainSelection(result.preferences.profiles.cpp14!),
    { ok: true, selection: { mode: "local_path", path: localPath } },
  );
});

test("legacy installed hints never select or populate a managed package", () => {
  const result = decodeAndMigrateToolchainPreferences({
    preferredSourceCpp: "system",
    preferredSourcePython: "system",
    installedToolchains: ["gcc-windows-x64", "untrusted-package"],
  }, mapping);

  assert.equal(result.status, "migrated-v1");
  assert.deepEqual(result.preferences.profiles.cpp14, { mode: "local_auto" });
  assert.deepEqual(result.preferences.profiles.python312, { mode: "local_auto" });
  assert.equal("installedPackages" in result.preferences, false);
  assert.ok(result.preferences.migrationDiagnostics?.some(
    (diagnostic) => diagnostic.code === "LEGACY_INSTALLED_HINT_IGNORED",
  ));
});

test("migration ignores inherited legacy values", () => {
  const raw = new Proxy<Record<string, unknown>>(
    { installedToolchains: [] },
    {
      get(target, property, receiver) {
        if (property === "preferredSourceCpp") return "managed";
        if (property === "preferredSourcePython") return "system";
        if (property === "customCppPath") return String.raw`C:\inherited\g++.exe`;
        return Reflect.get(target, property, receiver);
      },
    },
  );
  const result = decodeAndMigrateToolchainPreferences(raw, mapping);

  assert.equal(result.status, "migrated-v1");
  assert.deepEqual(result.preferences.profiles.cpp14, { mode: "none" });
  assert.deepEqual(result.preferences.profiles.python312, { mode: "none" });
});

test("raw v2 decoding rejects inherited document, profile, and diagnostic fields", () => {
  const pollution = {
    profiles: Object.create(null),
    mode: "managed",
    code: "LEGACY_INSTALLED_HINT_IGNORED",
    field: "installedToolchains",
  } as const;
  const originalDescriptors = new Map<string, PropertyDescriptor | undefined>();

  try {
    for (const [key, value] of Object.entries(pollution)) {
      originalDescriptors.set(key, Object.getOwnPropertyDescriptor(Object.prototype, key));
      Object.defineProperty(Object.prototype, key, {
        configurable: true,
        enumerable: false,
        value,
        writable: true,
      });
    }

    for (const rawJson of [
      '{"schemaVersion":2}',
      '{"schemaVersion":2,"profiles":{"cpp14":{}}}',
      '{"schemaVersion":2,"profiles":{},"migrationDiagnostics":[{}]}',
    ]) {
      const result = decodeToolchainPreferencesBytes(Buffer.from(rawJson), mapping);
      assert.equal(result.status, "invalid");
      assert.equal(result.migrationWriteRequired, false);
    }
  } finally {
    for (const [key, descriptor] of originalDescriptors) {
      if (descriptor) Object.defineProperty(Object.prototype, key, descriptor);
      else Reflect.deleteProperty(Object.prototype, key);
    }
  }
});

test("malformed legacy profiles fail closed independently and retain recoverable paths", () => {
  const result = decodeAndMigrateToolchainPreferences({
    preferredSourceCpp: "unexpected",
    customCppPath: String.raw`C:\remembered\g++.exe`,
    preferredSourcePython: "custom",
  }, mapping);

  assert.equal(result.status, "migrated-v1");
  assert.deepEqual(result.preferences.profiles.cpp14, {
    mode: "none",
    localPath: String.raw`C:\remembered\g++.exe`,
  });
  assert.deepEqual(result.preferences.profiles.python312, {
    mode: "local_path",
  });
  assert.deepEqual(
    resolveStoredToolchainSelection(result.preferences.profiles.python312!),
    {
      ok: false,
      mode: "local_path",
      diagnostic: "LOCAL_PATH_REQUIRED",
    },
  );
  assert.ok(result.preferences.migrationDiagnostics?.some(
    (diagnostic) => diagnostic.code === "LEGACY_SOURCE_INVALID"
      && diagnostic.profileId === "cpp14",
  ));
  assert.ok(result.preferences.migrationDiagnostics?.some(
    (diagnostic) => diagnostic.code === "LEGACY_LOCAL_PATH_REQUIRED"
      && diagnostic.profileId === "python312",
  ));
});

test("invalid local paths are dropped without normalization or fallback", () => {
  const result = decodeAndMigrateToolchainPreferences({
    preferredSourceCpp: "custom",
    customCppPath: "bad\0path",
    preferredSourcePython: "managed",
    customPythonPath: "   ",
  }, mapping);

  assert.equal(result.status, "migrated-v1");
  assert.deepEqual(result.preferences.profiles.cpp14, { mode: "local_path" });
  assert.deepEqual(result.preferences.profiles.python312, { mode: "managed" });
  assert.equal(
    result.preferences.migrationDiagnostics?.filter(
      (diagnostic) => diagnostic.code === "LEGACY_LOCAL_PATH_INVALID",
    ).length,
    2,
  );
});

test("a blank active custom path keeps Local path intent and reports a required path", () => {
  const result = decodeAndMigrateToolchainPreferences({
    preferredSourceCpp: "custom",
    customCppPath: "   ",
    preferredSourcePython: "managed",
  }, mapping);

  assert.equal(result.status, "migrated-v1");
  assert.deepEqual(result.preferences.profiles.cpp14, { mode: "local_path" });
  assert.ok(result.preferences.migrationDiagnostics?.some(
    (diagnostic) => diagnostic.code === "LEGACY_LOCAL_PATH_REQUIRED"
      && diagnostic.profileId === "cpp14",
  ));
  assert.equal(result.preferences.migrationDiagnostics?.some(
    (diagnostic) => diagnostic.code === "LEGACY_LOCAL_PATH_INVALID"
      && diagnostic.profileId === "cpp14",
  ), false);
});

test("canonical migration is idempotent and diagnostics do not multiply", () => {
  const first = decodeAndMigrateToolchainPreferences({
    preferredSourceCpp: "custom",
    preferredSourcePython: "managed",
    installedToolchains: [],
  }, mapping);
  assert.equal(first.status, "migrated-v1");

  const second = decodeAndMigrateToolchainPreferences(
    JSON.parse(first.canonicalJson),
    mapping,
  );
  assert.equal(second.status, "ready-v2");
  assert.deepEqual(second.preferences, first.preferences);
  assert.equal(second.canonicalJson, first.canonicalJson);
  assert.equal(second.migrationWriteRequired, false);
});

test("invalid and future documents stay fail-closed and cannot be persisted", () => {
  for (const raw of [
    null,
    [],
    { schemaVersion: 2, profiles: { cpp14: { mode: "fallback" } } },
  ]) {
    const result = decodeAndMigrateToolchainPreferences(raw, mapping);
    assert.equal(result.status, "invalid");
    assert.equal(result.migrationWriteRequired, false);
    assert.deepEqual(result.preferences.profiles.cpp14, { mode: "none" });
    assert.deepEqual(result.preferences.profiles.python312, { mode: "none" });
  }

  const future = decodeAndMigrateToolchainPreferences({
    schemaVersion: 3,
    profiles: {},
  }, mapping);
  assert.equal(future.status, "unsupported-version");
  assert.equal(future.migrationWriteRequired, false);
});

test("objects without a strict legacy shape are never rewritten as v1", () => {
  for (const raw of [
    {},
    { profiles: {} },
    { futureField: true },
    { preferredSourceCpp: "system", futureField: true },
  ]) {
    const result = decodeAndMigrateToolchainPreferences(raw, mapping);
    assert.equal(result.status, "invalid");
    assert.equal(result.migrationWriteRequired, false);
    assert.deepEqual(result.diagnostics, [{
      code: "INVALID_V2_DOCUMENT",
      field: "document",
    }]);
  }
});

test("the JSON boundary rejects malformed and oversized documents before migration", () => {
  const malformed = decodeToolchainPreferencesBytes(Buffer.from("{"), mapping);
  assert.equal(malformed.status, "invalid");
  assert.equal(malformed.migrationWriteRequired, false);
  assert.deepEqual(malformed.diagnostics, [{
    code: "INVALID_JSON",
    field: "document",
  }]);

  const oversized = decodeToolchainPreferencesBytes(
    Buffer.alloc(MAX_TOOLCHAIN_PREFERENCES_BYTES + 1, 0x20),
    mapping,
  );
  assert.equal(oversized.status, "invalid");
  assert.equal(oversized.migrationWriteRequired, false);
  assert.deepEqual(oversized.diagnostics, [{
    code: "PREFERENCES_TOO_LARGE",
    field: "document",
  }]);

  const invalidUtf8 = decodeToolchainPreferencesBytes(
    Uint8Array.from([0xff]),
    mapping,
  );
  assert.equal(invalidUtf8.status, "invalid");
  assert.deepEqual(invalidUtf8.diagnostics, [{
    code: "INVALID_UTF8",
    field: "document",
  }]);

  const multibyteOversized = decodeToolchainPreferencesBytes(
    Buffer.from(`"${"é".repeat(MAX_TOOLCHAIN_PREFERENCES_BYTES / 2)}"`),
    mapping,
  );
  assert.equal(multibyteOversized.status, "invalid");
  assert.deepEqual(multibyteOversized.diagnostics, [{
    code: "PREFERENCES_TOO_LARGE",
    field: "document",
  }]);
});

test("canonical output cannot exceed the next-read byte limit", () => {
  const profiles: Record<string, { mode: "none"; localPath: string }> = {};
  for (let index = 0; index < 256; index += 1) {
    profiles[`profile-${index.toString().padStart(3, "0")}`] = {
      mode: "none",
      localPath: "x".repeat(4_000),
    };
  }
  let rawJson = JSON.stringify({ schemaVersion: 2, profiles });
  const remainingBytes = MAX_TOOLCHAIN_PREFERENCES_BYTES
    - Buffer.byteLength(rawJson, "utf8");
  assert.ok(remainingBytes > 0);
  profiles["profile-000"]!.localPath += "x".repeat(remainingBytes);
  rawJson = JSON.stringify({ schemaVersion: 2, profiles });
  assert.equal(Buffer.byteLength(rawJson, "utf8"), MAX_TOOLCHAIN_PREFERENCES_BYTES);

  const result = decodeToolchainPreferencesBytes(Buffer.from(rawJson), mapping);
  assert.equal(result.status, "invalid");
  assert.equal(result.migrationWriteRequired, false);
  assert.deepEqual(result.diagnostics, [{
    code: "PREFERENCES_TOO_LARGE",
    field: "document",
  }]);
});

test("v2 rejects blank, unsafe, oversized, and ill-formed local paths", () => {
  for (const localPath of [
    " ",
    "bad\0path",
    "x".repeat(32_769),
    "bad\ud800path",
    "bad\udc00path",
  ]) {
    const result = decodeAndMigrateToolchainPreferences({
      schemaVersion: 2,
      profiles: { cpp14: { mode: "local_path", localPath } },
    }, mapping);
    assert.equal(result.status, "invalid");
    assert.equal(result.migrationWriteRequired, false);
  }
});

test("persisted diagnostics accept only migration-specific semantic shapes", () => {
  const valid = decodeAndMigrateToolchainPreferences({
    schemaVersion: 2,
    profiles: {},
    migrationDiagnostics: [
      {
        code: "LEGACY_LOCAL_PATH_REQUIRED",
        profileId: "cpp14",
        field: "localPath",
      },
      {
        code: "LEGACY_INSTALLED_HINT_IGNORED",
        field: "installedToolchains",
      },
    ],
  }, mapping);
  assert.equal(valid.status, "ready-v2");

  for (const migrationDiagnostics of [
    [{ code: "INVALID_JSON", field: "document" }],
    [{ code: "LEGACY_LOCAL_PATH_REQUIRED", field: "localPath" }],
    [{
      code: "LEGACY_INSTALLED_HINT_IGNORED",
      profileId: "cpp14",
      field: "installedToolchains",
    }],
  ]) {
    const invalid = decodeAndMigrateToolchainPreferences({
      schemaVersion: 2,
      profiles: {},
      migrationDiagnostics,
    }, mapping);
    assert.equal(invalid.status, "invalid");
    assert.equal(invalid.migrationWriteRequired, false);
  }
});

test("missing profiles resolve to None without mutating a valid v2 document", () => {
  const result = decodeAndMigrateToolchainPreferences({
    schemaVersion: 2,
    profiles: {
      cpp14: { mode: "managed", localPath: String.raw`C:\old\g++.exe` },
      "future-profile": { mode: "local_auto" },
    },
  }, mapping);

  assert.equal(result.status, "ready-v2");
  assert.deepEqual(
    getStoredProfilePreference(result.preferences, "python312"),
    { mode: "none" },
  );
  assert.deepEqual(result.preferences.profiles["future-profile"], {
    mode: "local_auto",
  });
  assert.equal(result.preferences.profiles.python312, undefined);
});
