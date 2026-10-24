import os from "node:os";
import path from "node:path";
import type { StoredProfileToolchainPreference } from "../languages/contracts.js";
import {
  getLocalExecutionModeForHost,
  getRegisteredProfileForKind,
} from "../languages/registry.js";
import {
  isToolchainVersionAllowed,
  resolveToolchainVersionPolicyForHost,
} from "../languages/version-policy.js";
import {
  getDiscoveredCandidates,
  getToolchainDiscoverySnapshot,
  type DiscoveredToolchainCandidate,
} from "./discovery.js";
import {
  getDescriptorForHost,
  TOOLCHAIN_RELEASE_BLUEPRINTS,
} from "./manifest.js";
import {
  inspectInstalledToolchainPackage,
  type InstalledToolchainPackageInspector,
} from "./package-store.js";
import {
  isManagedHostSupported,
} from "./host-compatibility.js";
import {
  localExecutionFields,
  resolveCachedLocalExecution,
} from "./local-execution.js";
import {
  localCppCertificateExecutionFields,
  resolveLocalCppCertificateReadiness,
} from "./certificate-readiness.js";
import type {
  ResolvedToolchain,
  ToolchainKind,
  ToolchainSource,
} from "./types.js";

export interface CachedToolchainResolution {
  active: ResolvedToolchain;
  /** Detection is separate from judging readiness for compatibility-local runtimes. */
  detected: boolean;
  candidate?: DiscoveredToolchainCandidate;
}

function unavailable(
  kind: ToolchainKind,
  source: ToolchainSource,
  diagnostic: string,
  diagnosticCode: NonNullable<ResolvedToolchain["diagnosticCode"]>,
  executablePath = "",
  version = "",
): ResolvedToolchain {
  return {
    kind,
    source,
    executablePath,
    version,
    ready: false,
    diagnostic,
    diagnosticCode,
  };
}

/**
 * Resolves a managed package from its bounded receipt/component state only.
 * It deliberately never launches the compiler/runtime from a status request.
 */
export function resolveCachedManagedToolchain(
  kind: ToolchainKind,
  inspectInstalledPackage: InstalledToolchainPackageInspector = inspectInstalledToolchainPackage,
): ResolvedToolchain {
  const descriptor = getDescriptorForHost(os.platform(), os.arch(), kind);
  if (!descriptor) {
    return unavailable(
      kind,
      "managed",
      "Managed toolchain is not supported on this host.",
      "MANAGED_PACKAGE_UNSUPPORTED",
    );
  }
  const minimumOs = TOOLCHAIN_RELEASE_BLUEPRINTS[descriptor.id]?.minimumOs;
  if (
    minimumOs
    && !isManagedHostSupported(os.platform(), minimumOs)
  ) {
    return unavailable(
      kind,
      "managed",
      `Managed package requires ${os.platform()} ${minimumOs} or newer.`,
      "MINIMUM_OS_UNSUPPORTED",
      "",
      descriptor.version,
    );
  }
  const installed = inspectInstalledPackage(descriptor, { kind });
  if (installed.status === "installed") {
    return {
      kind,
      source: "managed",
      executablePath: installed.package.executablePath,
      version: descriptor.version,
      ready: true,
      provenance: "managed-package",
      packageOrigin: installed.package.origin,
      packageRoot: installed.package.root,
      packageComponentId: installed.package.componentId,
      ...(installed.package.packageDigest
        ? { packageDigest: installed.package.packageDigest }
        : {}),
    };
  }
  if (installed.status === "corrupt") {
    return {
      ...unavailable(
        kind,
        "managed",
        installed.diagnostic,
        "MANAGED_PACKAGE_CORRUPT",
        "",
        descriptor.version,
      ),
      packageOrigin: installed.origin,
      packageRoot: installed.root,
    };
  }
  return unavailable(
    kind,
    "managed",
    "Managed toolchain not installed.",
    "MANAGED_PACKAGE_NOT_INSTALLED",
    "",
    descriptor.version,
  );
}

function mappedHost(): {
  platform: "win32" | "darwin" | "linux";
  arch: "x64" | "arm64";
} | null {
  const platform = os.platform();
  const arch = os.arch();
  if (
    (platform !== "win32" && platform !== "darwin" && platform !== "linux")
    || (arch !== "x64" && arch !== "arm64")
  ) {
    return null;
  }
  return { platform, arch };
}

