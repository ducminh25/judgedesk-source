import os from "node:os";
import type {
  LanguageStability,
  ReadinessReasonCode,
  SourceExtension,
  ToolchainSourceMode,
  UiReadinessStatus,
} from "../languages/contracts.js";
import {
  LANGUAGE_REGISTRY_REVISION,
  listRegisteredLanguageProfiles,
  type LocalExecutionMode,
} from "../languages/registry.js";
import {
  toolchainVersionPolicyLabels,
} from "../languages/version-policy.js";
import {
  getDiscoveredCandidates,
  getToolchainDiscoverySnapshot,
  type DiscoveredToolchainCandidate,
  type ToolchainDiscoverySnapshot,
} from "./discovery.js";
import { getInstallProgress } from "./installer.js";
import { getDescriptorForHost } from "./manifest.js";
import {
  inspectInstalledToolchainPackage,
  type InstalledToolchainPackageInspector,
} from "./package-store.js";
import { getStoredProfilePreference } from "./preferences-v2.js";
import { resolveCachedToolchainSelection } from "./cached-resolution.js";
import {
  loadToolchainPreferenceSnapshot,
  type ToolchainPreferenceSnapshot,
} from "./storage.js";
import type {
  InstallProgress,
  ResolvedToolchain,
  ToolchainDescriptor,
  ToolchainKind,
} from "./types.js";
import {
  getHostProductVersion,
  isMinimumOsSupported,
} from "./host-compatibility.js";
import { TOOLCHAIN_RELEASE_BLUEPRINTS } from "./manifest.js";

export interface ProfileSourceAvailability {
  available: boolean;
  reasonCode?: ReadinessReasonCode;
}

export interface ProfileManagedPackage {
  id: string;
  version: string;
  installed: boolean;
  origin?: "built-in" | "downloaded";
  integrity?: "verified-receipt" | "legacy-entrypoint";
  uninstallable: boolean;
  downloadAvailable: boolean;
  progress: InstallProgress;
}

export interface LanguageProfileView {
  id: string;
  version: number;
  displayNameKey: string;
  stability: LanguageStability;
  extensions: readonly SourceExtension[];
  kind: ToolchainKind;
  supportedOnHost: boolean;
  localPolicy: {
    supportedVersions: readonly string[];
    executionMode: LocalExecutionMode | "unsupported";
  };
  selection: {
    mode: ToolchainSourceMode;
    localPath?: string;
  };
  /** The selected source was found, independently of judging readiness. */
  detected: boolean;
  status: UiReadinessStatus;
  roles: {
    submissionReady: boolean;
    checkerReady: boolean;
  };
  diagnostic?: {
    code: ReadinessReasonCode;
    messageKey: string;
    message?: string;
  };
  active: ResolvedToolchain;
  provenance?: "managed-package" | "platform-certified" | "certified-local" | "unverified-local";
  candidates: readonly DiscoveredToolchainCandidate[];
  sources: Record<ToolchainSourceMode, ProfileSourceAvailability>;
  managedPackage?: ProfileManagedPackage;
  certification?: {
    supported: boolean;
    required: boolean;
    canCertify: boolean;
    certificateId?: string;
    issuedAt?: string;
    snapshotDigest?: string;
  };
}

export interface LanguageProfileState {
  registryRevision: number;
  preferenceStatus: ToolchainPreferenceSnapshot["status"];
  preferenceRevision: string;
  recoveryDiagnostics: ToolchainPreferenceSnapshot["recoveryDiagnostics"];
  discovery: ToolchainDiscoverySnapshot;
  profiles: readonly LanguageProfileView[];
}

function mappedHostArchitecture(): "x64" | "arm64" | null {
  const architecture = os.arch();
  if (architecture === "x64" || architecture === "arm64") return architecture;
  return null;
}

function mappedHostPlatform(): "win32" | "darwin" | null {
  const platform = os.platform();
  return platform === "win32" || platform === "darwin" ? platform : null;
}

function isProfileSupportedOnHost(
  supportedHosts: readonly {
    platform: string;
    arch: string;
    minimumOs: string;
  }[],
): boolean {
  const architecture = mappedHostArchitecture();
  if (!architecture) return false;
  const host = supportedHosts.find(
    (candidate) =>
      candidate.platform === os.platform()
      && candidate.arch === architecture,
  );
  return !!host
    && isMinimumOsSupported(host.minimumOs, getHostProductVersion());
}

