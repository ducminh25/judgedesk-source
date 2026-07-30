export type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

export type HostPlatform = "win32" | "darwin";
export type HostArchitecture = "x64" | "arm64";
export type LanguageStability = "stable" | "experimental";
export const LANGUAGE_PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
export type LanguageProfileId = string;
export type SourceExtension = `.${string}`;
export type ArtifactKind =
  | "native-file"
  | "native-bundle"
  | "script-source"
  | "directory-entry"
  | "managed-bundle";

export function isLanguageProfileId(value: unknown): value is LanguageProfileId {
  return typeof value === "string" && LANGUAGE_PROFILE_ID_PATTERN.test(value);
}

export interface LanguageProfileRef {
  id: LanguageProfileId;
  version: number;
}

export interface SupportedHost {
  platform: HostPlatform;
  arch: HostArchitecture;
  minimumOs: string;
}

export interface LanguageRoleSpec {
  compileAdapterId?: string;
  launchAdapterId: string;
  requiredToolchainCapabilities: readonly string[];
  artifactKind: ArtifactKind;
  artifactValidatorId: string;
}

/**
 * Declarative metadata only. Adapter and policy IDs are resolved through the
 * internal registry; profiles never contain shell strings or executable code.
 */
export interface LanguageProfile {
  ref: LanguageProfileRef;
  displayNameKey: string;
  stability: LanguageStability;
  extensions: NonEmptyReadonlyArray<SourceExtension>;
  supportedHosts: NonEmptyReadonlyArray<SupportedHost>;
  roles: {
    submission: LanguageRoleSpec;
    checker?: LanguageRoleSpec;
  };
  policies: {
    sourcePolicyId: string;
    toolchainPolicyId: string;
    environmentPolicyId: string;
    resourcePolicyId: string;
    probeSuiteId: string;
  };
}

export interface ExactToolchainVersionIdentity {
  family: string;
  distributor?: string;
  version: string;
  build: string;
  identityPolicyId: string;
}

export type ToolchainVersionPolicy =
  | {
      kind: "exact_allowlist";
      entries: NonEmptyReadonlyArray<ExactToolchainVersionIdentity>;
    }
  | {
      kind: "bounded_range";
      minInclusive: string;
      maxExclusive: string;
      testedMajors: NonEmptyReadonlyArray<number>;
    };

export type ToolchainSourceMode =
  | "none"
  | "managed"
  | "local_path"
  | "local_auto";

/** Resolved selection used only after an active local path has been validated. */
export type ToolchainSourceSelection =
  | { mode: "none" }
  | { mode: "managed" }
  | { mode: "local_path"; path: string }
  | { mode: "local_auto" };

/**
 * Persisted user intent. localPath remains dormant outside local_path mode and
 * may be absent in local_path mode so migration can fail closed without losing
 * the user's selected radio mode.
 */
export interface StoredProfileToolchainPreference {
  mode: ToolchainSourceMode;
  localPath?: string;
}

export type ToolchainRole = "submission" | "checker";
export type ToolchainProvenance =
  | "managed-package"
  | "platform-certified"
  | "certified-local"
  | "unverified-local";

export type ReadinessReasonCode =
  | "DISABLED_BY_USER"
  | "PROFILE_UNSUPPORTED_ON_HOST"
  | "MINIMUM_OS_UNSUPPORTED"
  | "MANAGED_PACKAGE_UNSUPPORTED"
  | "MANAGED_PACKAGE_NOT_INSTALLED"
  | "MANAGED_PACKAGE_CORRUPT"
  | "HEALTH_CHECK_FAILED"
  | "LOCAL_PATH_REQUIRED"
  | "LOCAL_PATH_MISSING"
  | "LOCAL_EXECUTABLE_INVALID"
  | "LOCAL_VERSION_UNSUPPORTED"
  | "LOCAL_NOT_SANDBOX_COMPATIBLE"
  | "AUTO_DETECT_NOT_FOUND"
  | "AUTO_DETECT_AMBIGUOUS"
  | "DETECTION_IN_PROGRESS"
  | "CERTIFICATION_REQUIRED"
  | "CERTIFICATE_STALE"
  | "TOOLCHAIN_DRIFTED";

export interface ReadinessDiagnostic {
  code: ReadinessReasonCode;
  messageKey: string;
  details?: Readonly<Record<string, string | number | boolean>>;
}

export type RoleReadiness =
  | { state: "unsupported" }
  | {
      state: "not_ready";
      diagnostics: NonEmptyReadonlyArray<ReadinessDiagnostic>;
    }
  | {
      state: "ready";
      certificateId: string;
      fingerprint: string;
      verifiedAt: string;
    };

export type NonReadyRoleReadiness = Exclude<
  RoleReadiness,
  { state: "ready" }
>;
export type RoleReadinessMap = Readonly<
  Record<ToolchainRole, RoleReadiness>
>;
export type NonReadyRoleReadinessMap = Readonly<
  Record<ToolchainRole, NonReadyRoleReadiness>
>;

export interface ToolchainCandidateSummary {
  candidateId: string;
  origin: "managed" | "local";
  displayPath?: string;
  family?: string;
  version?: string;
  build?: string;
  hostArchitecture?: HostArchitecture;
  target?: string;
  fingerprint?: string;
}

interface ProfileToolchainStateBase {
  profile: LanguageProfileRef;
  candidates: readonly ToolchainCandidateSummary[];
}

type LocalToolchainSourceSelection = Extract<
  ToolchainSourceSelection,
  { mode: "local_path" | "local_auto" }
>;

