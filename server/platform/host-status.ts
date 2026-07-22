import os from "os";
import { TEMP_ROOT } from "../runtime.js";
import { sandbox } from "../sandbox.js";
import type { HostStatus } from "../types.js";
import { resolveNativeProtectedToolchain } from "../toolchains/resolver.js";
import { executorClient } from "../executor/client.js";

export function getHostStatus(): HostStatus {
  const resolvedCpp = resolveNativeProtectedToolchain("cpp");
  const resolvedPython = resolveNativeProtectedToolchain("python");
  const secureRunner = executorClient.health;

  return {
    gpp: {
      installed: resolvedCpp.ready,
      version: resolvedCpp.ready ? resolvedCpp.version : "Not found"
    },
    python: {
      installed: resolvedPython.ready,
      version: resolvedPython.ready ? resolvedPython.version : "Not found"
    },
    isolate: { installed: sandbox.mode !== "none" },
    tempDir: TEMP_ROOT,
    platform: os.platform(),
    isServerMode: sandbox.mode !== "none",
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
