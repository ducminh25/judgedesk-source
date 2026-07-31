import {
  isLanguageProfileId,
  type LanguageProfile,
  type LanguageProfileId,
  type ToolchainVersionPolicy,
} from "./contracts.js";
import type { ToolchainKind } from "../toolchains/types.js";
import {
  validateToolchainVersionPolicy,
} from "./version-policy.js";

export const LANGUAGE_REGISTRY_REVISION = 3;
export const CPP_LANGUAGE_PROFILE_ID = "cpp-legacy-v1";
export const C_LANGUAGE_PROFILE_ID = "c-gcc14";
export const PYTHON_LANGUAGE_PROFILE_ID = "python-cpython312";
export const PASCAL_LANGUAGE_PROFILE_ID = "pascal-fpc322";
export const GO_LANGUAGE_PROFILE_ID = "go-126";
export const JAVA_LANGUAGE_PROFILE_ID = "java-temurin21";
export const RUST_LANGUAGE_PROFILE_ID = "rust-197";
export const JAVASCRIPT_LANGUAGE_PROFILE_ID = "javascript-node24";
export const CSHARP_LANGUAGE_PROFILE_ID = "csharp-dotnet10";

export type LocalExecutionMode =
  | "quick_verified_direct"
  | "platform_certified_direct"
  | "freeze_required"
  | "managed_only";

export interface RegisteredLanguageProfile {
  profile: LanguageProfile;
  toolchainKind: ToolchainKind;
  localVersionPolicy: ToolchainVersionPolicy;
  localExecution: readonly {
    platform: "win32" | "darwin";
    arch: "x64" | "arm64";
    mode: LocalExecutionMode;
  }[];
  /**
   * Compatibility default for the two profiles that existed before the
   * registry. Future profiles must default to `none` until product policy is
   * explicitly approved.
   */
  freshInstallMode: "local_auto" | "none";
}

const WINDOWS_X64_HOST = { platform: "win32", arch: "x64" } as const;
const MACOS_ARM64_HOST = { platform: "darwin", arch: "arm64" } as const;
const BOTH_RELEASE_HOSTS = [WINDOWS_X64_HOST, MACOS_ARM64_HOST] as const;

const LOCAL_VERSION_POLICIES = {
  cpp: {
    kind: "exact_allowlist",
    entries: [
      {
        family: "gnu-gcc",
        distributor: "Themis-compatible MinGW",
        version: "9.2.0",
        build: "legacy-gcc-9.2.0",
        identityPolicyId: "gcc.windows.target-runtime-v1",
        hosts: [WINDOWS_X64_HOST],
      },
      {
        family: "gnu-gcc",
        distributor: "WinLibs",
        version: "14.2.0",
        build: "14.2.0posix-19.1.1-12.0.0-ucrt-r2",
        identityPolicyId: "gcc.windows.target-runtime-v1",
        hosts: [WINDOWS_X64_HOST],
      },
      {
        family: "gnu-gcc",
        distributor: "MSYS2",
        version: "16.1.0",
        build: "msys2-ucrt64",
        identityPolicyId: "gcc.windows.target-runtime-v1",
        hosts: [WINDOWS_X64_HOST],
      },
      {
        family: "apple-clang",
        distributor: "Apple",
        version: "17.0.0",
        build: "selected-developer-root",
        identityPolicyId: "apple-clang.selected-sdk-v1",
        hosts: [MACOS_ARM64_HOST],
      },
    ],
  },
  c: {
    kind: "exact_allowlist",
    entries: [
      {
        family: "gnu-gcc",
        distributor: "WinLibs",
        version: "14.2.0",
        build: "14.2.0posix-19.1.1-12.0.0-ucrt-r2",
        identityPolicyId: "gcc.windows.target-runtime-v1",
        hosts: [WINDOWS_X64_HOST],
      },
      {
        family: "apple-clang",
        distributor: "Apple",
        version: "17.0.0",
        build: "selected-developer-root",
        identityPolicyId: "apple-clang.selected-sdk-v1",
        hosts: [MACOS_ARM64_HOST],
      },
    ],
  },
  python: {
    kind: "exact_allowlist",
    entries: [{
      family: "cpython",
      distributor: "python-build-standalone",
      version: "3.12.13",
      build: "20260623",
      identityPolicyId: "cpython.standalone-abi-v1",
      hosts: BOTH_RELEASE_HOSTS,
    }],
  },
  pascal: {
    kind: "exact_allowlist",
    entries: [{
      family: "free-pascal",
      distributor: "Free Pascal",
      version: "3.2.2",
      build: "official-stable",
      identityPolicyId: "fpc.target-units-linker-v1",
      hosts: BOTH_RELEASE_HOSTS,
    }],
  },
  go: {
    kind: "exact_allowlist",
    entries: [{
      family: "go",
      distributor: "Go project",
      version: "1.26.5",
      build: "official-binary",
      identityPolicyId: "go.host-target-stdlib-v1",
      hosts: BOTH_RELEASE_HOSTS,
    }],
  },
  java: {
    kind: "exact_allowlist",
    entries: [{
      family: "openjdk",
      distributor: "Eclipse Temurin",
      version: "21.0.12",
      build: "21.0.12+8",
      identityPolicyId: "temurin.jdk-javac-runtime-v1",
      hosts: BOTH_RELEASE_HOSTS,
    }],
  },
  rust: {
    kind: "exact_allowlist",
    entries: [{
      family: "rust",
      distributor: "Rust project",
      version: "1.97.1",
      build: "stable",
      identityPolicyId: "rust.host-std-linker-v1",
      hosts: BOTH_RELEASE_HOSTS,
    }],
  },
  javascript: {
    kind: "exact_allowlist",
    entries: [{
      family: "nodejs",
      distributor: "Node.js",
      version: "24.18.1",
      build: "official-binary",
      identityPolicyId: "node.platform-icu-v1",
      hosts: BOTH_RELEASE_HOSTS,
    }],
  },
  csharp: {
    kind: "exact_allowlist",
    entries: [{
      family: "dotnet-sdk",
      distributor: "Microsoft",
      version: "10.0.302",
      build: "SDK 10.0.302 / runtime 10.0.10",
      identityPolicyId: "dotnet.sdk-runtime-packs-v1",
      hosts: BOTH_RELEASE_HOSTS,
    }],
  },
} as const satisfies Readonly<Record<ToolchainKind, ToolchainVersionPolicy>>;

