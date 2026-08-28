import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../../api.js";

export type ToolchainSourceMode =
  | "none"
  | "managed"
  | "local_path"
  | "local_auto";

export type ToolchainKind =
  | "cpp"
  | "c"
  | "python"
  | "pascal"
  | "go"
  | "java"
  | "rust"
  | "javascript"
  | "csharp"
  | "scratch";

export interface ToolchainProgress {
  id: string;
  status:
    | "idle"
    | "downloading"
    | "extracting"
    | "verifying"
    | "success"
    | "failed";
  percent: number;
  bytesReceived: number;
  totalBytes: number;
  error?: string;
}

export interface ToolchainDescriptor {
  id: string;
  kind: ToolchainKind;
  version: string;
  platform: string;
  arch: string;
  downloadUrl: string;
  sha256: string;
  archiveFormat: string;
  executableRelativePath: string;
  licenseFiles: string[];
  sizeBytes?: number;
  installed: boolean;
  origin?: "built-in" | "downloaded";
  integrity?: "verified-receipt" | "legacy-entrypoint";
  uninstallable: boolean;
  packageDiagnostic?: string;
  progress: ToolchainProgress;
}

export interface ResolvedToolchain {
  kind: ToolchainKind;
  source: "none" | "managed" | "custom" | "system" | "sandbox";
  executablePath: string;
  version: string;
  ready: boolean;
  diagnostic?: string;
  diagnosticCode?: string;
  candidateId?: string;
  provenance?: "managed-package" | "platform-certified" | "certified-local" | "unverified-local";
  certificateId?: string;
  certificateIssuedAt?: string;
  snapshotDigest?: string;
  packageOrigin?: "built-in" | "downloaded";
  packageDigest?: string;
  packageRoot?: string;
  localProbe?: {
    status: "not_started" | "checking" | "compatible" | "incompatible";
    checkedAt?: string;
    diagnostic?: string;
  };
}

export interface ToolchainCertificationPlan {
  profileId: string;
  mode: "local-snapshot";
  canonicalExecutablePath: string;
  sourceRoot: string;
  relativeExecutablePath: string;
  fileCount: number;
  totalBytes: number;
  maxSupportedSnapshotBytes: number;
}

export interface ToolchainDiagnosticResult {
  success: boolean;
  profileId: string;
  language: string;
  sourceMode?: string;
  version?: string;
  phase: "configuration" | "compilation" | "execution";
  compileTimeMs?: number;
  executionTimeMs?: number;
  peakMemoryKb?: number;
  stdout?: string;
  error?: string;
}

export interface DiscoveredToolchainCandidate {
  candidateId: string;
  profileId: string;
  kind: ToolchainKind;
  canonicalPath: string;
  displayPath: string;
  origin: "path" | "standard-location" | "selected-path";
  pathRank?: number | null;
  family?: string | null;
  version?: string | null;
  target?: string | null;
  lastSeenAt?: string;
  error?: string | null;
}

export interface LanguageProfileView {
  id: string;
  version: number;
  displayNameKey: string;
  stability: "stable" | "experimental";
  extensions: string[];
  kind: ToolchainKind;
  supportedOnHost: boolean;
  localPolicy: {
    supportedVersions: string[];
    executionMode:
      | "quick_verified_direct"
      | "platform_certified_direct"
      | "freeze_required"
      | "managed_only"
      | "unsupported";
  };
  selection: { mode: ToolchainSourceMode; localPath?: string };
  detected: boolean;
  status: "not_available" | "checker_only" | "submission_ready";
  roles: { submissionReady: boolean; checkerReady: boolean };
  diagnostic?: { code: string; messageKey: string; message?: string };
  active: ResolvedToolchain;
  provenance?: "managed-package" | "platform-certified" | "certified-local" | "unverified-local";
  candidates: DiscoveredToolchainCandidate[];
  sources: Record<
    ToolchainSourceMode,
    { available: boolean; reasonCode?: string }
  >;
  managedPackage?: {
    id: string;
    version: string;
    installed: boolean;
    origin?: "built-in" | "downloaded";
    integrity?: "verified-receipt" | "legacy-entrypoint";
    uninstallable: boolean;
    downloadAvailable: boolean;
    progress: ToolchainProgress;
  };
  certification?: {
    supported: boolean;
    required: boolean;
    canCertify: boolean;
    certificateId?: string;
    issuedAt?: string;
    snapshotDigest?: string;
  };
}

