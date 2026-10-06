import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCompilerPipelineWithLimits } from "./compiler.js";

test("compiler tracing separates frontend and linker with native run identities", async (t) => {
  t.mock.property(process, "platform", "win32");
  const previous = process.env.JUDGEDESK_JUDGE_TRACE;
  process.env.JUDGEDESK_JUDGE_TRACE = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.JUDGEDESK_JUDGE_TRACE;
    else process.env.JUDGEDESK_JUDGE_TRACE = previous;
  });
  const output: string[] = [];
  t.mock.method(console, "info", (line: string) => output.push(line));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-phase-trace-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "program.out");
  const budgets: number[] = [];
  await runCompilerPipelineWithLimits(
    "owned-compiler", ["private-source.cpp", "-o", target], root, target, "job_trace",
    { timeoutMs: 200, maxGeneratedFileBytes: 1024 }, "cpp", {}, undefined,
    async (_compiler, _args, _cwd, _output, _job, limits) => {
      budgets.push(limits?.timeoutMs ?? 0);
      return {
        runId: `owned_phase_${budgets.length}`, reason: "exited", exitCode: 0,
        securitySetupTimeUs: 10_000, wallTimeUs: 50_000,
        resultCollectionTimeUs: 1_000, stdoutBytes: 0, stderrBytes: 0,
      };
    },
  );
  const phases = output.map((line) => JSON.parse(line.slice("[Judge Diagnostic] ".length)));
  assert.deepEqual(phases.map((record) => record.phase), ["compiler-frontend", "compiler-link"]);
  assert.deepEqual(phases.map((record) => record.runId), ["owned_phase_1", "owned_phase_2"]);
  for (const record of phases) {
    assert.equal(record.backendPid, process.pid);
    assert.equal(record.jobId, "job_trace");
    assert.equal(record.nativeWallMs, 50);
    assert.ok(record.durationMs >= 0);
  }
  assert.deepEqual(budgets, [200, 150], "tracing must preserve the shared native compiler budget");
  assert.equal(output.some((line) => line.includes("private-source.cpp")), false);
});
