import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_COMPILER_MEMORY_LIMIT_BYTES,
  resolveConfiguredSubmissionMemoryLimitBytes,
  resolveCompilerMemoryLimitBytes,
  resolveSubmissionMemoryLimitBytes,
  resolveWindowsTotalJudgingMemoryBudgetBytes,
  SingleJudgeSessionGate,
  WINDOWS_ACTIVE_RUN_MEMORY_CAP_BYTES,
  WINDOWS_APP_HOST_MEMORY_BUDGET_BYTES,
  WINDOWS_APP_HOST_WORKING_SET_CEILING_BYTES,
  WINDOWS_MAX_TOTAL_JUDGING_MEMORY_BUDGET_BYTES,
  WINDOWS_MAX_TOTAL_WORKING_SET_BUDGET_BYTES,
  WINDOWS_REPRESENTATIVE_SUBMISSION_MEMORY_CAP_BYTES,
  WINDOWS_REPRESENTATIVE_TOTAL_MEMORY_BUDGET_BYTES,
  WINDOWS_TOTAL_JUDGING_MEMORY_BUDGET_BYTES,
} from "./resource-policy.js";

const MiB = 1024 * 1024;

test("resource policy caps submission and compiler memory at 1024 MiB and defaults to 256 MiB", () => {
  assert.equal(WINDOWS_TOTAL_JUDGING_MEMORY_BUDGET_BYTES, 1024 * MiB);
  assert.equal(WINDOWS_ACTIVE_RUN_MEMORY_CAP_BYTES, 1024 * MiB);
  assert.equal(resolveCompilerMemoryLimitBytes("win32"), 1024 * MiB);
  assert.equal(resolveCompilerMemoryLimitBytes("darwin"), 1024 * MiB);
  assert.equal(resolveSubmissionMemoryLimitBytes(2048, "win32"), 1024 * MiB);
  assert.equal(resolveSubmissionMemoryLimitBytes(1024, "win32"), 1024 * MiB);
  assert.equal(resolveSubmissionMemoryLimitBytes(512, "win32"), 512 * MiB);
  assert.equal(resolveSubmissionMemoryLimitBytes(256, "win32"), 256 * MiB);
  assert.equal(resolveSubmissionMemoryLimitBytes(0, "win32"), 256 * MiB);
  assert.equal(resolveSubmissionMemoryLimitBytes(4, "win32"), 8 * MiB);
  assert.equal(resolveSubmissionMemoryLimitBytes(2048, "darwin"), 1024 * MiB);
  assert.equal(resolveSubmissionMemoryLimitBytes(1024, "darwin"), 1024 * MiB);
  assert.equal(resolveConfiguredSubmissionMemoryLimitBytes(Number.NaN), 256 * MiB);
});

test("C03 Windows resource envelope separates representative S256/S512 (<1024 MiB) and SMAX (<=1408 MiB private / <=1792 MiB working set) budgets", () => {
  assert.equal(WINDOWS_REPRESENTATIVE_SUBMISSION_MEMORY_CAP_BYTES, 512 * MiB);
  assert.equal(WINDOWS_APP_HOST_MEMORY_BUDGET_BYTES, 384 * MiB);
  assert.equal(WINDOWS_APP_HOST_WORKING_SET_CEILING_BYTES, 768 * MiB);
  assert.equal(WINDOWS_REPRESENTATIVE_TOTAL_MEMORY_BUDGET_BYTES, 1024 * MiB);
  assert.equal(WINDOWS_MAX_TOTAL_JUDGING_MEMORY_BUDGET_BYTES, 1408 * MiB);
  assert.equal(WINDOWS_MAX_TOTAL_WORKING_SET_BUDGET_BYTES, 1792 * MiB);
  assert.deepEqual(resolveWindowsTotalJudgingMemoryBudgetBytes(256), {
    profile: "S256_S512",
    configuredSubmissionMemoryLimitBytes: 256 * MiB,
    appHostBudgetBytes: 384 * MiB,
    appHostWorkingSetCeilingBytes: 768 * MiB,
    totalBudgetBytes: 1024 * MiB,
    totalWorkingSetBudgetBytes: 1024 * MiB,
  });
  assert.deepEqual(resolveWindowsTotalJudgingMemoryBudgetBytes(512), {
    profile: "S256_S512",
    configuredSubmissionMemoryLimitBytes: 512 * MiB,
    appHostBudgetBytes: 384 * MiB,
    appHostWorkingSetCeilingBytes: 768 * MiB,
    totalBudgetBytes: 1024 * MiB,
    totalWorkingSetBudgetBytes: 1024 * MiB,
  });
  assert.deepEqual(resolveWindowsTotalJudgingMemoryBudgetBytes(1024), {
    profile: "SMAX",
    configuredSubmissionMemoryLimitBytes: 1024 * MiB,
    appHostBudgetBytes: 384 * MiB,
    appHostWorkingSetCeilingBytes: 768 * MiB,
    totalBudgetBytes: 1408 * MiB,
    totalWorkingSetBudgetBytes: 1792 * MiB,
  });
});

test("judge session gate permits only one active batch", () => {
  const gate = new SingleJudgeSessionGate();
  assert.equal(gate.tryAcquire(), true);
  assert.equal(gate.tryAcquire(), false);
  gate.release();
  assert.equal(gate.tryAcquire(), true);
});

