import assert from "node:assert/strict";
import test from "node:test";
import {
  C_LANGUAGE_PROFILE_ID,
  CSHARP_LANGUAGE_PROFILE_ID,
  CPP_LANGUAGE_PROFILE_ID,
  GO_LANGUAGE_PROFILE_ID,
  getRegisteredLanguageProfile,
  getRegisteredProfileForKind,
  JAVA_LANGUAGE_PROFILE_ID,
  JAVASCRIPT_LANGUAGE_PROFILE_ID,
  listRegisteredLanguageProfiles,
  PASCAL_LANGUAGE_PROFILE_ID,
  PYTHON_LANGUAGE_PROFILE_ID,
  RUST_LANGUAGE_PROFILE_ID,
} from "./registry.js";
import { isToolchainVersionAllowed } from "./version-policy.js";

test("the live registry exposes approved profiles in deterministic UI order", () => {
  const registry = listRegisteredLanguageProfiles();
  assert.deepEqual(
    registry.map((entry) => ({
      id: entry.profile.ref.id,
      kind: entry.toolchainKind,
      mode: entry.freshInstallMode,
    })),
    [
      { id: CPP_LANGUAGE_PROFILE_ID, kind: "cpp", mode: "local_auto" },
      { id: C_LANGUAGE_PROFILE_ID, kind: "c", mode: "none" },
      { id: PYTHON_LANGUAGE_PROFILE_ID, kind: "python", mode: "local_auto" },
      { id: PASCAL_LANGUAGE_PROFILE_ID, kind: "pascal", mode: "none" },
      { id: GO_LANGUAGE_PROFILE_ID, kind: "go", mode: "none" },
      { id: JAVA_LANGUAGE_PROFILE_ID, kind: "java", mode: "none" },
      { id: RUST_LANGUAGE_PROFILE_ID, kind: "rust", mode: "none" },
      {
        id: JAVASCRIPT_LANGUAGE_PROFILE_ID,
        kind: "javascript",
        mode: "none",
      },
      { id: CSHARP_LANGUAGE_PROFILE_ID, kind: "csharp", mode: "none" },
    ],
  );
  assert.equal(getRegisteredProfileForKind("cpp"), registry[0]);
  assert.equal(getRegisteredProfileForKind("python"), registry[2]);
  assert.equal(getRegisteredLanguageProfile("unknown-profile"), undefined);
  assert.equal(Object.isFrozen(registry), true);
  assert.equal(Object.isFrozen(registry[0]), true);
  assert.equal(Object.isFrozen(registry[0].profile), true);
  assert.equal(Object.isFrozen(registry[0].profile.extensions), true);
  assert.equal(Object.isFrozen(registry[0].localVersionPolicy), true);
  assert.equal(Object.isFrozen(registry[0].localExecution), true);
  assert.equal(
    registry.every((entry) =>
      entry.localExecution.length === entry.profile.supportedHosts.length
    ),
    true,
  );
});

test("local version policies pin tested versions instead of accepting any future release", () => {
  const versions = (kind: Parameters<typeof getRegisteredProfileForKind>[0]) => {
    const policy = getRegisteredProfileForKind(kind).localVersionPolicy;
    assert.equal(policy.kind, "exact_allowlist");
    return policy.kind === "exact_allowlist"
      ? policy.entries.map((entry) => entry.version)
      : [];
  };

  assert.deepEqual(versions("pascal"), ["3.2.2"]);
  assert.deepEqual(versions("go"), ["1.26.5"]);
  assert.deepEqual(versions("java"), ["21.0.12"]);
  assert.deepEqual(versions("rust"), ["1.97.1"]);
  assert.deepEqual(versions("javascript"), ["24.18.1"]);
  assert.deepEqual(versions("csharp"), ["10.0.302"]);

  const cppPolicy = getRegisteredProfileForKind("cpp").localVersionPolicy;
  assert.equal(
    isToolchainVersionAllowed(
      "14.2.0",
      cppPolicy,
      { platform: "win32", arch: "x64" },
    ),
    true,
  );
  assert.equal(
    isToolchainVersionAllowed(
      "14.2.0",
      cppPolicy,
      { platform: "darwin", arch: "arm64" },
    ),
    false,
  );
  assert.equal(
    isToolchainVersionAllowed(
      "17.0.0",
      cppPolicy,
      { platform: "darwin", arch: "arm64" },
    ),
    true,
  );
});

test("registered profiles preserve current submission and checker adapters", () => {
  const cpp = getRegisteredProfileForKind("cpp").profile;
  const python = getRegisteredProfileForKind("python").profile;
  assert.deepEqual(cpp.extensions, [".cpp"]);
  assert.equal(cpp.roles.submission.compileAdapterId, "legacy.cpp.compile");
  assert.equal(cpp.roles.checker?.compileAdapterId, "legacy.cpp.compile-checker");
  assert.deepEqual(python.extensions, [".py"]);
  assert.equal(python.roles.submission.compileAdapterId, undefined);
  assert.equal(python.roles.checker?.launchAdapterId, "legacy.python.checker-launch");
});
