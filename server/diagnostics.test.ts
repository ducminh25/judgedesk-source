import assert from "node:assert/strict";
import test from "node:test";
import { measureDiagnosticPhase } from "./diagnostics.js";

test("judge diagnostic phases correlate backend, job and run without logging inputs", async (t) => {
  const previous = process.env.JUDGEDESK_JUDGE_TRACE;
  process.env.JUDGEDESK_JUDGE_TRACE = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.JUDGEDESK_JUDGE_TRACE;
    else process.env.JUDGEDESK_JUDGE_TRACE = previous;
  });
  const output: string[] = [];
  t.mock.method(console, "info", (line: string) => output.push(line));
  const context = { phase: "compiler-stage", jobId: "job_1", runId: "compile_1" };
  assert.equal(await measureDiagnosticPhase(context, async () => 42), 42);
  const failure = new Error("private source or environment must not be logged");
  await assert.rejects(measureDiagnosticPhase(context, async () => { throw failure; }), (error) => error === failure);
  const records = output.map((line) => JSON.parse(line.slice("[Judge Diagnostic] ".length)));
  assert.equal(records.length, 2);
  for (const record of records) {
    assert.equal(record.backendPid, process.pid);
    assert.equal(record.jobId, "job_1");
    assert.equal(record.runId, "compile_1");
    assert.ok(record.durationMs >= 0);
    assert.ok(Number.isFinite(Date.parse(record.at)));
  }
  assert.deepEqual(records.map((record) => record.status), ["completed", "failed"]);
  assert.equal(output.some((line) => line.includes(failure.message)), false);
  process.env.JUDGEDESK_JUDGE_TRACE = "0";
  await measureDiagnosticPhase(context, async () => undefined);
  assert.equal(output.length, 2, "diagnostics are opt-in");
});