function defaultProgress(id: string): InstallProgress {
  return {
    id,
    status: "idle",
    percent: 0,
    bytesReceived: 0,
    totalBytes: 0,
  };
}

function managedPackageState(
  kind: ToolchainKind,
  manifest: readonly ToolchainDescriptor[],
  inspectInstalledPackage: InstalledToolchainPackageInspector,
): ProfileManagedPackage | undefined {
  if (kind === "scratch") {
    return {
      id: "scratch-turbowarp-v1",
      version: "1.0.0",
      installed: true,
      origin: "built-in",
      uninstallable: false,
      downloadAvailable: false,
      progress: defaultProgress("scratch-turbowarp-v1"),
    };
  }
  const catalogEntry = getDescriptorForHost(os.platform(), os.arch(), kind);
  if (!catalogEntry) return undefined;
  const manifestEntry = manifest.find((entry) => entry.id === catalogEntry.id);
  const installedState = inspectInstalledPackage(catalogEntry, { kind });
  const installed = installedState.status === "installed"
    ? installedState.package
    : undefined;
  return {
    id: catalogEntry.id,
    version: catalogEntry.version,
    installed: !!installed,
    ...(installed
      ? {
          origin: installed.origin,
          integrity: installed.integrity,
        }
      : {}),
    uninstallable: installed?.uninstallable ?? false,
    downloadAvailable: !!manifestEntry,
    progress: getInstallProgress(catalogEntry.id) || defaultProgress(catalogEntry.id),
  };
}

function statusFromRoles(
  submissionReady: boolean,
  checkerReady: boolean,
): UiReadinessStatus {
  if (submissionReady) return "submission_ready";
  if (checkerReady) return "checker_only";
  return "not_available";
}

function diagnosticFor(
  supportedOnHost: boolean,
  selectionMode: ToolchainSourceMode,
  active: ResolvedToolchain,
  submissionReady: boolean,
  checkerReady: boolean,
): LanguageProfileView["diagnostic"] {
  if (!supportedOnHost) {
    return {
      code: "PROFILE_UNSUPPORTED_ON_HOST",
      messageKey: "toolchains.diagnostics.PROFILE_UNSUPPORTED_ON_HOST",
    };
  }
  if (submissionReady || checkerReady) return undefined;
  let code = active.diagnosticCode;
  if (!code && selectionMode === "none") code = "DISABLED_BY_USER";
  if (
    !code
    && active.ready
    && (selectionMode === "local_auto" || selectionMode === "local_path")
  ) {
    code = "CERTIFICATION_REQUIRED";
  }
  code ||= "HEALTH_CHECK_FAILED";
  return {
    code,
    messageKey: `toolchains.diagnostics.${code}`,
    ...(active.diagnostic ? { message: active.diagnostic } : {}),
  };
}

function provenanceFor(
  active: ResolvedToolchain,
  submissionReady: boolean,
  checkerReady: boolean,
): LanguageProfileView["provenance"] {
  if (active.provenance === "certified-local") return "certified-local";
  if (active.source === "managed") return "managed-package";
  if (
    os.platform() === "darwin"
    && (active.kind === "cpp" || active.kind === "c")
    && (submissionReady || checkerReady)
  ) {
    return "platform-certified";
  }
  if (active.source === "custom" || active.source === "system") {
    return "unverified-local";
  }
  return undefined;
}

