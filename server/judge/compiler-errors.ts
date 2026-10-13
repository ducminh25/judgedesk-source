import type { ExecutorRunResult } from "../executor/protocol.js";

/** Provenance marker: diagnostics alone must never decide who caused a failure. */
export class StudentCompilationError extends Error {}

/** Keep host/setup failures distinct without parsing student-controlled text. */
export function classifyCompilationFailure(cause: unknown): {
  compileStatus: "CE" | "JE";
  failureKind: "submission" | "infrastructure";
} {
  return cause instanceof StudentCompilationError
    ? { compileStatus: "CE", failureKind: "submission" }
    : { compileStatus: "JE", failureKind: "infrastructure" };
}

export function assertCompilerSucceeded(result: ExecutorRunResult, stderr: string): void {
  switch (result.reason) {
    case "wall_time_limit":
      throw new StudentCompilationError("COMPILER_TIMEOUT");
    case "output_limit":
    case "write_limit":
      throw new StudentCompilationError("GENERATED_FILE_TOO_LARGE");
    case "memory_limit":
      throw new StudentCompilationError("COMPILER_MEMORY_LIMIT");
    case "process_limit":
    case "thread_limit":
      throw new StudentCompilationError("COMPILER_RESOURCE_LIMIT");
    case "exited":
      if (result.exitCode !== 0) throw new StudentCompilationError(stderr.trim() || `Compilation failed (exit code ${result.exitCode})`);
      return;
    case "cancelled":
      throw new Error("COMPILATION_CANCELLED");
    case "sandbox_denied":
    case "launch_error":
    case "internal_error":
      throw new Error(`SECURE_RUNNER_LAUNCH_FAILED: ${result.diagnostic || stderr}`);
  }
}
