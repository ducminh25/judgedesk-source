import os from "os";
import { TEMP_ROOT } from "../runtime.js";
import { sandbox } from "../sandbox.js";
import type { HostStatus } from "../types.js";
import {
  isPythonSubmissionReady,
  resolveManagedToolchain,
  resolveNativeProtectedToolchain,
  resolveToolchain,
} from "../toolchains/resolver.js";
import { executorClient } from "../executor/client.js";
import { BUILD_METADATA } from "../build-metadata.js";

export function getHostStatus(): HostStatus {
  const detectedCpp = resolveToolchain("cpp");
  const detectedPython = resolveToolchain("python");
  const managedCpp = resolveManagedToolchain("cpp");
  const managedPython = resolveManagedToolchain("python");
  const pythonSubmissionReady = isPythonSubmissionReady(detectedPython);
  const resolvedCpp = resolveNativeProtectedToolchain("cpp");
  const secureRunner = executorClient.health;
  const cppRequiresManaged = os.platform() === "win32";
  const cppSubmissionReady = cppRequiresManaged ? managedCpp.ready : resolvedCpp.ready;

  return {
    gpp: {
      installed: detectedCpp.ready,
      version: detectedCpp.ready ? detectedCpp.version : "Not found",
      source: detectedCpp.source,
      managedInstalled: managedCpp.ready,
      submissionReady: cppSubmissionReady,
      checkerReady: cppSubmissionReady,
      diagnostic: detectedCpp.ready && !cppSubmissionReady
        ? "Detected but not usable with Native protection; install managed GCC."
        : detectedCpp.diagnostic,
    },
    python: {
      installed: detectedPython.ready,
      version: detectedPython.ready ? detectedPython.version : "Not found",
      source: detectedPython.source,
      managedInstalled: managedPython.ready,
      submissionReady: pythonSubmissionReady,
      checkerReady: detectedPython.ready,
      diagnostic: detectedPython.ready && !pythonSubmissionReady
        ? "Detected for trusted checkers only; select or install managed Python for submissions."
        : detectedPython.diagnostic,
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
      memoryLimitSupported: secureRunner.memoryLimitSupported
    }
  };
}
