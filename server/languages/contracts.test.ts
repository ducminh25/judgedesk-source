import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveUiReadinessStatus,
  isLanguageProfileId,
  type LanguageProfile,
  type PreparedProgram,
  type ProfileToolchainState,
  type RoleReadiness,
  type StoredProfileToolchainPreference,
  type ToolchainSourceSelection,
  type ToolchainVersionPolicy,
} from "./contracts.js";

test("language profile IDs use a stable lowercase storage-safe format", () => {
  for (const profileId of ["cpp14", "cpp-gnu14", "python_3.12", "java.21"]) {
    assert.equal(isLanguageProfileId(profileId), true);
  }
  for (const profileId of [
    "",
    "Cpp14",
    "cpp 14",
    "-cpp14",
    "a".repeat(129),
    14,
  ]) {
    assert.equal(isLanguageProfileId(profileId), false);
  }
});

const cppProfileFixture = {
  ref: { id: "cpp-legacy-v1", version: 1 },
  displayNameKey: "languages.cpp",
  stability: "stable",
  extensions: [".cpp"],
  supportedHosts: [
    { platform: "win32", arch: "x64", minimumOs: "10.0" },
    { platform: "darwin", arch: "arm64", minimumOs: "11.0" },
  ],
  roles: {
    submission: {
      compileAdapterId: "legacy.cpp.compile",
      launchAdapterId: "legacy.native.launch",
      requiredToolchainCapabilities: ["cpp.compiler"],
      artifactKind: "native-file",
      artifactValidatorId: "native.pe-or-mach-o",
    },
    checker: {
      compileAdapterId: "legacy.cpp.compile-checker",
      launchAdapterId: "legacy.native.launch-checker",
      requiredToolchainCapabilities: ["cpp.compiler"],
      artifactKind: "native-file",
      artifactValidatorId: "native.pe-or-mach-o",
    },
  },
  policies: {
    sourcePolicyId: "legacy.single-file",
    toolchainPolicyId: "legacy.cpp.v1",
    environmentPolicyId: "legacy.cpp.environment",
    resourcePolicyId: "legacy.cpp.resources",
    probeSuiteId: "legacy.cpp.probes",
  },
} satisfies LanguageProfile;

const pythonProfileFixture = {
  ref: { id: "python-cpython312", version: 1 },
  displayNameKey: "languages.python",
  stability: "stable",
  extensions: [".py"],
  supportedHosts: [
    { platform: "win32", arch: "x64", minimumOs: "10.0" },
    { platform: "darwin", arch: "arm64", minimumOs: "11.0" },
  ],
  roles: {
    submission: {
      launchAdapterId: "legacy.python.isolated-launch",
      requiredToolchainCapabilities: ["python.runtime"],
      artifactKind: "script-source",
      artifactValidatorId: "python.single-source",
    },
    checker: {
      launchAdapterId: "legacy.python.checker-launch",
      requiredToolchainCapabilities: ["python.runtime"],
      artifactKind: "script-source",
      artifactValidatorId: "python.single-source",
    },
  },
  policies: {
    sourcePolicyId: "legacy.single-file",
    toolchainPolicyId: "legacy.python.v1",
    environmentPolicyId: "legacy.python.environment",
    resourcePolicyId: "legacy.python.resources",
    probeSuiteId: "legacy.python.probes",
  },
} satisfies LanguageProfile;

const unsupported = { state: "unsupported" } satisfies RoleReadiness;
const needsCertification = {
  state: "not_ready",
  diagnostics: [
    {
      code: "CERTIFICATION_REQUIRED",
      messageKey: "toolchains.certificationRequired",
    },
  ],
} satisfies RoleReadiness;
const ready = {
  state: "ready",
  certificateId: "certificate-fixed",
  fingerprint: "fingerprint-fixed",
  verifiedAt: "2026-07-28T00:00:00.000Z",
} satisfies RoleReadiness;

test("language contract fixtures keep C++ native and Python runtime-backed artifacts distinct", () => {
  assert.equal(cppProfileFixture.roles.submission.artifactKind, "native-file");
  assert.equal(
    pythonProfileFixture.roles.submission.artifactKind,
    "script-source",
  );
  assert.deepEqual(cppProfileFixture.extensions, [".cpp"]);
  assert.deepEqual(pythonProfileFixture.extensions, [".py"]);
});

test("UI readiness is derived from role capabilities", () => {
  assert.equal(
    deriveUiReadinessStatus({ submission: ready, checker: ready }),
    "submission_ready",
  );
  assert.equal(
    deriveUiReadinessStatus({ submission: needsCertification, checker: ready }),
    "checker_only",
  );
  assert.equal(
    deriveUiReadinessStatus({
      submission: needsCertification,
      checker: unsupported,
    }),
    "not_available",
  );
});