const LANGUAGE_REGISTRY = [
  {
    profile: {
      ref: { id: CPP_LANGUAGE_PROFILE_ID, version: 1 },
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
    },
    toolchainKind: "cpp",
    localVersionPolicy: LOCAL_VERSION_POLICIES.cpp,
    localExecution: [
      { platform: "win32", arch: "x64", mode: "freeze_required" },
      {
        platform: "darwin",
        arch: "arm64",
        mode: "platform_certified_direct",
      },
    ],
    freshInstallMode: "local_auto",
  },
  {
    profile: {
      ref: { id: C_LANGUAGE_PROFILE_ID, version: 1 },
      displayNameKey: "languages.c",
      stability: "experimental",
      extensions: [".c"],
      supportedHosts: [
        { platform: "win32", arch: "x64", minimumOs: "10.0" },
        { platform: "darwin", arch: "arm64", minimumOs: "11.0" },
      ],
      roles: {
        submission: {
          compileAdapterId: "managed.c11.compile",
          launchAdapterId: "legacy.native.launch",
          requiredToolchainCapabilities: ["c.compiler"],
          artifactKind: "native-file",
          artifactValidatorId: "native.pe-or-mach-o",
        },
      },
      policies: {
        sourcePolicyId: "legacy.single-file",
        toolchainPolicyId: "managed.c.gcc14-or-apple-clang",
        environmentPolicyId: "managed.c.environment",
        resourcePolicyId: "managed.c.resources",
        probeSuiteId: "managed.c.probes",
      },
    },
    toolchainKind: "c",
    localVersionPolicy: LOCAL_VERSION_POLICIES.c,
    localExecution: [
      { platform: "win32", arch: "x64", mode: "managed_only" },
      {
        platform: "darwin",
        arch: "arm64",
        mode: "platform_certified_direct",
      },
    ],
    freshInstallMode: "none",
  },
  {
    profile: {
      ref: { id: PYTHON_LANGUAGE_PROFILE_ID, version: 1 },
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
    },
    toolchainKind: "python",
    localVersionPolicy: LOCAL_VERSION_POLICIES.python,
    localExecution: [
      { platform: "win32", arch: "x64", mode: "managed_only" },
      { platform: "darwin", arch: "arm64", mode: "managed_only" },
    ],
    freshInstallMode: "local_auto",
  },
  {
    profile: {
      ref: { id: PASCAL_LANGUAGE_PROFILE_ID, version: 1 },
      displayNameKey: "languages.pascal",
      stability: "experimental",
      extensions: [".pas", ".pp"],
      supportedHosts: [
        { platform: "win32", arch: "x64", minimumOs: "10.0" },
        { platform: "darwin", arch: "arm64", minimumOs: "11.0" },
      ],
      roles: {
        submission: {
          compileAdapterId: "managed.pascal.compile",
          launchAdapterId: "managed.native.launch",
          requiredToolchainCapabilities: ["pascal.compiler"],
          artifactKind: "native-file",
          artifactValidatorId: "native.pe-or-mach-o",
        },
      },
      policies: {
        sourcePolicyId: "legacy.single-file",
        toolchainPolicyId: "managed.pascal.fpc322",
        environmentPolicyId: "managed.pascal.environment",
        resourcePolicyId: "managed.pascal.resources",
        probeSuiteId: "managed.pascal.probes",
      },
    },
    toolchainKind: "pascal",
    localVersionPolicy: LOCAL_VERSION_POLICIES.pascal,
    localExecution: [
      { platform: "win32", arch: "x64", mode: "managed_only" },
      { platform: "darwin", arch: "arm64", mode: "managed_only" },
    ],
    freshInstallMode: "none",
  },
  {
    profile: {
      ref: { id: GO_LANGUAGE_PROFILE_ID, version: 1 },
      displayNameKey: "languages.go",
      stability: "experimental",
      extensions: [".go"],
      supportedHosts: [
        { platform: "win32", arch: "x64", minimumOs: "10.0" },
        { platform: "darwin", arch: "arm64", minimumOs: "12.0" },
      ],
      roles: {
        submission: {
          compileAdapterId: "managed.go.compile",
          launchAdapterId: "managed.native.launch",
          requiredToolchainCapabilities: ["go.compiler"],
          artifactKind: "native-file",
          artifactValidatorId: "native.pe-or-mach-o",
        },
      },
      policies: {
        sourcePolicyId: "legacy.single-file",
        toolchainPolicyId: "managed.go.126",
        environmentPolicyId: "managed.go.environment",
        resourcePolicyId: "managed.go.resources",
        probeSuiteId: "managed.go.probes",
      },
    },
    toolchainKind: "go",
    localVersionPolicy: LOCAL_VERSION_POLICIES.go,
    localExecution: [
      { platform: "win32", arch: "x64", mode: "managed_only" },
      { platform: "darwin", arch: "arm64", mode: "managed_only" },
    ],
    freshInstallMode: "none",
  },
  {
    profile: {
      ref: { id: JAVA_LANGUAGE_PROFILE_ID, version: 1 },
      displayNameKey: "languages.java",
      stability: "experimental",
      extensions: [".java"],
      supportedHosts: [
        { platform: "win32", arch: "x64", minimumOs: "10.0" },
        { platform: "darwin", arch: "arm64", minimumOs: "11.0" },
      ],
      roles: {
        submission: {
          compileAdapterId: "managed.java.compile",
          launchAdapterId: "managed.java.launch",
          requiredToolchainCapabilities: ["java.compiler", "java.runtime"],
          artifactKind: "directory-entry",
          artifactValidatorId: "java.class-directory",
        },
      },
      policies: {
        sourcePolicyId: "managed.java.single-main",
        toolchainPolicyId: "managed.java.temurin21",
        environmentPolicyId: "managed.java.environment",
        resourcePolicyId: "managed.java.resources",
        probeSuiteId: "managed.java.probes",
      },
    },
    toolchainKind: "java",
    localVersionPolicy: LOCAL_VERSION_POLICIES.java,
    localExecution: [
      { platform: "win32", arch: "x64", mode: "managed_only" },
      { platform: "darwin", arch: "arm64", mode: "managed_only" },
    ],
    freshInstallMode: "none",
  },
  {
    profile: {
      ref: { id: RUST_LANGUAGE_PROFILE_ID, version: 1 },
      displayNameKey: "languages.rust",
      stability: "experimental",
      extensions: [".rs"],
      supportedHosts: [
        { platform: "win32", arch: "x64", minimumOs: "10.0" },
        { platform: "darwin", arch: "arm64", minimumOs: "11.0" },
      ],
      roles: {
        submission: {
          compileAdapterId: "managed.rust.compile",
          launchAdapterId: "managed.native.launch",
          requiredToolchainCapabilities: ["rust.compiler", "platform.linker"],
          artifactKind: "native-file",
          artifactValidatorId: "native.pe-or-mach-o",
        },
      },
      policies: {
        sourcePolicyId: "legacy.single-file",
        toolchainPolicyId: "managed.rust.197",
        environmentPolicyId: "managed.rust.environment",
        resourcePolicyId: "managed.rust.resources",
        probeSuiteId: "managed.rust.probes",
      },
    },
    toolchainKind: "rust",
    localVersionPolicy: LOCAL_VERSION_POLICIES.rust,
    localExecution: [
      { platform: "win32", arch: "x64", mode: "managed_only" },
      { platform: "darwin", arch: "arm64", mode: "managed_only" },
    ],
    freshInstallMode: "none",
  },
  {
    profile: {
      ref: { id: JAVASCRIPT_LANGUAGE_PROFILE_ID, version: 1 },
      displayNameKey: "languages.javascript",
      stability: "experimental",
      extensions: [".js"],
      supportedHosts: [
        { platform: "win32", arch: "x64", minimumOs: "10.0" },
        { platform: "darwin", arch: "arm64", minimumOs: "13.5" },
      ],
      roles: {
        submission: {
          launchAdapterId: "managed.node.isolated-launch",
          requiredToolchainCapabilities: ["javascript.runtime"],
          artifactKind: "script-source",
          artifactValidatorId: "javascript.single-source",
        },
      },
      policies: {
        sourcePolicyId: "legacy.single-file",
        toolchainPolicyId: "managed.node.24",
        environmentPolicyId: "managed.node.environment",
        resourcePolicyId: "managed.node.resources",
        probeSuiteId: "managed.node.probes",
      },
    },
    toolchainKind: "javascript",
    localVersionPolicy: LOCAL_VERSION_POLICIES.javascript,
    localExecution: [
      { platform: "win32", arch: "x64", mode: "managed_only" },
      { platform: "darwin", arch: "arm64", mode: "managed_only" },
    ],
    freshInstallMode: "none",
  },
  {
    profile: {
      ref: { id: CSHARP_LANGUAGE_PROFILE_ID, version: 1 },
      displayNameKey: "languages.csharp",
      stability: "experimental",
      extensions: [".cs"],
      supportedHosts: [
        { platform: "win32", arch: "x64", minimumOs: "10.0" },
        { platform: "darwin", arch: "arm64", minimumOs: "14.0" },
      ],
      roles: {
        submission: {
          compileAdapterId: "managed.csharp.compile",
          launchAdapterId: "managed.dotnet.launch",
          requiredToolchainCapabilities: ["csharp.compiler", "csharp.runtime"],
          artifactKind: "managed-bundle",
          artifactValidatorId: "dotnet.managed-bundle",
        },
      },
      policies: {
        sourcePolicyId: "managed.csharp.single-main",
        toolchainPolicyId: "managed.dotnet.10",
        environmentPolicyId: "managed.dotnet.environment",
        resourcePolicyId: "managed.dotnet.resources",
        probeSuiteId: "managed.dotnet.probes",
      },
    },
    toolchainKind: "csharp",
    localVersionPolicy: LOCAL_VERSION_POLICIES.csharp,
    localExecution: [
      { platform: "win32", arch: "x64", mode: "managed_only" },
      { platform: "darwin", arch: "arm64", mode: "managed_only" },
    ],
    freshInstallMode: "none",
  },
] as const satisfies readonly RegisteredLanguageProfile[];

