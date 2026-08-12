import os from "os";
import { TEMP_ROOT } from "../runtime.js";
import { sandbox } from "../sandbox.js";
import type { HostStatus } from "../types.js";
import { getRegisteredProfileForKind } from "../languages/registry.js";
import {
  resolveCachedManagedToolchain,
  resolveCachedToolchainSelection,
} from "../toolchains/cached-resolution.js";
import { getStoredProfilePreference } from "../toolchains/preferences-v2.js";
import { loadToolchainPreferenceSnapshot } from "../toolchains/storage.js";
import type { ToolchainKind } from "../toolchains/types.js";
import { executorClient } from "../executor/client.js";
import { BUILD_METADATA } from "../build-metadata.js";

export function getHostStatus(): HostStatus {
  const preferences = loadToolchainPreferenceSnapshot();
  const resolveSelected = (kind: ToolchainKind) => {
    if (preferences.status === "recovery") {
      return {
        active: {
          kind,
          source: "none" as const,
          executablePath: "",
          version: "",
          ready: false,
          diagnostic: "Toolchain preferences require recovery.",
          diagnosticCode: "DISABLED_BY_USER" as const,
        },
        detected: false,
      };
    }
    const profileId = getRegisteredProfileForKind(kind).profile.ref.id;
    return resolveCachedToolchainSelection(
      kind,
      getStoredProfilePreference(preferences.preferences, profileId),
    );
  };
  const selectedCpp = resolveSelected("cpp");
  const selectedPython = resolveSelected("python");
  const managedCpp = selectedCpp.active.source === "managed"
    ? selectedCpp.active
    : resolveCachedManagedToolchain("cpp");
  const managedPython = selectedPython.active.source === "managed"
    ? selectedPython.active
    : resolveCachedManagedToolchain("python");
  const secureRunner = executorClient.health;

  return {
    gpp: {
      installed: selectedCpp.detected,
      version: selectedCpp.detected ? selectedCpp.active.version : "Not found",
      source: selectedCpp.active.source,
      managedInstalled: managedCpp.ready,
      submissionReady: selectedCpp.active.ready,
      checkerReady: selectedCpp.active.ready,
      diagnostic: selectedCpp.active.diagnostic,
    },
    python: {
      installed: selectedPython.detected,
      version: selectedPython.detected ? selectedPython.active.version : "Not found",
      source: selectedPython.active.source,
      managedInstalled: managedPython.ready,
      submissionReady: selectedPython.active.ready,
      checkerReady: selectedPython.active.ready,
      diagnostic: selectedPython.active.diagnostic,
    },
    isolate: { installed: sandbox.mode !== "none" },
    tempDir: TEMP_ROOT,
    platform: os.platform(),
    isServerMode: sandbox.mode !== "none",
    build: BUILD_METADATA,
    sandbox: {
      mode: sandbox.mode,
      ready: sandbox.mode !== "none",
      ...sandbox.detection
    },
    secureRunner: {
      mode: secureRunner.mode,
      ready: secureRunner.ready,
      executorVersion: secureRunner.executorVersion,
      selfTestAt: secureRunner.ready ? new Date().toISOString() : undefined,
      diagnostics: secureRunner.diagnostics,
      networkBlocked: secureRunner.networkBlocked,
      filesystemIsolated: secureRunner.filesystemIsolated,
      processTreeControlled: secureRunner.processTreeControlled,
      memoryLimitSupported: secureRunner.memoryLimitSupported,
      startupTimings: secureRunner.startupTimings,
      clientStartupTimeMs: secureRunner.clientStartupTimeMs,
    }
  };
}