export interface ToolchainState {
  distribution: "full" | "core" | "development";
  platform: string;
  arch: string;
  mutationsBlocked: boolean;
  manifestStatus: "not_started" | "loading" | "ready" | "failed";
  manifestError?: string;
  preferenceDocument: {
    status: "ready" | "initialized" | "migrated" | "recovery";
    revision: string;
    recoveryDiagnostics: Array<{ code: string }>;
  };
  registryRevision: number;
  discovery: {
    status: "not_started" | "running" | "complete" | "failed";
    refreshing: boolean;
    completedAt?: string;
    errorCode?: string;
  };
  executionPolicy: {
    schemaVersion: 1;
    allowResourceOnlyLocalExecution: boolean;
    status: "default" | "ready" | "recovery";
    diagnostic?: "INVALID_POLICY_DOCUMENT" | "POLICY_READ_FAILED";
  };
  profiles: LanguageProfileView[];
  preferences: {
    customCppPath?: string;
    customPythonPath?: string;
    preferredSourceCpp?: "managed" | "custom" | "system";
    preferredSourcePython?: "managed" | "custom" | "system";
    installedToolchains?: string[];
  };
  active: {
    cpp: ResolvedToolchain;
    python: ResolvedToolchain;
  };
  capabilities: {
    cpp: ToolchainCapabilities;
    python: ToolchainCapabilities;
  };
  toolchains: ToolchainDescriptor[];
}

export interface ToolchainCapabilities {
  detected: boolean;
  managed: boolean;
  submissionReady: boolean;
  checkerReady: boolean;
  installable: boolean;
}

export function hasRunningOperation(state: ToolchainState): boolean {
  return state.discovery.status === "running"
    || state.discovery.refreshing
    || state.profiles.some((profile) =>
      profile.active.localProbe?.status === "not_started"
      || profile.active.localProbe?.status === "checking")
    || state.manifestStatus === "loading"
    || state.toolchains.some((toolchain) =>
      ["downloading", "extracting", "verifying"].includes(
        toolchain.progress.status,
      ))
    || state.profiles.some((profile) => profile.managedPackage
      && ["downloading", "extracting", "verifying"].includes(
        profile.managedPackage.progress.status,
      ));
}

