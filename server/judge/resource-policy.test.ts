import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_COMPILER_MEMORY_LIMIT_BYTES,
  resolveConfiguredSubmissionMemoryLimitBytes,
  resolveCompilerMemoryLimitBytes,
  resolveSubmissionMemoryLimitBytes,
  SingleJudgeSessionGate,
  WINDOWS_ACTIVE_RUN_MEMORY_CAP_BYTES,
  WINDOWS_TOTAL_JUDGING_MEMORY_BUDGET_BYTES,
} from "./resource-policy.js";

const MiB = 1024 * 1024;

test("Windows resource policy reserves half of the total budget for app overhead", () => {
  assert.equal(WINDOWS_TOTAL_JUDGING_MEMORY_BUDGET_BYTES, 1024 * MiB);
  assert.equal(WINDOWS_ACTIVE_RUN_MEMORY_CAP_BYTES, 512 * MiB);
  assert.equal(resolveCompilerMemoryLimitBytes("win32"), 512 * MiB);
  assert.equal(resolveSubmissionMemoryLimitBytes(2048, "win32"), 512 * MiB);
  assert.equal(resolveSubmissionMemoryLimitBytes(256, "win32"), 256 * MiB);
  assert.equal(resolveSubmissionMemoryLimitBytes(0, "win32"), 256 * MiB);
  assert.equal(resolveConfiguredSubmissionMemoryLimitBytes(Number.NaN), 256 * MiB);
});

test("non-Windows resource policy preserves configured memory semantics", () => {
  assert.equal(resolveCompilerMemoryLimitBytes("darwin"), DEFAULT_COMPILER_MEMORY_LIMIT_BYTES);
  assert.equal(resolveSubmissionMemoryLimitBytes(2048, "darwin"), 2048 * MiB);
});

test("judge session gate permits only one active batch", () => {
  const gate = new SingleJudgeSessionGate();
  assert.equal(gate.tryAcquire(), true);
  assert.equal(gate.tryAcquire(), false);
  gate.release();
  assert.equal(gate.tryAcquire(), true);
});
