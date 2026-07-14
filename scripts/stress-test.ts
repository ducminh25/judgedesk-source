import assert from "node:assert/strict";
import path from "node:path";
import type { JudgeStreamEvent, ProblemResult, TestVerdict } from "../shared/contracts";

interface StressCase {
  contestant: string;
  problem: string;
  compileStatus: ProblemResult["compileStatus"];
  verdict?: TestVerdict;
  score: number;
  maxScore: number;
  passed?: number;
}

const cases: StressCase[] = [
  { contestant: "AC_cpp", problem: "A_plus_B", compileStatus: "OK", verdict: "AC", score: 5, maxScore: 5, passed: 5 },
  { contestant: "AC_c3_c4", problem: "check_c3", compileStatus: "OK", verdict: "AC", score: 1, maxScore: 1, passed: 1 },
  { contestant: "AC_c3_c4", problem: "check_c4", compileStatus: "OK", verdict: "AC", score: 1, maxScore: 1, passed: 1 },
  { contestant: "AC_custom_cpp_and_exe", problem: "check_custom_cpp", compileStatus: "OK", verdict: "AC", score: 1, maxScore: 1, passed: 1 },
  { contestant: "AC_custom_cpp_and_exe", problem: "check_custom_exe", compileStatus: "OK", verdict: "AC", score: 1, maxScore: 1, passed: 1 },
  { contestant: "Group_PassAll", problem: "check_groups", compileStatus: "OK", verdict: "AC", score: 15, maxScore: 15, passed: 4 },
  { contestant: "CE_cpp", problem: "A_plus_B", compileStatus: "CE", score: 0, maxScore: 0 },
  { contestant: "WA_cpp", problem: "A_plus_B", compileStatus: "OK", verdict: "WA", score: 0, maxScore: 5, passed: 0 }
];

const stressRoot = process.env.STRESS_TEST_ROOT;
const serverUrl = process.env.JUDGE_SERVER_URL || "http://127.0.0.1:3000";
if (!stressRoot) throw new Error("Set STRESS_TEST_ROOT to the stress_test_judge directory.");

async function judge(stressCase: StressCase): Promise<ProblemResult> {
  const response = await fetch(`${serverUrl}/api/batch-judge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      thisinhPath: path.join(stressRoot!, "contestants"),
      testPath: path.join(stressRoot!, "test"),
      timeLimit: 1000,
      jobId: `stress_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      problemConfigs: {},
      targetContestants: [stressCase.contestant],
      targetProblems: [stressCase.problem]
    })
  });
  if (!response.ok) throw new Error(`Judge returned HTTP ${response.status}: ${await response.text()}`);
  const text = await response.text();
  const events = text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as JudgeStreamEvent);
  const error = events.find(event => event.type === "error");
  if (error?.type === "error") throw new Error(error.data.message);
  const completed = events.find(event => event.type === "problem_completed");
  assert.ok(completed?.type === "problem_completed", `No result for ${stressCase.contestant}/${stressCase.problem}`);
  return completed.data.problemResult;
}

for (const stressCase of cases) {
  const result = await judge(stressCase);
  assert.equal(result.compileStatus, stressCase.compileStatus, `${stressCase.contestant}/${stressCase.problem} compile status`);
  assert.equal(result.summary.score, stressCase.score, `${stressCase.contestant}/${stressCase.problem} score`);
  assert.equal(result.summary.maxScore, stressCase.maxScore, `${stressCase.contestant}/${stressCase.problem} max score`);
  if (stressCase.passed !== undefined) assert.equal(result.summary.passed, stressCase.passed, `${stressCase.contestant}/${stressCase.problem} passed tests`);
  if (stressCase.verdict) {
    assert.ok(result.testCases.length > 0, `${stressCase.contestant}/${stressCase.problem} has no test results`);
    assert.equal(result.testCases[0].status, stressCase.verdict, `${stressCase.contestant}/${stressCase.problem} first verdict`);
  }
  console.log(`PASS ${stressCase.contestant}/${stressCase.problem}: ${result.compileStatus}, ${result.summary.score}/${result.summary.maxScore}`);
}
