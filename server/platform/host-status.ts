import os from "os";
import { TEMP_ROOT } from "../runtime.js";
import { sandbox } from "../sandbox.js";
import type { HostStatus } from "../types.js";
import { resolveToolchain } from "../toolchains/resolver.js";

export function getHostStatus(): HostStatus {
  const resolvedCpp = resolveToolchain("cpp");
  const resolvedPython = resolveToolchain("python");

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
    }
  };
}
