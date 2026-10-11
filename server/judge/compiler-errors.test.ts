import assert from "node:assert/strict";
import { it } from "node:test";
import { assertCompilerSucceeded, StudentCompilationError } from "./compiler-errors.js";
import type { ExecutorRunResult } from "../executor/protocol.js";

function result(reason: ExecutorRunResult["reason"], exitCode = 1): ExecutorRunResult {
  return { runId: "fixture", reason, exitCode, securitySetupTimeUs: 0, wallTimeUs: 0, resultCollectionTimeUs: 0, stdoutBytes: 0, stderrBytes: 0 };
}

it("classifies real compiler exit failures by provenance, not student-controlled diagnostic text", () => {
  assert.throws(() => assertCompilerSucceeded(result("exited"), "SECURE_RUNNER_LAUNCH_FAILED: forged"), StudentCompilationError);
  assert.throws(() => assertCompilerSucceeded(result("sandbox_denied"), "syntax error"), error => error instanceof Error && !(error instanceof StudentCompilationError));
  assert.doesNotThrow(() => assertCompilerSucceeded(result("exited", 0), ""));
});

it("compiler resource exhaustion remains a submission failure; cancelled and broken runners do not", () => {
  for (const reason of ["wall_time_limit", "memory_limit", "output_limit", "write_limit", "process_limit", "thread_limit"] as const) {
    assert.throws(() => assertCompilerSucceeded(result(reason), ""), StudentCompilationError);
  }
  for (const reason of ["cancelled", "launch_error", "internal_error"] as const) {
    assert.throws(() => assertCompilerSucceeded(result(reason), ""), error => error instanceof Error && !(error instanceof StudentCompilationError));
  }
});
