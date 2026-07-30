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
