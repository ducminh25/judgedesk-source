import type { TestCaseRun } from "../../types";

export const VERDICT_LABELS: Record<TestCaseRun["status"], string> = {
  AC: "Accepted",
  WA: "Wrong Answer",
  PE: "Presentation Error",
  TLE: "Time Limit Exceeded",
  MLE: "Memory Limit Exceeded",
  RE: "Runtime Error",
  CE: "Compilation Error",
  FAIL: "Checker Failed",
  PARTIAL: "Partial"
};

export function describeTestResult(test: TestCaseRun): string {
  if (test.checkerMessage) return test.checkerMessage;
  const label = VERDICT_LABELS[test.status] || test.status;
  if ((test.status === "RE" || test.status === "FAIL") && test.errorDetail) {
    return `${label}: ${test.errorDetail}`;
  }
  return label;
}