export function buildLanguageProfileState(
  manifest: readonly ToolchainDescriptor[],
  options: {
    inspectInstalledPackage?: InstalledToolchainPackageInspector;
  } = {},
): LanguageProfileState {
  const inspectInstalledPackage = options.inspectInstalledPackage
    ?? inspectInstalledToolchainPackage;
  const preferences = loadToolchainPreferenceSnapshot();
  const discovery = getToolchainDiscoverySnapshot();
  const architecture = mappedHostArchitecture();
  const platform = mappedHostPlatform();
  const profiles = listRegisteredLanguageProfiles().map((entry) => {
    const { profile, toolchainKind: kind } = entry;
    const supportedOnHost = isProfileSupportedOnHost(profile.supportedHosts);
    const localExecution = entry.localExecution.find(
      (candidate) =>
        candidate.platform === platform
        && candidate.arch === architecture,
    );
    const selection = getStoredProfilePreference(
      preferences.preferences,
      profile.ref.id,
    );
    const cachedResolution = resolveCachedToolchainSelection(
      kind,
      selection,
      inspectInstalledPackage,
    );
    const active = cachedResolution.active;
    let submissionReady = active.ready;
    let checkerReady = !!profile.roles.checker && active.ready;
    if (!supportedOnHost || preferences.status === "recovery") {
      submissionReady = false;
      checkerReady = false;
    }
    const managedPackage = managedPackageState(kind, manifest, inspectInstalledPackage);
    const managedSupported = kind === "scratch"
      || !!getDescriptorForHost(
        os.platform(),
        architecture || os.arch(),
        kind,
      );
    const managedDescriptor = getDescriptorForHost(
      os.platform(),
      architecture || os.arch(),
      kind,
    );
    const managedMinimumOs = managedDescriptor
      ? TOOLCHAIN_RELEASE_BLUEPRINTS[managedDescriptor.id]?.minimumOs
      : undefined;
    const managedHostSupported = kind === "scratch"
      || (managedSupported
        && (!managedMinimumOs
          || isMinimumOsSupported(
            managedMinimumOs,
            getHostProductVersion(),
          )));
    const sources: LanguageProfileView["sources"] = {
      none: { available: true },
      managed: managedHostSupported
        ? { available: true }
        : {
            available: false,
            reasonCode: managedSupported
              ? "MINIMUM_OS_UNSUPPORTED"
              : "MANAGED_PACKAGE_UNSUPPORTED",
          },
      local_path: supportedOnHost && localExecution?.mode !== "managed_only"
        ? { available: true }
        : {
            available: false,
            reasonCode: localExecution?.mode === "managed_only"
              ? "LOCAL_NOT_SANDBOX_COMPATIBLE"
              : "PROFILE_UNSUPPORTED_ON_HOST",
          },
      local_auto: supportedOnHost && localExecution?.mode !== "managed_only"
        ? { available: true }
        : {
            available: false,
            reasonCode: localExecution?.mode === "managed_only"
              ? "LOCAL_NOT_SANDBOX_COMPATIBLE"
              : "PROFILE_UNSUPPORTED_ON_HOST",
          },
    };
    const localSelection = selection.mode === "local_path" || selection.mode === "local_auto";
    const certificationSupported = kind === "cpp"
      && os.platform() === "win32"
      && localExecution?.mode === "freeze_required";
    const selectedLocalPathAvailable = !!cachedResolution.candidate;
    return {
      id: profile.ref.id,
      version: profile.ref.version,
      displayNameKey: profile.displayNameKey,
      stability: profile.stability,
      extensions: profile.extensions,
      kind,
      supportedOnHost,
      localPolicy: {
        supportedVersions: toolchainVersionPolicyLabels(
          entry.localVersionPolicy,
          platform && architecture
            ? { platform, arch: architecture }
            : undefined,
        ),
        executionMode: localExecution?.mode ?? "unsupported",
      },
      selection,
      detected: cachedResolution.detected,
      status: statusFromRoles(submissionReady, checkerReady),
      roles: { submissionReady, checkerReady },
      diagnostic: diagnosticFor(
        supportedOnHost,
        selection.mode,
        active,
        submissionReady,
        checkerReady,
      ),
      active,
      provenance: provenanceFor(active, submissionReady, checkerReady),
      candidates: getDiscoveredCandidates(kind),
      sources,
      ...(managedPackage ? { managedPackage } : {}),
      ...(kind === "cpp"
        ? {
            certification: {
              supported: certificationSupported,
              required: certificationSupported && localSelection && !submissionReady,
              canCertify:
                certificationSupported
                && localSelection
                && selectedLocalPathAvailable
                && !submissionReady,
              ...(active.certificateId ? { certificateId: active.certificateId } : {}),
              ...(active.certificateIssuedAt ? { issuedAt: active.certificateIssuedAt } : {}),
              ...(active.snapshotDigest ? { snapshotDigest: active.snapshotDigest } : {}),
            },
          }
        : {}),
    } satisfies LanguageProfileView;
  });
  return {
    registryRevision: LANGUAGE_REGISTRY_REVISION,
    preferenceStatus: preferences.status,
    preferenceRevision: preferences.revision,
    recoveryDiagnostics: preferences.recoveryDiagnostics,
    discovery,
    profiles,
  };
}