function sameLocalPath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return os.platform() === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function candidateForSelection(
  kind: ToolchainKind,
  selection: StoredProfileToolchainPreference,
): DiscoveredToolchainCandidate | undefined {
  const candidates = getDiscoveredCandidates(kind);
  if (selection.mode === "local_auto") return candidates[0];
  if (selection.mode !== "local_path" || !selection.localPath) return undefined;
  return candidates.find((candidate) =>
    sameLocalPath(candidate.canonicalPath, selection.localPath!)
    || sameLocalPath(candidate.displayPath, selection.localPath!)
  );
}

function isCandidateVersionAllowed(
  kind: ToolchainKind,
  candidate: DiscoveredToolchainCandidate,
): boolean {
  if (!candidate.version || !candidate.family) return false;
  const host = mappedHost();
  if (!host) return false;
  const policy = getRegisteredProfileForKind(kind).localVersionPolicy;
  if (!isToolchainVersionAllowed(candidate.version, policy, host)) return false;
  const leafPolicy = resolveToolchainVersionPolicyForHost(policy, host);
  if (!leafPolicy) return false;
  if (leafPolicy.kind !== "exact_allowlist") return true;
  return leafPolicy.entries.some((entry) =>
    entry.family === candidate.family
    && entry.version === candidate.version
    && entry.hosts.some(
      (candidateHost) =>
        candidateHost.platform === host.platform
        && candidateHost.arch === host.arch,
    )
  );
}

function localExecutionMode(kind: ToolchainKind) {
  const host = mappedHost();
  if (!host) return undefined;
  return getLocalExecutionModeForHost(kind, host.platform, host.arch);
}

function isQuickVerifiedLocalKind(
  kind: ToolchainKind,
): kind is Extract<ToolchainKind, "cpp" | "c" | "python"> {
  return kind === "cpp" || kind === "c" || kind === "python";
}

function isApplePlatformCompiler(
  kind: ToolchainKind,
  candidate: DiscoveredToolchainCandidate,
): boolean {
  if (
    os.platform() !== "darwin"
    || (kind !== "cpp" && kind !== "c")
    || candidate.family !== "apple-clang"
  ) {
    return false;
  }
  const compiler = candidate.canonicalPath.replaceAll("\\", "/");
  return compiler.startsWith("/Library/Developer/CommandLineTools/")
    || /\/Contents\/Developer\/Toolchains\/[^/]+\.xctoolchain\//.test(compiler);
}

