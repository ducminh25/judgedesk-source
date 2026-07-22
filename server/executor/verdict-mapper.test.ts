import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutorRunResult } from "./protocol.js";
import {
  executorDiagnostic,
  executorDisplayTimeMs,
  executorResultToVerdict,
} from "./verdict-mapper.js";

const tle: ExecutorRunResult = {
  runId: "tle",
  reason: "wall_time_limit",
  exitCode: 0x4a440002,
  signalOrStatus: "0x4A440002",
  securitySetupTimeUs: 6_000,
  wallTimeUs: 1_014_000,
  resultCollectionTimeUs: 100,
  peakMemoryBytes: 3 * 1024 * 1024,
  stdoutBytes: 0,
  stderrBytes: 0,
};

test("TLE hides the executor termination code and displays the configured limit", () => {
  assert.equal(executorResultToVerdict(tle), "TLE");
  assert.equal(executorDiagnostic(tle, ""), "");
  assert.equal(executorDisplayTimeMs(tle, 1_000), 1_000);
  assert.equal(tle.peakMemoryBytes, 3 * 1024 * 1024);
});

test("non-TLE results retain measured wall time and diagnostics", () => {
  const runtimeError = { ...tle, reason: "exited" as const, wallTimeUs: 76_250 };
  assert.equal(executorDisplayTimeMs(runtimeError, 1_000), 76.25);
  assert.match(executorDiagnostic(runtimeError, "boom"), /0x4A440002.*Exit code 1245970434.*boom/);
});