function validateRegistry(
  registry: readonly RegisteredLanguageProfile[],
): void {
  const ids = new Set<string>();
  const kinds = new Set<ToolchainKind>();
  const extensions = new Set<string>();
  for (const entry of registry) {
    const { id, version } = entry.profile.ref;
    if (!isLanguageProfileId(id)) {
      throw new Error(`Invalid language profile ID '${id}'.`);
    }
    if (ids.has(id)) throw new Error(`Duplicate language profile ID '${id}'.`);
    if (kinds.has(entry.toolchainKind)) {
      throw new Error(`Duplicate legacy toolchain kind '${entry.toolchainKind}'.`);
    }
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new Error(`Invalid language profile version for '${id}'.`);
    }
    if (
      id !== CPP_LANGUAGE_PROFILE_ID
      && id !== PYTHON_LANGUAGE_PROFILE_ID
      && entry.freshInstallMode !== "none"
    ) {
      throw new Error(`Future language profile '${id}' must default to None.`);
    }
    const profileExtensions = new Set<string>();
    for (const extension of entry.profile.extensions) {
      if (
        !/^\.[a-z0-9][a-z0-9._+-]*$/i.test(extension)
        || profileExtensions.has(extension.toLowerCase())
        || extensions.has(extension.toLowerCase())
      ) {
        throw new Error(`Ambiguous source extension '${extension}'.`);
      }
      profileExtensions.add(extension.toLowerCase());
      extensions.add(extension.toLowerCase());
    }
    const hostKeys = new Set<string>();
    for (const host of entry.profile.supportedHosts) {
      const hostKey = `${host.platform}:${host.arch}`;
      if (hostKeys.has(hostKey) || !host.minimumOs.trim()) {
        throw new Error(`Invalid or duplicate host '${hostKey}' for '${id}'.`);
      }
      hostKeys.add(hostKey);
    }
    const localExecutionHostKeys = new Set<string>();
    for (const localPolicy of entry.localExecution) {
      const hostKey = `${localPolicy.platform}:${localPolicy.arch}`;
      if (
        localExecutionHostKeys.has(hostKey)
        || !hostKeys.has(hostKey)
      ) {
        throw new Error(
          `Invalid or duplicate local execution host '${hostKey}' for '${id}'.`,
        );
      }
      localExecutionHostKeys.add(hostKey);
    }
    if (
      localExecutionHostKeys.size !== hostKeys.size
      || [...hostKeys].some((hostKey) => !localExecutionHostKeys.has(hostKey))
    ) {
      throw new Error(`Local execution policy does not cover every host for '${id}'.`);
    }
    validateToolchainVersionPolicy(entry.localVersionPolicy);
    if (entry.localVersionPolicy.kind === "exact_allowlist") {
      const policyHostKeys = new Set(
        entry.localVersionPolicy.entries.flatMap((identity) =>
          identity.hosts.map((host) => `${host.platform}:${host.arch}`)
        ),
      );
      if (
        policyHostKeys.size !== hostKeys.size
        || [...hostKeys].some((hostKey) => !policyHostKeys.has(hostKey))
        || [...policyHostKeys].some((hostKey) => !hostKeys.has(hostKey))
      ) {
        throw new Error(`Local version policy does not cover every host for '${id}'.`);
      }
    }
    ids.add(id);
    kinds.add(entry.toolchainKind);
  }
}

