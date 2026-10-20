import type { Express } from "express";
import { getJudgeDeskDistribution } from "../distribution.js";
import os from "node:os";
import path from "node:path";
import {
  getRegisteredLanguageProfile,
  getRegisteredProfileForKind,
} from "../languages/registry.js";
import type { ToolchainSourceMode } from "../languages/contracts.js";
import {
  getDiscoveredCandidates,
  getToolchainDiscoverySnapshot,
  requestToolchainRescan,
} from "../toolchains/discovery.js";
import {
  certifyLocalCppToolchain,
  planLocalCppCertification,
} from "../toolchains/certification.js";
import {
  cancelInstallation,
  getInstallProgress,
  installToolchain,
  uninstallToolchain,
} from "../toolchains/installer.js";
import { diagnoseLanguageProfile } from "../toolchains/diagnostics.js";
import {
  getDescriptorForHost,
  loadOfficialManifest,
  normalizeHostArchitecture,
  TOOLCHAIN_CATALOG,
} from "../toolchains/manifest.js";
import {
  createInstalledToolchainPackageInspector,
} from "../toolchains/package-store.js";
import {
  getStoredProfilePreference,
  isValidToolchainLocalPath,
} from "../toolchains/preferences-v2.js";
import { buildLanguageProfileState } from "../toolchains/profile-state.js";
import {
  clearToolchainDetectionCache,
  verifyLocalToolchainCandidate,
} from "../toolchains/resolver.js";
import { resolveCachedManagedToolchain } from "../toolchains/cached-resolution.js";
import {
  loadPreferences,
  loadToolchainPreferenceSnapshot,
  tryUpdateProfileToolchainPreferenceAtRevision,
  updateProfileToolchainPreference,
} from "../toolchains/storage.js";
import type { ToolchainKind } from "../toolchains/types.js";
import type { ToolchainDescriptor } from "../toolchains/types.js";
import {
  isCurrentReleaseToolchainKind,
} from "../toolchains/release-scope.js";
import { serverLifecycle, type ServerLifecycle } from "../platform/server-lifecycle.js";
import { toolchainMaintenanceGate } from "../toolchains/maintenance-gate.js";
import {
  loadLocalExecutionPolicy,
  saveLocalExecutionPolicy,
} from "../toolchains/execution-policy.js";
import {
  invalidateJudgePrewarm,
  startBackgroundJudgePrewarm,
} from "../judge/background-prewarm.js";

const SOURCE_MODES = new Set<ToolchainSourceMode>([
  "none",
  "managed",
  "local_path",
  "local_auto",
]);

export function isLocalPreferenceVerificationAccepted(
  verification: { ready: boolean; diagnosticCode?: string },
): boolean {
  return verification.ready
    || verification.diagnosticCode === "CERTIFICATION_REQUIRED"
    || verification.diagnosticCode === "DETECTION_IN_PROGRESS"
    || verification.diagnosticCode === "LOCAL_NOT_SANDBOX_COMPATIBLE";
}

const TOOLCHAIN_MUTATION_BLOCKED_MESSAGE =
  "Toolchain settings cannot change while judging is in progress.";

function toolchainMutationsBlocked(): boolean {
  return serverLifecycle.activeJudgeSessionCount > 0 || toolchainMaintenanceGate.locked;
}

function assertToolchainMutationAllowed(): void {
  if (toolchainMutationsBlocked()) {
    throw new Error(TOOLCHAIN_MUTATION_BLOCKED_MESSAGE);
  }
}

export type ToolchainManifestLoaderFn = (
  forceRefresh?: boolean,
) => Promise<readonly ToolchainDescriptor[]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isAcceptedLocalPath(value: unknown): value is string {
  if (!isValidToolchainLocalPath(value)) return false;
  if (os.platform() === "win32") {
    // Network shares and Win32 device namespaces are not stable local
    // certification roots and can also make a status request block on I/O.
    const windowsPath = value.replaceAll("/", "\\");
    return path.win32.isAbsolute(windowsPath) && !windowsPath.startsWith("\\\\");
  }
  return path.posix.isAbsolute(value);
}

function profileSupportsCurrentHost(profileId: string): boolean {
  const entry = getRegisteredLanguageProfile(profileId);
  if (!entry) return false;
  return entry.profile.supportedHosts.some(
    (host) => host.platform === os.platform()
      && host.arch === normalizeHostArchitecture(os.arch()),
  );
}

