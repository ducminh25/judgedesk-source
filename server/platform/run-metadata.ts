import os from "node:os";
import { BUILD_METADATA } from "../build-metadata.js";
import { executorClient } from "../executor/client.js";
import type { RunMetadata } from "../types.js";
import {
  isWindowsCppExecutionReady,
} from "../judge/compiler.js";
import type { ResolvedToolchain } from "../toolchains/types.js";
import {
  isPythonCheckerReady,
  isPythonSubmissionReady,
  resolveNativeProtectedToolchain,
  resolveToolchain,
} from "../toolchains/resolver.js";

export interface RunMetadataToolchainPins {
  cpp: ResolvedToolchain;
  python: ResolvedToolchain;
}

export function createRunMetadata(pins?: RunMetadataToolchainPins): RunMetadata {
  const platform = os.platform();
  const cpp = pins?.cpp ?? resolveNativeProtectedToolchain("cpp");
  const detectedPython = pins?.python ?? resolveToolchain("python");
  const executor = executorClient.health;
  return {
    startedAt: new Date().toISOString(),
    platform,
    arch: os.arch(),
    build: BUILD_METADATA,
    executor: {
      mode: executor.mode,
      version: executor.executorVersion,
      ready: executor.ready,
    },
    toolchains: {
      cpp: {
        source: cpp.source,
        version: cpp.version,
        submissionReady: platform === "win32"
          ? cpp.ready && isWindowsCppExecutionReady(cpp)
          : cpp.ready,
        checkerReady: platform === "win32"
          ? cpp.ready && isWindowsCppExecutionReady(cpp)
          : cpp.ready,
        ...(cpp.provenance ? { provenance: cpp.provenance } : {}),
        ...(cpp.certificateId ? { certificateId: cpp.certificateId } : {}),
        ...(cpp.candidateFingerprint
          ? { candidateFingerprint: cpp.candidateFingerprint }
          : {}),
        ...(cpp.snapshotDigest ? { snapshotDigest: cpp.snapshotDigest } : {}),
      },
      python: {
        source: detectedPython.source,
        version: detectedPython.version,
        submissionReady: isPythonSubmissionReady(detectedPython),
        checkerReady: isPythonCheckerReady(detectedPython),
      },
    },
  };
}
