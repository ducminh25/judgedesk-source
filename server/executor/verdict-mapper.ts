import type { TestVerdict } from "../types.js";
import type { ExecutorRunResult } from "./protocol.js";

export function executorResultToVerdict(result: ExecutorRunResult): TestVerdict | null {
  switch (result.reason) {
    case "cancelled":
      return "FAIL";
    case "memory_limit":
      return "MLE";
    case "wall_time_limit":
      return "TLE";
    case "output_limit":
    case "write_limit":
      return "OLE";
    case "process_limit":
    case "thread_limit":
      return "RE";
    case "sandbox_denied":
    case "launch_error":
    case "internal_error":
      return "JE";
    case "exited":
      return result.exitCode === 0 ? null : "RE";
  }
}

export function executorDiagnostic(result: ExecutorRunResult, stderr: string): string {
  if (result.reason === "wall_time_limit") return "";
  return [
    result.diagnostic,
    result.signalOrStatus,
    result.exitCode !== null && result.exitCode !== 0 ? `Exit code ${result.exitCode}` : undefined,
    stderr.trim(),
  ].filter(Boolean).join(". ");
}

export function executorDisplayTimeMs(
  result: ExecutorRunResult,
  configuredLimitMs: number,
): number {
  return result.reason === "wall_time_limit"
    ? Math.max(1, configuredLimitMs)
    : result.wallTimeUs / 1000;
}
