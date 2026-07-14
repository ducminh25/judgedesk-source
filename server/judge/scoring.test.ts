import assert from "node:assert/strict";
import test from "node:test";
import { calculateProblemSummary } from "./scoring.js";
import type { TestCaseRun } from "../types.js";

function testCase(name: string, status: TestCaseRun["status"], score: number): TestCaseRun {
  return { name, status, score, executionTime: 1 };
}

test("COMPLETE_GROUP and dependencies clear scores without changing verdicts", () => {
  const testCases = [testCase("a1", "AC", 5), testCase("a2", "WA", 0), testCase("b1", "AC", 5)];
  const summary = calculateProblemSummary({
    compileStatus: "OK",
    testCases,
    testDirectories: ["a1", "a2", "b1"],
    config: {
      polygonConfig: {
        enableGroups: true,
        groups: {
          A: { policy: "COMPLETE_GROUP" },
          B: { dependencies: ["A"] }
        },
        tests: {
          a1: { group: "A", points: 5 },
          a2: { group: "A", points: 5 },
          b1: { group: "B", points: 5 }
        }
      }
    }
  });

  assert.deepEqual(testCases.map((item) => item.score), [0, 0, 0]);
  assert.deepEqual(summary, { total: 3, passed: 2, score: 0, maxScore: 15, status: "PARTIAL" });
});

test("configured total score is used as max score and displayed score is rounded", () => {
  const summary = calculateProblemSummary({
    compileStatus: "OK",
    testCases: [testCase("01", "AC", 33.3333), testCase("02", "AC", 66.6667)],
    testDirectories: ["01", "02"],
    config: { totalScore: 100, defaultScore: 1 }
  });

  assert.deepEqual(summary, { total: 2, passed: 2, score: 100, maxScore: 100, status: "AC" });
});

test("compile errors take precedence when no tests ran", () => {
  const summary = calculateProblemSummary({
    compileStatus: "CE",
    testCases: [],
    testDirectories: [],
    config: {}
  });

  assert.equal(summary.status, "CE");
});
