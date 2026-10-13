import type { ProblemResult, TestCaseRun } from "../../types";

/** Older saved summaries may say PARTIAL even though a testcase has JE. */
export function hasJudgeError(problem: ProblemResult): boolean {
  return problem.compileStatus === "JE" || problem.summary.status === "JE"
    || problem.testCases.some(test => test.status === "JE");
}

export const VERDICT_LABELS: Record<TestCaseRun["status"], string> = {
  AC: "Accepted",
  WA: "Wrong Answer",
  PE: "Presentation Error",
  TLE: "Time Limit Exceeded",
  MLE: "Memory Limit Exceeded",
  OLE: "Output Limit Exceeded",
  JE: "Judge Error",
  RE: "Runtime Error",
  CE: "Compilation Error",
  FAIL: "Checker Failed",
  PARTIAL: "Partial"
};

export function describeTestResult(test: TestCaseRun): string {
  if (test.checkerMessage) return test.checkerMessage;
  const label = VERDICT_LABELS[test.status] || test.status;
  if ((test.status === "RE" || test.status === "JE" || test.status === "OLE" || test.status === "FAIL") && test.errorDetail) {
    return `${label}: ${test.errorDetail}`;
  }
  return label;
}
