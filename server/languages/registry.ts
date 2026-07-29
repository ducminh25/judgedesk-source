import {
  isLanguageProfileId,
  type LanguageProfile,
  type LanguageProfileId,
} from "./contracts.js";
import type { ToolchainKind } from "../toolchains/types.js";

export const LANGUAGE_REGISTRY_REVISION = 1;
export const CPP_LANGUAGE_PROFILE_ID = "cpp-legacy-v1";
export const PYTHON_LANGUAGE_PROFILE_ID = "python-cpython312";

export interface RegisteredLanguageProfile {
  profile: LanguageProfile;
  toolchainKind: ToolchainKind;
  /**
   * Compatibility default for the two profiles that existed before the
   * registry. Future profiles must default to `none` until product policy is
   * explicitly approved.
   */
  freshInstallMode: "local_auto" | "none";
}

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
    freshInstallMode: "local_auto",
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
    freshInstallMode: "local_auto",
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
