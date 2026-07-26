import os from "node:os";
import { BUILD_METADATA } from "../build-metadata.js";
import { executorClient } from "../executor/client.js";
import type { RunMetadata } from "../types.js";
import {
  isPythonSubmissionReady,
  resolveNativeProtectedToolchain,
  resolveToolchain,
} from "../toolchains/resolver.js";

export function createRunMetadata(): RunMetadata {
  const platform = os.platform();
  const cpp = resolveNativeProtectedToolchain("cpp");
  const detectedPython = resolveToolchain("python");
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
        submissionReady: platform === "win32" ? cpp.source === "managed" && cpp.ready : cpp.ready,
      },
      python: {
        source: detectedPython.source,
        version: detectedPython.version,
        submissionReady: isPythonSubmissionReady(detectedPython),
        checkerReady: detectedPython.ready,
      },
    },
  };
}