function selectedLocalExecutablePath(profileId: string): string {
  const entry = getRegisteredLanguageProfile(profileId);
  if (!entry) throw new Error("Unknown language profile.");
  const snapshot = loadToolchainPreferenceSnapshot();
  if (snapshot.status === "recovery") {
    throw new Error("Toolchain preferences require recovery.");
  }
  const preference = getStoredProfilePreference(snapshot.preferences, profileId);
  if (preference.mode === "local_path" && preference.localPath) {
    return preference.localPath;
  }
  if (preference.mode === "local_auto") {
    const candidates = getDiscoveredCandidates(entry.toolchainKind);
    if (candidates.length === 1) return candidates[0].canonicalPath;
    if (candidates.length > 1) {
      throw new Error("Multiple local candidates were detected; choose one explicitly.");
    }
  }
  throw new Error("Select one local compiler path before certification.");
}

export type ToolchainInstallerFn = (
  descriptor: ToolchainDescriptor,
  options?: { beforeCommit?: () => void },
) => Promise<void>;

export function registerToolchainRoutes(
  app: Express,
  installer: ToolchainInstallerFn = installToolchain,
  onBackgroundOperation?: (op: Promise<unknown>) => void,
  lifecycle: ServerLifecycle = serverLifecycle,
  manifestLoader: ToolchainManifestLoaderFn = (forceRefresh) =>
    loadOfficialManifest({ forceRefresh }),
): void {
  let manifestState: {
    status: "not_started" | "loading" | "ready" | "failed";
    entries: readonly ToolchainDescriptor[];
    error?: string;
  } = { status: "not_started", entries: [] };
  let manifestPromise: Promise<readonly ToolchainDescriptor[]> | undefined;

  function requestManifest(forceRefresh = false): Promise<readonly ToolchainDescriptor[]> {
    if (manifestPromise) return manifestPromise;
    if (!forceRefresh && manifestState.status === "ready") {
      return Promise.resolve(manifestState.entries);
    }
    manifestState = { status: "loading", entries: manifestState.entries };
    manifestPromise = manifestLoader(forceRefresh)
      .then((entries) => {
        manifestState = { status: "ready", entries };
        return entries;
      })
      .catch((error: Error) => {
        manifestState = {
          status: "failed",
          entries: manifestState.entries,
          error: error.message,
        };
        throw error;
      })
      .finally(() => {
        manifestPromise = undefined;
      });
    return manifestPromise;
  }

  function startManifestLoad(): void {
    if (manifestState.status !== "not_started") return;
    void requestManifest().catch(() => {
      // The state response carries the bounded catalog failure to the UI.
    });
  }
  app.post("/api/toolchains/rescan", (_req, res) => {
    if (toolchainMutationsBlocked()) {
      return res.status(409).json({
        success: false,
        message: TOOLCHAIN_MUTATION_BLOCKED_MESSAGE,
      });
    }
    try {
      lifecycle.assertAdmissible();
      clearToolchainDetectionCache();
      const rescanOp = requestToolchainRescan();
      lifecycle.trackBackgroundOperation(rescanOp);
      if (onBackgroundOperation) {
        onBackgroundOperation(rescanOp);
      }
    } catch (err) {
      return res.status(503).json({
        success: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return res.status(202).json({
      success: true,
      discovery: getToolchainDiscoverySnapshot(),
    });
  });

  app.get("/api/toolchains", (_req, res) => {
    const platform = os.platform();
    const arch = normalizeHostArchitecture(os.arch());
    const prefs = loadPreferences();
    startManifestLoad();
    const manifest = manifestState.entries;
    const inspectInstalledPackage = createInstalledToolchainPackageInspector();
    const toolchainsList = manifest.map((descriptor) => {
      const progress = getInstallProgress(descriptor.id);
      const installedState = inspectInstalledPackage(descriptor);
      const installed = installedState.status === "installed"
        ? installedState.package
        : undefined;
      return {
        ...descriptor,
        installed: !!installed,
        ...(installed
          ? {
              origin: installed.origin,
              integrity: installed.integrity,
              uninstallable: installed.uninstallable,
            }
          : {
              uninstallable: false,
              ...(installedState.status === "corrupt"
                ? { packageDiagnostic: installedState.diagnostic }
                : {}),
            }),
        progress: progress || {
          id: descriptor.id,
          status: "idle" as const,
          percent: 0,
          bytesReceived: 0,
          totalBytes: descriptor.sizeBytes || 0,
        },
      };
    });
    const profileState = buildLanguageProfileState(manifest, {
      inspectInstalledPackage,
    });
    const cppProfile = profileState.profiles.find((profile) => profile.kind === "cpp")!;
    const pythonProfile = profileState.profiles.find(
      (profile) => profile.kind === "python",
    )!;
    const managedCpp = resolveCachedManagedToolchain("cpp", inspectInstalledPackage);
    const managedPython = resolveCachedManagedToolchain("python", inspectInstalledPackage);

    res.json({
      distribution: getJudgeDeskDistribution(),
      platform,
      arch,
      preferences: prefs,
      preferenceDocument: {
        status: profileState.preferenceStatus,
        revision: profileState.preferenceRevision,
        recoveryDiagnostics: profileState.recoveryDiagnostics,
      },
      registryRevision: profileState.registryRevision,
      discovery: profileState.discovery,
      executionPolicy: loadLocalExecutionPolicy(),
      profiles: profileState.profiles,
      active: {
        cpp: cppProfile.active,
        python: pythonProfile.active,
      },
      capabilities: {
        cpp: {
          detected: cppProfile.detected,
          managed: managedCpp.ready,
          submissionReady: cppProfile.roles.submissionReady,
          checkerReady: cppProfile.roles.checkerReady,
          installable: cppProfile.sources.managed.available,
        },
        python: {
          detected: pythonProfile.detected,
          managed: managedPython.ready,
          submissionReady: pythonProfile.roles.submissionReady,
          checkerReady: pythonProfile.roles.checkerReady,
          installable: pythonProfile.sources.managed.available,
        },
      },
      toolchains: toolchainsList,
      mutationsBlocked: toolchainMutationsBlocked(),
      manifestStatus: manifestState.status,
      manifestError: manifestState.error,
    });
  });

  app.put("/api/toolchains/execution-policy", (req, res) => {
    try {
      lifecycle.assertAdmissible();
    } catch (err) {
      return res.status(503).json({
        success: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    if (toolchainMutationsBlocked()) {
      return res.status(409).json({
        success: false,
        message: TOOLCHAIN_MUTATION_BLOCKED_MESSAGE,
      });
    }
    if (
      !isRecord(req.body)
      || Object.keys(req.body).length !== 1
      || req.body.allowResourceOnlyLocalExecution !== false
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid local execution policy. Resource-only local execution is disabled.",
      });
    }
    try {
      const executionPolicy = saveLocalExecutionPolicy(
        req.body.allowResourceOnlyLocalExecution,
      );
      return res.json({ success: true, executionPolicy });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/toolchains/prewarm", (req, res) => {
    try {
      lifecycle.assertAdmissible();
      const force = isRecord(req.body) && req.body.force === true;
      const prewarmOp = startBackgroundJudgePrewarm(force);
      lifecycle.trackBackgroundOperation(prewarmOp);
      if (onBackgroundOperation) {
        onBackgroundOperation(prewarmOp);
      }
      return res.json({ success: true, message: "Background pre-warm initiated." });
    } catch (err) {
      return res.status(503).json({
        success: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post("/api/toolchains/profiles/:profileId/certification-plan", async (req, res) => {
    try {
      lifecycle.assertAdmissible();
    } catch (err) {
      return res.status(503).json({
        success: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    const { profileId } = req.params;
    const entry = getRegisteredLanguageProfile(profileId);
    if (!entry) {
      return res.status(404).json({ success: false, message: "Unknown language profile." });
    }
    if (entry.toolchainKind !== "cpp" || os.platform() !== "win32") {
      return res.status(422).json({
        success: false,
        message: "Local certification is currently available for Windows GNU C++ only.",
      });
    }
    if (toolchainMutationsBlocked()) {
      return res.status(409).json({
        success: false,
        message: TOOLCHAIN_MUTATION_BLOCKED_MESSAGE,
      });
    }
    try {
      const executablePath = selectedLocalExecutablePath(profileId);
      const plan = await planLocalCppCertification(executablePath);
      return res.json({ success: true, plan });
    } catch (error) {
      return res.status(422).json({
        success: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/toolchains/profiles/:profileId/certify", async (req, res) => {
    try {
      lifecycle.assertAdmissible();
    } catch (err) {
      return res.status(503).json({
        success: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    const { profileId } = req.params;
    const entry = getRegisteredLanguageProfile(profileId);
    if (!entry) {
      return res.status(404).json({ success: false, message: "Unknown language profile." });
    }
    if (entry.toolchainKind !== "cpp" || os.platform() !== "win32") {
      return res.status(422).json({
        success: false,
        message: "Local certification is currently available for Windows GNU C++ only.",
      });
    }
    if (toolchainMutationsBlocked()) {
      return res.status(409).json({
        success: false,
        message: TOOLCHAIN_MUTATION_BLOCKED_MESSAGE,
      });
    }
    try {
      const executablePath = selectedLocalExecutablePath(profileId);
      const certifyOp = certifyLocalCppToolchain(executablePath);
      lifecycle.trackBackgroundOperation(certifyOp);
      if (onBackgroundOperation) {
        onBackgroundOperation(certifyOp);
      }
      const result = await certifyOp;
      clearToolchainDetectionCache();
      invalidateJudgePrewarm();
      return res.json({ success: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.startsWith("TOOLCHAIN_MUTATION_BLOCKED") ? 409 : 422;
      return res.status(status).json({ success: false, message });
    }
  });

  app.post("/api/toolchains/profiles/:profileId/diagnose", async (req, res) => {
    try {
      lifecycle.assertAdmissible();
    } catch (err) {
      return res.status(503).json({
        success: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    const { profileId } = req.params;
    const entry = getRegisteredLanguageProfile(profileId);
    if (!entry) {
      return res.status(404).json({ success: false, message: "Unknown language profile." });
    }
    if (serverLifecycle.activeJudgeSessionCount > 0) {
      return res.status(409).json({
        success: false,
        message: "Diagnostics cannot run while judging is in progress.",
      });
    }
    try {
      const diagOp = diagnoseLanguageProfile(profileId);
      lifecycle.trackBackgroundOperation(diagOp);
      if (onBackgroundOperation) {
        onBackgroundOperation(diagOp);
      }
      const result = await diagOp;
      return res.json({ success: result.success, diagnostic: result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ success: false, message });
    }
  });

  app.post("/api/toolchains/:id/install", async (req, res) => {
    try {
      lifecycle.assertAdmissible();
    } catch (err) {
      return res.status(503).json({
        success: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    const { id } = req.params;
    const catalogEntry = TOOLCHAIN_CATALOG.find((entry) => entry.id === id);
    if (!catalogEntry) {
      return res.status(404).json({
        success: false,
        message: `Toolchain descriptor with ID '${id}' not found.`,
      });
    }
    if (!isCurrentReleaseToolchainKind(catalogEntry.kind)) {
      return res.status(404).json({
        success: false,
        message: `Toolchain descriptor with ID '${id}' is not enabled in this release.`,
      });
    }
    if (
      (os.platform() === "win32" || os.platform() === "darwin")
      && (
        catalogEntry.platform !== os.platform()
        || catalogEntry.arch !== normalizeHostArchitecture(os.arch())
      )
    ) {
      return res.status(400).json({
        success: false,
        message: "This toolchain package is not compatible with the current host.",
      });
    }
    if (toolchainMutationsBlocked()) {
      return res.status(409).json({
        success: false,
        message: TOOLCHAIN_MUTATION_BLOCKED_MESSAGE,
      });
    }
    // Capture intent before the remote manifest request. A radio change while
    // downloading or even while fetching the catalog must make final apply fail.
    const preferenceSnapshot = loadToolchainPreferenceSnapshot();
    if (preferenceSnapshot.status === "recovery") {
      return res.status(409).json({
        success: false,
        message: "Toolchain preferences require recovery before installation can be applied.",
      });
    }
    const profileId = getRegisteredProfileForKind(catalogEntry.kind).profile.ref.id;
    const expectedRevision = preferenceSnapshot.revision;

    let manifest: readonly ToolchainDescriptor[];
    try {
      manifest = await requestManifest();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(503).json({
        success: false,
        message: message || "Toolchain manifest is unavailable.",
      });
    }
    const descriptor = manifest.find((candidate) => candidate.id === id);
    if (!descriptor) {
      return res.status(404).json({
        success: false,
        message: `Toolchain descriptor with ID '${id}' not found.`,
      });
    }
    // The catalog request is asynchronous, so a judge session may have begun
    // after the first admission check.
    if (toolchainMutationsBlocked()) {
      return res.status(409).json({
        success: false,
        message: TOOLCHAIN_MUTATION_BLOCKED_MESSAGE,
      });
    }
    const progress = getInstallProgress(id);
    if (
      progress
      && ["downloading", "extracting", "verifying"].includes(progress.status)
    ) {
      return res.status(400).json({
        success: false,
        message: "Installation is already in progress.",
      });
    }
    console.log(`[Toolchains API] Starting async installation of ${id}`);
    const executeInstall = async () => {
      await installer(descriptor, {
        // Runs immediately before the synchronous atomic replacement. A batch
        // that starts during download therefore keeps the package it began with.
        beforeCommit: assertToolchainMutationAllowed,
      });
      if (toolchainMutationsBlocked()) {
        clearToolchainDetectionCache();
        invalidateJudgePrewarm();
        console.warn(
          `[Toolchains API] ${id} installed but was not applied because judging started.`,
        );
        return;
      }
      const applied = tryUpdateProfileToolchainPreferenceAtRevision(
        profileId,
        { mode: "managed" },
        expectedRevision,
      );
      clearToolchainDetectionCache();
      invalidateJudgePrewarm();
      if (!applied) {
        console.warn(
          `[Toolchains API] ${id} installed but was not applied because the preference changed.`,
        );
      }
    };

    let installOp: Promise<void>;
    try {
      lifecycle.assertAdmissible();
      installOp = executeInstall();
      lifecycle.trackBackgroundOperation(installOp);
      if (onBackgroundOperation) {
        onBackgroundOperation(installOp);
      }
    } catch (err) {
      return res.status(503).json({
        success: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    installOp.catch((error: unknown) => {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(
        `[Toolchains API] Async installation of ${id} failed:`,
        msg,
      );
    });

    return res.status(202).json({
      success: true,
      message: "Installation started.",
      expectedPreferenceRevision: expectedRevision,
    });
  });

  app.post("/api/toolchains/:id/cancel", (req, res) => {
    cancelInstallation(req.params.id);
    res.json({ success: true, message: "Cancel request received." });
  });

  app.delete("/api/toolchains/:id", async (req, res) => {
    try {
      lifecycle.assertAdmissible();
    } catch (err) {
      return res.status(503).json({
        success: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    const { id } = req.params;
    if (!TOOLCHAIN_CATALOG.some((entry) => entry.id === id)) {
      return res.status(404).json({
        success: false,
        message: `Toolchain descriptor with ID '${id}' not found.`,
      });
    }
    if (toolchainMutationsBlocked()) {
      return res.status(409).json({
        success: false,
        message: TOOLCHAIN_MUTATION_BLOCKED_MESSAGE,
      });
    }
    try {
      const uninstallOp = uninstallToolchain(id);
      lifecycle.trackBackgroundOperation(uninstallOp);
      if (onBackgroundOperation) {
        onBackgroundOperation(uninstallOp);
      }
      await uninstallOp;
      clearToolchainDetectionCache();
      invalidateJudgePrewarm();
      return res.json({
        success: true,
        message: `Toolchain '${id}' uninstalled successfully.`,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.includes("included with JudgeDesk") ? 409 : 500;
      return res.status(status).json({ success: false, message });
    }
  });

  app.put("/api/toolchains/profiles/:profileId/preference", (req, res) => {
    try {
      lifecycle.assertAdmissible();
    } catch (err) {
      return res.status(503).json({
        success: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    const { profileId } = req.params;
    const entry = getRegisteredLanguageProfile(profileId);
    if (!entry) {
      return res.status(404).json({ success: false, message: "Unknown language profile." });
    }
    if (toolchainMutationsBlocked()) {
      return res.status(409).json({
        success: false,
        message: TOOLCHAIN_MUTATION_BLOCKED_MESSAGE,
      });
    }
    if (
      !isRecord(req.body)
      || Object.keys(req.body).some((key) => key !== "mode" && key !== "localPath")
      || typeof req.body.mode !== "string"
      || !SOURCE_MODES.has(req.body.mode as ToolchainSourceMode)
    ) {
      return res.status(400).json({ success: false, message: "Invalid profile preference." });
    }
    const mode = req.body.mode as ToolchainSourceMode;
    const hasLocalPath = Object.hasOwn(req.body, "localPath");
    if (
      hasLocalPath
      && (!isAcceptedLocalPath(req.body.localPath) || mode !== "local_path")
    ) {
      return res.status(400).json({ success: false, message: "Invalid local toolchain path." });
    }
    if (
      mode === "managed"
      && entry.toolchainKind !== "scratch"
      && !getDescriptorForHost(os.platform(), os.arch(), entry.toolchainKind)
    ) {
      return res.status(400).json({
        success: false,
        message: "Managed source is unavailable for this profile and host.",
      });
    }
    if (mode !== "none" && mode !== "managed" && !profileSupportsCurrentHost(profileId)) {
      return res.status(400).json({
        success: false,
        message: "Local source is unavailable for this profile and host.",
      });
    }
    if (hasLocalPath) {
      clearToolchainDetectionCache({ preserveLocalProbeCache: true });
      const verification = verifyLocalToolchainCandidate(
        entry.toolchainKind,
        String(req.body.localPath),
      );
      if (!isLocalPreferenceVerificationAccepted(verification)) {
        return res.status(422).json({
          success: false,
          message: verification.diagnostic || "Local toolchain verification failed.",
          diagnosticCode: verification.diagnosticCode || "HEALTH_CHECK_FAILED",
        });
      }
    }
    try {
      lifecycle.assertAdmissible();
      const before = loadToolchainPreferenceSnapshot();
      if (before.status === "recovery") {
        return res.status(409).json({
          success: false,
          message: "Toolchain preferences require recovery.",
        });
      }
      const current = getStoredProfilePreference(before.preferences, profileId);
      const localPath = hasLocalPath
        ? String(req.body.localPath)
        : current.localPath;
      const preference = localPath ? { mode, localPath } : { mode };
      const updated = updateProfileToolchainPreference(profileId, preference);
      if (!hasLocalPath) clearToolchainDetectionCache({ preserveLocalProbeCache: true });
      invalidateJudgePrewarm();
      const rescanOp = requestToolchainRescan();
      lifecycle.trackBackgroundOperation(rescanOp);
      if (onBackgroundOperation) {
        onBackgroundOperation(rescanOp);
      }
      return res.json({
        success: true,
        preference: getStoredProfilePreference(updated.preferences, profileId),
        revision: updated.revision,
      });
    } catch (error: unknown) {
      if (lifecycle.isClosing) {
        return res.status(503).json({
          success: false,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      return res.status(409).json({ success: false, message });
    }
  });

  // Compatibility endpoint for older frontends during the schema-v2 rollout.
  app.post("/api/toolchains/custom-path", (req, res) => {
    try {
      lifecycle.assertAdmissible();
    } catch (err) {
      return res.status(503).json({
        success: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    if (toolchainMutationsBlocked()) {
      return res.status(409).json({
        success: false,
        message: TOOLCHAIN_MUTATION_BLOCKED_MESSAGE,
      });
    }
    if (!isRecord(req.body)) {
      return res.status(400).json({ success: false, message: "Invalid preference patch." });
    }
    const { kind, path: customPath, preferredSource } = req.body;
    if (kind !== "cpp" && kind !== "python") {
      return res.status(400).json({
        success: false,
        message: "Invalid toolchain kind. Must be 'cpp' or 'python'.",
      });
    }
    if (
      customPath !== undefined
      && customPath !== ""
      && !isAcceptedLocalPath(customPath)
    ) {
      return res.status(400).json({
        success: false,
        message: "Custom toolchain path must be a valid string.",
      });
    }
    if (
      preferredSource !== undefined
      && (typeof preferredSource !== "string"
        || !["managed", "custom", "system"].includes(preferredSource))
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid preferred toolchain source.",
      });
    }
    const profileId = getRegisteredProfileForKind(kind as ToolchainKind).profile.ref.id;
    try {
      const snapshot = loadToolchainPreferenceSnapshot();
      if (snapshot.status === "recovery") {
        return res.status(409).json({ success: false, message: "Toolchain preferences require recovery." });
      }
      const current = getStoredProfilePreference(snapshot.preferences, profileId);
      const mode = preferredSource === "managed"
        ? "managed"
        : preferredSource === "custom"
          ? "local_path"
          : preferredSource === "system"
            ? "local_auto"
            : current.mode;
      const localPath = customPath === ""
        ? undefined
        : typeof customPath === "string"
          ? customPath
          : current.localPath;
      updateProfileToolchainPreference(
        profileId,
        localPath ? { mode, localPath } : { mode },
      );
      clearToolchainDetectionCache({ preserveLocalProbeCache: true });
      invalidateJudgePrewarm();
      return res.json({
        success: true,
        message: "Preferences updated.",
        preferences: loadPreferences(),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(409).json({ success: false, message });
    }
  });
}