function resolveCachedLocalCandidate(
  kind: ToolchainKind,
  source: Extract<ToolchainSource, "custom" | "system">,
  candidate: DiscoveredToolchainCandidate,
): ResolvedToolchain {
  const version = candidate.version || "";
  if (!isCandidateVersionAllowed(kind, candidate)) {
    return {
      ...unavailable(
        kind,
        source,
        `Local ${kind} version ${version || "unknown"} is outside the tested JudgeDesk policy.`,
        "LOCAL_VERSION_UNSUPPORTED",
        candidate.canonicalPath,
        version,
      ),
      candidateId: candidate.candidateId,
      provenance: "unverified-local",
    };
  }
  const executionMode = localExecutionMode(kind);
  if (executionMode === "freeze_required") {
    if (kind === "cpp" && os.platform() === "win32") {
      const certificate = resolveLocalCppCertificateReadiness(candidate.canonicalPath);
      if (certificate.state === "ready") {
        return {
          kind,
          source,
          candidateId: candidate.candidateId,
          ...localCppCertificateExecutionFields(certificate),
        };
      }
      return {
        ...unavailable(
          kind,
          source,
          certificate.diagnostic,
          certificate.code,
          candidate.canonicalPath,
          version,
        ),
        candidateId: candidate.candidateId,
        provenance: "unverified-local",
        ...(certificate.certificateId
          ? { certificateId: certificate.certificateId }
          : {}),
      };
    }
    return {
      ...unavailable(
        kind,
        source,
        "The detected local compiler must be frozen for the secure runner before judging.",
        "CERTIFICATION_REQUIRED",
        candidate.canonicalPath,
        version,
      ),
      candidateId: candidate.candidateId,
      provenance: "unverified-local",
    };
  }
  if (executionMode === "managed_only" || !executionMode) {
    return {
      ...unavailable(
        kind,
        source,
        "The runtime was detected, but this profile currently requires a managed package for judging.",
        "LOCAL_NOT_SANDBOX_COMPATIBLE",
        candidate.canonicalPath,
        version,
      ),
      candidateId: candidate.candidateId,
      provenance: "unverified-local",
    };
  }
  if (
    executionMode === "platform_certified_direct"
    && !isApplePlatformCompiler(kind, candidate)
  ) {
    return {
      ...unavailable(
        kind,
        source,
        "The runtime was detected, but it is not in the selected Apple developer toolchain.",
        "LOCAL_NOT_SANDBOX_COMPATIBLE",
        candidate.canonicalPath,
        version,
      ),
      candidateId: candidate.candidateId,
      provenance: "unverified-local",
    };
  }
  if (executionMode === "quick_verified_direct") {
    if (!isQuickVerifiedLocalKind(kind)) {
      return {
        ...unavailable(
          kind,
          source,
          "This profile does not support direct local execution.",
          "LOCAL_NOT_SANDBOX_COMPATIBLE",
          candidate.canonicalPath,
          version,
        ),
        candidateId: candidate.candidateId,
        provenance: "unverified-local",
      };
    }
    const localExecution = resolveCachedLocalExecution(
      kind,
      candidate.canonicalPath,
    );
    return {
      kind,
      source,
      executablePath: candidate.canonicalPath,
      version,
      candidateId: candidate.candidateId,
      provenance: "unverified-local",
      ...localExecutionFields(localExecution),
    };
  }
  return {
    kind,
    source,
    executablePath: candidate.canonicalPath,
    version,
    ready: true,
    candidateId: candidate.candidateId,
    provenance: executionMode === "platform_certified_direct"
      ? "platform-certified"
      : "unverified-local",
  };
}

/** Resolves persisted intent using managed package state and discovery cache only. */
export function resolveCachedToolchainSelection(
  kind: ToolchainKind,
  selection: StoredProfileToolchainPreference,
  inspectInstalledPackage: InstalledToolchainPackageInspector = inspectInstalledToolchainPackage,
): CachedToolchainResolution {
  if (selection.mode === "none") {
    return {
      active: unavailable(
        kind,
        "none",
        "Toolchain profile is disabled by the user.",
        "DISABLED_BY_USER",
      ),
      detected: false,
    };
  }
  if (selection.mode === "managed") {
    const active = resolveCachedManagedToolchain(kind, inspectInstalledPackage);
    return { active, detected: active.ready };
  }
  const source = selection.mode === "local_path" ? "custom" : "system";
  if (selection.mode === "local_path" && !selection.localPath) {
    return {
      active: unavailable(
        kind,
        source,
        "A local executable path is required.",
        "LOCAL_PATH_REQUIRED",
      ),
      detected: false,
    };
  }
  const candidate = candidateForSelection(kind, selection);
  if (candidate) {
    return {
      active: resolveCachedLocalCandidate(kind, source, candidate),
      detected: true,
      candidate,
    };
  }
  const discovery = getToolchainDiscoverySnapshot();
  const refreshing = discovery.status === "not_started"
    || discovery.status === "running"
    || discovery.refreshing;
  const diagnosticCode = refreshing
    ? "DETECTION_IN_PROGRESS"
    : selection.mode === "local_path"
      ? "LOCAL_PATH_MISSING"
      : "AUTO_DETECT_NOT_FOUND";
  const attempted = discovery.profiles[
    getRegisteredProfileForKind(kind).profile.ref.id
  ] || [];
  let lastError: string | null | undefined;
  for (let index = attempted.length - 1; index >= 0; index -= 1) {
    if (attempted[index].error) {
      lastError = attempted[index].error;
      break;
    }
  }
  return {
    active: unavailable(
      kind,
      source,
      refreshing
        ? "Toolchain detection is refreshing in the background."
        : lastError
          ? `No local candidate passed its version probe (${lastError}).`
          : "No compatible local candidate was detected.",
      diagnosticCode,
      selection.mode === "local_path" ? selection.localPath || "" : "",
    ),
    detected: false,
  };
}