export type ProfileToolchainState =
  | (ProfileToolchainStateBase & {
      selection: { mode: "none" };
      activeCandidateId?: never;
      provenance?: never;
      roles: NonReadyRoleReadinessMap;
    })
  | (ProfileToolchainStateBase & {
      selection: { mode: "managed" };
      activeCandidateId?: never;
      provenance?: never;
      roles: NonReadyRoleReadinessMap;
    })
  | (ProfileToolchainStateBase & {
      selection: { mode: "managed" };
      activeCandidateId: string;
      provenance: "managed-package";
      roles: RoleReadinessMap;
    })
  | (ProfileToolchainStateBase & {
      selection: LocalToolchainSourceSelection;
      activeCandidateId?: string;
      provenance?: "unverified-local";
      roles: NonReadyRoleReadinessMap;
    })
  | (ProfileToolchainStateBase & {
      selection: LocalToolchainSourceSelection;
      activeCandidateId: string;
      provenance: "platform-certified" | "certified-local";
      roles: RoleReadinessMap;
    });

export type UiReadinessStatus =
  | "not_available"
  | "checker_only"
  | "submission_ready";

export function deriveUiReadinessStatus(
  roles: RoleReadinessMap,
): UiReadinessStatus {
  if (roles.submission.state === "ready") return "submission_ready";
  if (roles.checker.state === "ready") return "checker_only";
  return "not_available";
}

export interface CertifiedPathIdentity {
  canonicalPath: string;
  kind: "file" | "directory";
  fileIdentity?: string;
  sizeBytes?: number;
  modifiedAt?: string;
  sha256?: string;
  treeDigest?: string;
}

export interface CertifiedToolchainIdentity {
  executable: CertifiedPathIdentity;
  family: string;
  version: string;
  build: string;
  distributor?: string;
  target: string;
}

export interface CertifiedHostIdentity {
  platform: HostPlatform;
  architecture: HostArchitecture;
  osVersion: string;
  osBuild?: string;
}

export type ToolchainDeploymentIdentity =
  | {
      kind: "managed-package";
      packageId: string;
      packageDigest: string;
    }
  | {
      kind: "platform-toolchain";
      platformIdentity: string;
    }
  | {
      kind: "local-snapshot";
      snapshotDigest: string;
    }
  | {
      kind: "certified-local-root";
      installationFingerprint: string;
    };

export interface CertificationProbeResult {
  probeId: string;
  result: "passed";
  evidenceDigest: string;
  completedAt: string;
}

/** A certificate records evidence; current readiness still requires revalidation. */
export interface ToolchainCertificate {
  schemaVersion: 1;
  certificateId: string;
  profile: LanguageProfileRef;
  certifiedRoles: NonEmptyReadonlyArray<ToolchainRole>;
  candidateFingerprint: string;
  host: CertifiedHostIdentity;
  toolchain: CertifiedToolchainIdentity;
  helperExecutables: readonly CertifiedPathIdentity[];
  supportRoots: readonly CertifiedPathIdentity[];
  dependencyClosureDigest: string;
  recipeDigest: string;
  deployment: ToolchainDeploymentIdentity;
  executorVersion: string;
  sandboxPolicyVersion: string;
  probeSuiteVersion: string;
  probes: NonEmptyReadonlyArray<CertificationProbeResult>;
  issuedAt: string;
}

export interface ToolchainCertificateCacheV1 {
  schemaVersion: 1;
  /** Keyed by certificateId; candidate fingerprints are not globally unique. */
  certificates: Readonly<
    Record<string, ToolchainCertificate | undefined>
  >;
}

interface ArtifactBundleBase {
  treeDigest: string;
  fileCount: number;
  totalBytes: number;
}

export interface NativeFileArtifactBundle extends ArtifactBundleBase {
  kind: "native-file";
  entrypoint: { kind: "relative-file"; path: string };
  fileCount: 1;
  executablePaths: readonly [string];
}

export interface NativeBundleArtifactBundle extends ArtifactBundleBase {
  kind: "native-bundle";
  entrypoint: { kind: "relative-file"; path: string };
  executablePaths: NonEmptyReadonlyArray<string>;
}

export interface ScriptSourceArtifactBundle extends ArtifactBundleBase {
  kind: "script-source";
  entrypoint: { kind: "relative-file"; path: string };
  fileCount: 1;
  executablePaths: readonly [];
}

export interface DirectoryEntryArtifactBundle extends ArtifactBundleBase {
  kind: "directory-entry";
  entrypoint: {
    kind: "directory-symbol";
    directory: string;
    symbol: string;
  };
  executablePaths: readonly [];
}

export interface ManagedBundleArtifactBundle extends ArtifactBundleBase {
  kind: "managed-bundle";
  entrypoint: { kind: "relative-file"; path: string };
  executablePaths: readonly [];
}

export type ArtifactBundle =
  | NativeFileArtifactBundle
  | NativeBundleArtifactBundle
  | ScriptSourceArtifactBundle
  | DirectoryEntryArtifactBundle
  | ManagedBundleArtifactBundle;

interface PreparedProgramBase {
  profile: LanguageProfileRef;
  certificate: {
    id: string;
    fingerprint: string;
  };
}

interface LaunchSpecBase {
  args: readonly string[];
  environment: Readonly<Record<string, string>>;
}

export type PreparedProgram =
  | (PreparedProgramBase & {
      artifact: NativeFileArtifactBundle | NativeBundleArtifactBundle;
      launch: LaunchSpecBase & {
        executable: { kind: "artifact-entrypoint" };
      };
    })
  | (PreparedProgramBase & {
      artifact:
        | ScriptSourceArtifactBundle
        | DirectoryEntryArtifactBundle
        | ManagedBundleArtifactBundle;
      launch: LaunchSpecBase & {
        executable: {
          kind: "toolchain-component";
          componentId: string;
        };
      };
    });
