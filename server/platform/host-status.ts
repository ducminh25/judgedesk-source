import os from "os";
import { TEMP_ROOT } from "../runtime.js";
import { sandbox } from "../sandbox.js";
import type { HostStatus } from "../types.js";
import {
  isPythonCheckerReady,
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
  const pythonCheckerReady = isPythonCheckerReady(detectedPython);
  const resolvedCpp = resolveNativeProtectedToolchain("cpp");
  const secureRunner = executorClient.health;
  const cppSubmissionReady = resolvedCpp.ready;

  return {
    gpp: {
      installed: detectedCpp.ready,
      version: detectedCpp.ready ? detectedCpp.version : "Not found",
      source: detectedCpp.source,
      managedInstalled: managedCpp.ready,
      submissionReady: cppSubmissionReady,
      checkerReady: cppSubmissionReady,
      diagnostic: resolvedCpp.diagnostic || detectedCpp.diagnostic,
    },
    python: {
      installed: detectedPython.ready,
      version: detectedPython.ready ? detectedPython.version : "Not found",
      source: detectedPython.source,
      managedInstalled: managedPython.ready,
      submissionReady: pythonSubmissionReady,
      checkerReady: pythonCheckerReady,
      diagnostic: detectedPython.ready && (!pythonSubmissionReady || !pythonCheckerReady)
        ? "Detected but not certified for judging; select or install managed Python for submissions and custom checkers."
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