test("source selections and version policies have explicit non-fallback shapes", () => {
  const selections = [
    { mode: "none" },
    { mode: "managed" },
    { mode: "local_path", path: "C:\\toolchains\\compiler.exe" },
    { mode: "local_auto" },
  ] satisfies readonly ToolchainSourceSelection[];
  const policies = [
    {
      kind: "exact_allowlist",
      entries: [
        {
          family: "compiler-family",
          distributor: "vendor",
          version: "1.2.3",
          build: "vendor-build",
          identityPolicyId: "compiler-family.vendor-build",
          hosts: [{ platform: "win32", arch: "x64" }],
        },
      ],
    },
    {
      kind: "bounded_range",
      minInclusive: "1.2.0",
      maxExclusive: "1.3.0",
      testedMajors: [1],
    },
    {
      kind: "minimum_only",
      minInclusive: "9.0.0",
    },
    {
      kind: "host_matrix",
      rules: [
        {
          hosts: [{ platform: "win32", arch: "x64" }],
          policy: {
            kind: "bounded_range",
            minInclusive: "9.0.0",
            maxExclusive: "18.0.0",
            testedMajors: [9],
          },
        },
        {
          hosts: [{ platform: "darwin", arch: "arm64" }],
          policy: {
            kind: "minimum_only",
            minInclusive: "9.0.0",
          },
        },
      ],
    },
  ] satisfies readonly ToolchainVersionPolicy[];

  assert.deepEqual(selections.map((selection) => selection.mode), [
    "none",
    "managed",
    "local_path",
    "local_auto",
  ]);
  assert.deepEqual(policies.map((policy) => policy.kind), [
    "exact_allowlist",
    "bounded_range",
    "minimum_only",
    "host_matrix",
  ]);

  const acceptSelection = (_selection: ToolchainSourceSelection): void => {};
  // @ts-expect-error Managed selection cannot carry a local path.
  acceptSelection({ mode: "managed", path: "C:\\compiler.exe" });
  // @ts-expect-error Resolved local_path selections require a validated path.
  acceptSelection({ mode: "local_path" });
});

test("persisted preferences retain dormant and missing local paths without activating them", () => {
  const stored = [
    { mode: "managed", localPath: "C:\\remembered\\compiler.exe" },
    { mode: "local_auto", localPath: "C:\\remembered\\python.exe" },
    { mode: "local_path" },
  ] satisfies readonly StoredProfileToolchainPreference[];

  assert.deepEqual(stored.map((preference) => preference.mode), [
    "managed",
    "local_auto",
    "local_path",
  ]);
});

test("prepared programs distinguish artifact entrypoints from certified runtime components", () => {
  const nativeProgram = {
    profile: cppProfileFixture.ref,
    certificate: { id: "cpp-certificate", fingerprint: "cpp-fingerprint" },
    artifact: {
      kind: "native-file",
      treeDigest: "cpp-tree",
      entrypoint: { kind: "relative-file", path: "program.exe" },
      fileCount: 1,
      totalBytes: 1024,
      executablePaths: ["program.exe"],
    },
    launch: {
      executable: { kind: "artifact-entrypoint" },
      args: [],
      environment: {},
    },
  } satisfies PreparedProgram;
  const pythonProgram = {
    profile: pythonProfileFixture.ref,
    certificate: {
      id: "python-certificate",
      fingerprint: "python-fingerprint",
    },
    artifact: {
      kind: "script-source",
      treeDigest: "python-tree",
      entrypoint: { kind: "relative-file", path: "submission.py" },
      fileCount: 1,
      totalBytes: 512,
      executablePaths: [],
    },
    launch: {
      executable: {
        kind: "toolchain-component",
        componentId: "python.runtime",
      },
      args: ["-I", "-B", "submission.py"],
      environment: { PYTHONNOUSERSITE: "1" },
    },
  } satisfies PreparedProgram;

  assert.equal(nativeProgram.launch.executable.kind, "artifact-entrypoint");
  assert.equal(
    pythonProgram.launch.executable.kind,
    "toolchain-component",
  );

  const acceptPreparedProgram = (_program: PreparedProgram): void => {};
  // @ts-expect-error Script artifacts must launch a certified runtime component.
  acceptPreparedProgram({
    ...pythonProgram,
    launch: {
      executable: { kind: "artifact-entrypoint" },
      args: [],
      environment: {},
    },
  });
});

test("disabled and unverified selections cannot be ready by construction", () => {
  const acceptState = (_state: ProfileToolchainState): void => {};

  // @ts-expect-error A disabled profile cannot retain a ready role.
  acceptState({
    profile: cppProfileFixture.ref,
    selection: { mode: "none" },
    candidates: [],
    roles: { submission: ready, checker: unsupported },
  });

  // @ts-expect-error Unverified local candidates cannot be submission-ready.
  acceptState({
    profile: pythonProfileFixture.ref,
    selection: { mode: "local_auto" },
    candidates: [],
    provenance: "unverified-local",
    roles: { submission: ready, checker: needsCertification },
  });
});