export function useToolchains() {
  const [state, setState] = useState<ToolchainState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollingRef = useRef<number | null>(null);
  const pollingMountedRef = useRef(false);
  const initialRetryRef = useRef<number | null>(null);

  const fetchState = useCallback(async () => {
    try {
      const response = await apiFetch("/api/toolchains");
      const data = (await response.json()) as ToolchainState;
      setState(data);
      setError(null);
      return data;
    } catch (caught: any) {
      setError(caught.message || "Failed to load toolchains state.");
      return null;
    }
  }, []);

  const startPolling = useCallback(() => {
    if (pollingRef.current) return;
    const poll = async () => {
      const data = await fetchState();
      if (!pollingMountedRef.current) {
        pollingRef.current = null;
        return;
      }
      if (data && !hasRunningOperation(data)) {
        pollingRef.current = null;
        return;
      }
      pollingRef.current = window.setTimeout(() => void poll(), 1000);
    };
    pollingRef.current = window.setTimeout(() => void poll(), 1000);
  }, [fetchState]);

  useEffect(() => {
    let disposed = false;
    pollingMountedRef.current = true;
    const loadInitialState = async (retriesRemaining: number) => {
      const data = await fetchState();
      if (disposed) return;
      if (data) {
        if (hasRunningOperation(data)) startPolling();
      } else if (retriesRemaining > 0) {
        initialRetryRef.current = window.setTimeout(
          () => void loadInitialState(retriesRemaining - 1),
          500,
        );
      }
    };
    void loadInitialState(10);
    return () => {
      disposed = true;
      pollingMountedRef.current = false;
      if (initialRetryRef.current) clearTimeout(initialRetryRef.current);
      if (pollingRef.current) clearTimeout(pollingRef.current);
      initialRetryRef.current = null;
      pollingRef.current = null;
    };
  }, [fetchState, startPolling]);

  const install = async (id: string) => {
    try {
      setError(null);
      await apiFetch(`/api/toolchains/${id}/install`, { method: "POST" });
      startPolling();
      return true;
    } catch (caught: any) {
      setError(caught.message);
      return false;
    }
  };

  const cancel = async (id: string) => {
    try {
      await apiFetch(`/api/toolchains/${id}/cancel`, { method: "POST" });
      await fetchState();
    } catch (caught: any) {
      setError(caught.message);
    }
  };

  const uninstall = async (id: string) => {
    try {
      setError(null);
      await apiFetch(`/api/toolchains/${id}`, { method: "DELETE" });
      await fetchState();
      return true;
    } catch (caught: any) {
      setError(caught.message);
      return false;
    }
  };

  const setProfilePreference = async (
    profileId: string,
    mode: ToolchainSourceMode,
    localPath?: string,
  ) => {
    try {
      setError(null);
      await apiFetch(`/api/toolchains/profiles/${encodeURIComponent(profileId)}/preference`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          ...(localPath === undefined ? {} : { localPath }),
        }),
      });
      await fetchState();
      return true;
    } catch (caught: any) {
      setError(caught.message);
      return false;
    }
  };

  const rescan = async () => {
    try {
      setError(null);
      await apiFetch("/api/toolchains/rescan", { method: "POST" });
      await fetchState();
      startPolling();
    } catch (caught: any) {
      setError(caught.message);
    }
  };

  const setResourceOnlyLocalExecution = async (
    allowResourceOnlyLocalExecution: boolean,
  ): Promise<boolean> => {
    try {
      setError(null);
      await apiFetch("/api/toolchains/execution-policy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowResourceOnlyLocalExecution }),
      });
      await fetchState();
      return true;
    } catch (caught: any) {
      setError(caught.message);
      await fetchState();
      return false;
    }
  };

  const planCertification = async (
    profileId: string,
  ): Promise<ToolchainCertificationPlan | null> => {
    try {
      setError(null);
      const response = await apiFetch(
        `/api/toolchains/profiles/${encodeURIComponent(profileId)}/certification-plan`,
        { method: "POST" },
      );
      const payload = (await response.json()) as {
        success: true;
        plan: ToolchainCertificationPlan;
      };
      return payload.plan;
    } catch (caught: any) {
      setError(caught.message);
      return null;
    }
  };

  const certify = async (profileId: string): Promise<boolean> => {
    try {
      setError(null);
      await apiFetch(`/api/toolchains/profiles/${encodeURIComponent(profileId)}/certify`, {
        method: "POST",
      });
      await fetchState();
      return true;
    } catch (caught: any) {
      setError(caught.message);
      await fetchState();
      return false;
    }
  };

  const diagnoseProfile = async (
    profileId: string,
  ): Promise<ToolchainDiagnosticResult | null> => {
    try {
      setError(null);
      const response = await apiFetch(
        `/api/toolchains/profiles/${encodeURIComponent(profileId)}/diagnose`,
        { method: "POST" },
      );
      const payload = (await response.json()) as {
        success: boolean;
        diagnostic: ToolchainDiagnosticResult;
        message?: string;
      };
      return payload.diagnostic ?? {
        success: false,
        profileId,
        language: "unknown",
        phase: "configuration",
        error: payload.message || "Diagnostic probe failed.",
      };
    } catch (caught: any) {
      setError(caught.message);
      return {
        success: false,
        profileId,
        language: "unknown",
        phase: "configuration",
        error: caught.message,
      };
    }
  };

  return {
    state,
    error,
    refresh: fetchState,
    install,
    cancel,
    uninstall,
    setProfilePreference,
    setResourceOnlyLocalExecution,
    rescan,
    planCertification,
    certify,
    diagnoseProfile,
  };
}
