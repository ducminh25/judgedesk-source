import assert from "node:assert/strict";
import test from "node:test";
import type { BatchJudgeResult, ProblemResult } from "../../types";
import { judgeResultsReducer, problemHasPositiveScore } from "./judge-results";

function problem(problemName: string, score: number): ProblemResult {
  return {
    problemName,
    language: "cpp",
    compileStatus: "OK",
    compileTime: 0,
    summary: { status: "AC", score, total: 1, passed: 1, maxScore: score },
    testCases: [],
  };
}

test("delete_result removes only the selected scoreboard cell", () => {
  const state: BatchJudgeResult = {
    success: true,
    contestants: [
      { contestantName: "Alice", problems: [problem("A", 10), problem("B", 20)] },
      { contestantName: "Bob", problems: [problem("A", 30)] },
    ],
  };
  const next = judgeResultsReducer(state, {
    type: "delete_result",
    contestantName: "Alice",
    problemName: "a",
  });
  assert.deepEqual(
    next?.contestants.map((contestant) => [contestant.contestantName, contestant.problems.map((entry) => entry.problemName)]),
    [["Alice", ["B"]], ["Bob", ["A"]]],
  );
});

test("delete_result removes an empty contestant result row", () => {
  const state: BatchJudgeResult = {
    success: true,
    contestants: [{ contestantName: "Alice", problems: [problem("A", 10)] }],
  };
  const next = judgeResultsReducer(state, {
    type: "delete_result",
    contestantName: "Alice",
    problemName: "A",
  });
  assert.deepEqual(next?.contestants, []);
});

test("delete_selected removes only the selected contestant/problem intersection", () => {
  const state: BatchJudgeResult = {
    success: true,
    contestants: [
      { contestantName: "Alice", problems: [problem("A", 10), problem("B", 20)] },
      { contestantName: "Bob", problems: [problem("A", 30), problem("B", 40)] },
    ],
  };
  const next = judgeResultsReducer(state, {
    type: "delete_selected",
    contestantNames: ["Alice"],
    problemNames: ["B"],
  });
  assert.deepEqual(
    next?.contestants.map((contestant) => [
      contestant.contestantName,
      contestant.problems.map((entry) => entry.problemName),
    ]),
    [["Alice", ["A"]], ["Bob", ["A", "B"]]],
  );
});

test("problem configuration confirmation is required only for a positive score", () => {
  const result = {
    success: true,
    contestants: [
      { contestantName: "Alice", problems: [problem("A", 0), problem("B", 3)] },
      { contestantName: "Bob", problems: [problem("a", 2)] },
    ],
  };
  assert.equal(problemHasPositiveScore(result, "A"), true);
  assert.equal(problemHasPositiveScore(result, "B"), true);
  assert.equal(problemHasPositiveScore(result, "C"), false);
  assert.equal(problemHasPositiveScore(null, "A"), false);
});

test("saving a problem configuration can remove every score and judging log for that problem", () => {
  const state: BatchJudgeResult = {
    success: true,
    contestants: [
      { contestantName: "Alice", problems: [problem("A", 10), problem("B", 20)] },
      { contestantName: "Bob", problems: [problem("a", 30)] },
    ],
  };
  const next = judgeResultsReducer(state, { type: "delete_problem", problemName: "A" });
  assert.deepEqual(next?.contestants, [
    { contestantName: "Alice", problems: [problem("B", 20)] },
  ]);
});
