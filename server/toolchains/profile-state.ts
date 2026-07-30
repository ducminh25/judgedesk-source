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
} from "../languages/registry.js";
import {
  getDiscoveredCandidates,
  getToolchainDiscoverySnapshot,
  type DiscoveredToolchainCandidate,
  type ToolchainDiscoverySnapshot,
} from "./discovery.js";
import { getInstallProgress } from "./installer.js";
import { getDescriptorForHost } from "./manifest.js";
import { inspectInstalledToolchainPackage } from "./package-store.js";
import { getStoredProfilePreference } from "./preferences-v2.js";
import {
  isPythonCheckerReady,
  isPythonSubmissionReady,
  chooseNativeProtectedToolchain,
  resolveManagedToolchain,
  resolveToolchain,
} from "./resolver.js";
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
  selection: {
    mode: ToolchainSourceMode;
    localPath?: string;
  };
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

function isProfileSupportedOnHost(
  supportedHosts: readonly { platform: string; arch: string }[],
): boolean {
  const architecture = mappedHostArchitecture();
  if (!architecture) return false;
  return supportedHosts.some(
    (host) => host.platform === os.platform() && host.arch === architecture,
  );
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
): ProfileManagedPackage | undefined {
  const catalogEntry = getDescriptorForHost(os.platform(), os.arch(), kind);
  if (!catalogEntry) return undefined;
  const manifestEntry = manifest.find((entry) => entry.id === catalogEntry.id);
  const installedState = inspectInstalledToolchainPackage(catalogEntry);
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
    && active.kind === "cpp"
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
): LanguageProfileState {
  const preferences = loadToolchainPreferenceSnapshot();
  const discovery = getToolchainDiscoverySnapshot();
  const architecture = mappedHostArchitecture();
  const profiles = listRegisteredLanguageProfiles().map((entry) => {
    const { profile, toolchainKind: kind } = entry;
    const supportedOnHost = isProfileSupportedOnHost(profile.supportedHosts);
    const selection = getStoredProfilePreference(
      preferences.preferences,
      profile.ref.id,
    );
    const selected = resolveToolchain(kind);
    const active = kind === "cpp"
      ? chooseNativeProtectedToolchain(
          os.platform(),
          kind,
          resolveManagedToolchain(kind),
          selected,
        )
      : selected;
    let submissionReady = kind === "python"
      ? isPythonSubmissionReady(selected)
      : active.ready;
    let checkerReady = kind === "python"
      ? isPythonCheckerReady(selected)
      : active.ready;
    if (!supportedOnHost || preferences.status === "recovery") {
      submissionReady = false;
      checkerReady = false;
    }
    const managedPackage = managedPackageState(kind, manifest);
    const managedSupported = !!getDescriptorForHost(
      os.platform(),
      architecture || os.arch(),
      kind,
    );
    const sources: LanguageProfileView["sources"] = {
      none: { available: true },
      managed: managedSupported
        ? { available: true }
        : {
            available: false,
            reasonCode: "MANAGED_PACKAGE_UNSUPPORTED",
          },
      local_path: supportedOnHost
        ? { available: true }
        : {
            available: false,
            reasonCode: "PROFILE_UNSUPPORTED_ON_HOST",
          },
      local_auto: supportedOnHost
        ? { available: true }
        : {
            available: false,
            reasonCode: "PROFILE_UNSUPPORTED_ON_HOST",
          },
    };
    const localSelection = selection.mode === "local_path" || selection.mode === "local_auto";
    const certificationSupported = kind === "cpp" && os.platform() === "win32";
    const selectedLocalPathAvailable = selection.mode === "local_path"
      ? !!selection.localPath
      : selection.mode === "local_auto"
        ? getDiscoveredCandidates(kind).length === 1
        : false;
    return {
      id: profile.ref.id,
      version: profile.ref.version,
      displayNameKey: profile.displayNameKey,
      stability: profile.stability,
      extensions: profile.extensions,
      kind,
      supportedOnHost,
      selection,
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