function freezeRegistry(registry: readonly RegisteredLanguageProfile[]): void {
  for (const entry of registry) {
    for (const host of entry.profile.supportedHosts) Object.freeze(host);
    Object.freeze(entry.profile.supportedHosts);
    Object.freeze(entry.profile.extensions);
    Object.freeze(entry.profile.roles.submission.requiredToolchainCapabilities);
    Object.freeze(entry.profile.roles.submission);
    if (entry.profile.roles.checker) {
      Object.freeze(entry.profile.roles.checker.requiredToolchainCapabilities);
      Object.freeze(entry.profile.roles.checker);
    }
    Object.freeze(entry.profile.roles);
    Object.freeze(entry.profile.policies);
    Object.freeze(entry.profile.ref);
    Object.freeze(entry.profile);
    if (entry.localVersionPolicy.kind === "exact_allowlist") {
      for (const identity of entry.localVersionPolicy.entries) {
        for (const host of identity.hosts) Object.freeze(host);
        Object.freeze(identity.hosts);
        Object.freeze(identity);
      }
      Object.freeze(entry.localVersionPolicy.entries);
    } else {
      Object.freeze(entry.localVersionPolicy.testedMajors);
    }
    Object.freeze(entry.localVersionPolicy);
    for (const localPolicy of entry.localExecution) Object.freeze(localPolicy);
    Object.freeze(entry.localExecution);
    Object.freeze(entry);
  }
  Object.freeze(registry);
}

validateRegistry(LANGUAGE_REGISTRY);
freezeRegistry(LANGUAGE_REGISTRY);

export function listRegisteredLanguageProfiles(): readonly RegisteredLanguageProfile[] {
  return LANGUAGE_REGISTRY;
}

export function getRegisteredLanguageProfile(
  profileId: LanguageProfileId,
): RegisteredLanguageProfile | undefined {
  return LANGUAGE_REGISTRY.find((entry) => entry.profile.ref.id === profileId);
}

export function getRegisteredProfileForKind(
  kind: ToolchainKind,
): RegisteredLanguageProfile {
  const entry = LANGUAGE_REGISTRY.find((candidate) => candidate.toolchainKind === kind);
  if (!entry) throw new Error(`No language profile is registered for '${kind}'.`);
  return entry;
}

export function getRegisteredProfileForExtension(
  extension: string,
): RegisteredLanguageProfile | undefined {
  const normalized = extension.toLowerCase();
  return LANGUAGE_REGISTRY.find((entry) =>
    entry.profile.extensions.some(
      (candidate) => candidate.toLowerCase() === normalized,
    )
  );
}
