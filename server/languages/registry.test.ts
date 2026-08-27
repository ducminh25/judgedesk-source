import assert from "node:assert/strict";
import test from "node:test";
import {
  C_LANGUAGE_PROFILE_ID,
  CPP_LANGUAGE_PROFILE_ID,
  getRegisteredLanguageProfile,
  getRegisteredProfileForExtension,
  getRegisteredProfileForKind,
  JAVA_LANGUAGE_PROFILE_ID,
  listRegisteredLanguageProfiles,
  PASCAL_LANGUAGE_PROFILE_ID,
  PYTHON_LANGUAGE_PROFILE_ID,
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
      { id: C_LANGUAGE_PROFILE_ID, kind: "c", mode: "local_auto" },
      { id: PYTHON_LANGUAGE_PROFILE_ID, kind: "python", mode: "local_auto" },
      { id: PASCAL_LANGUAGE_PROFILE_ID, kind: "pascal", mode: "none" },
      { id: JAVA_LANGUAGE_PROFILE_ID, kind: "java", mode: "none" },
    ],
  );
  assert.equal(getRegisteredProfileForKind("cpp"), registry[0]);
  assert.equal(getRegisteredProfileForKind("python"), registry[2]);
  assert.equal(getRegisteredLanguageProfile("unknown-profile"), undefined);
  assert.throws(
    () => getRegisteredProfileForKind("go"),
    /No language profile is registered/,
  );
  for (const extension of [".go", ".rs", ".js", ".cs"]) {
    assert.equal(getRegisteredProfileForExtension(extension), undefined);
  }
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

test("local version policies use bounded compatibility ranges before the native probe", () => {
  const versions = (kind: Parameters<typeof getRegisteredProfileForKind>[0]) => {
    const policy = getRegisteredProfileForKind(kind).localVersionPolicy;
    assert.equal(policy.kind, "exact_allowlist");
    return policy.kind === "exact_allowlist"
      ? policy.entries.map((entry) => entry.version)
      : [];
  };

  assert.ok(versions("pascal").includes("3.2.2"));
  assert.ok(versions("java").includes("21.0.12"));

  const cppPolicy = getRegisteredProfileForKind("cpp").localVersionPolicy;
  assert.equal(cppPolicy.kind, "host_matrix");
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
    true,
  );
  assert.equal(
    isToolchainVersionAllowed(
      "17.0.0",
      cppPolicy,
      { platform: "darwin", arch: "arm64" },
    ),
    true,
  );
  assert.equal(
    isToolchainVersionAllowed(
      "21.0.0",
      cppPolicy,
      { platform: "darwin", arch: "arm64" },
    ),
    true,
  );
  assert.equal(
    isToolchainVersionAllowed(
      "21.0.0",
      cppPolicy,
      { platform: "win32", arch: "x64" },
    ),
    false,
  );
  assert.equal(
    isToolchainVersionAllowed(
      "18.0.0",
      cppPolicy,
      { platform: "win32", arch: "x64" },
    ),
    false,
  );
  assert.equal(
    isToolchainVersionAllowed(
      "8.5.0",
      cppPolicy,
      { platform: "darwin", arch: "arm64" },
    ),
    false,
  );
  assert.equal(isToolchainVersionAllowed("14.2.0", cppPolicy), false);

  const cPolicy = getRegisteredProfileForKind("c").localVersionPolicy;
  assert.equal(cPolicy.kind, "host_matrix");
  assert.equal(
    isToolchainVersionAllowed(
      "21.0.0",
      cPolicy,
      { platform: "darwin", arch: "arm64" },
    ),
    true,
  );
  assert.equal(
    isToolchainVersionAllowed(
      "21.0.0",
      cPolicy,
      { platform: "win32", arch: "x64" },
    ),
    false,
  );

  const pythonPolicy = getRegisteredProfileForKind("python").localVersionPolicy;
  assert.equal(pythonPolicy.kind, "bounded_range");
  assert.equal(isToolchainVersionAllowed("3.8.0", pythonPolicy), true);
  assert.equal(isToolchainVersionAllowed("3.13.7", pythonPolicy), true);
  assert.equal(isToolchainVersionAllowed("3.14.0", pythonPolicy), false);
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
