import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BatchJudgeResult } from "../../types.js";
import {
  hasAnyContestantScore,
  indexProblemResults,
  indexScoreboardResults,
  selectedTotalScore,
  sortContestants,
} from "./scoreboard-model.js";

describe("scoreboard-model", () => {
  const sampleResult: BatchJudgeResult = {
    success: true,
    contestants: [
      {
        contestantName: "Alice",
        problems: [
          {
            problemName: "A_SUM",
            language: "cpp",
            compileStatus: "OK",
            testCases: [],
            summary: { total: 10, passed: 10, maxScore: 100, score: 100, status: "AC" },
          },
          {
            problemName: "B_SORT",
            language: "cpp",
            compileStatus: "OK",
            testCases: [],
            summary: { total: 10, passed: 5, maxScore: 100, score: 50, status: "PARTIAL" },
          },
        ],
      },
      {
        contestantName: "Bob",
        problems: [
          {
            problemName: "A_SUM",
            language: "cpp",
            compileStatus: "OK",
            testCases: [],
            summary: { total: 10, passed: 8, maxScore: 100, score: 80, status: "PARTIAL" },
          },
          {
            problemName: "B_SORT",
            language: "cpp",
            compileStatus: "OK",
            testCases: [],
            summary: { total: 10, passed: 9, maxScore: 100, score: 90, status: "PARTIAL" },
          },
        ],
      },
      {
        contestantName: "Charlie",
        problems: [],
      },
    ],
  };

  it("indexes scoreboard results by contestant name and tracks problems with results", () => {
    const indexed = indexScoreboardResults(sampleResult);
    assert.equal(indexed.contestants.size, 3);
    assert.ok(indexed.contestants.has("Alice"));
    assert.ok(indexed.contestants.has("Bob"));
    assert.ok(indexed.contestants.has("Charlie"));
    assert.ok(indexed.problemsWithResults.has("a_sum"));
    assert.ok(indexed.problemsWithResults.has("b_sort"));
    assert.equal(indexed.problemsWithResults.has("c_tree"), false);
  });

  it("handles null batch results gracefully", () => {
    const indexed = indexScoreboardResults(null);
    assert.equal(indexed.contestants.size, 0);
    assert.equal(indexed.problemsWithResults.size, 0);
  });

  it("indexes problems for a single contestant case-insensitively", () => {
    const alice = sampleResult.contestants[0];
    const problemMap = indexProblemResults(alice);
    assert.equal(problemMap.size, 2);
    assert.equal(problemMap.get("a_sum")?.summary.score, 100);
    assert.equal(problemMap.get("b_sort")?.summary.score, 50);
  });

  it("calculates total score considering only selected problems", () => {
    const bob = sampleResult.contestants[1];
    const onlyA = new Set(["a_sum"]);
    assert.equal(selectedTotalScore(bob, onlyA), 80);

    const both = new Set(["a_sum", "b_sort"]);
    assert.equal(selectedTotalScore(bob, both), 170);

    const none = new Set<string>();
    assert.equal(selectedTotalScore(bob, none), 0);
  });

  it("sorts contestants alphabetically ascending and descending", () => {
    const list = ["Charlie", "Alice", "Bob"];
    const asc = sortContestants(list, "asc", sampleResult, ["A_SUM", "B_SORT"], { A_SUM: true, B_SORT: true });
    assert.deepEqual(asc, ["Alice", "Bob", "Charlie"]);

    const desc = sortContestants(list, "desc", sampleResult, ["A_SUM", "B_SORT"], { A_SUM: true, B_SORT: true });
    assert.deepEqual(desc, ["Charlie", "Bob", "Alice"]);
  });

  it("sorts contestants by score considering selected active problems", () => {
    const list = ["Alice", "Bob", "Charlie"];
    // Both problems: Bob (170) > Alice (150) > Charlie (0)
    const byBoth = sortContestants(list, "score", sampleResult, ["A_SUM", "B_SORT"], { A_SUM: true, B_SORT: true });
    assert.deepEqual(byBoth, ["Bob", "Alice", "Charlie"]);

    // Only A_SUM: Alice (100) > Bob (80) > Charlie (0)
    const byA = sortContestants(list, "score", sampleResult, ["A_SUM", "B_SORT"], { A_SUM: true, B_SORT: false });
    assert.deepEqual(byA, ["Alice", "Bob", "Charlie"]);

    // Default mode preserves order
    const byDefault = sortContestants(list, "default", sampleResult, ["A_SUM", "B_SORT"], { A_SUM: true, B_SORT: true });
    assert.deepEqual(byDefault, ["Alice", "Bob", "Charlie"]);
  });

  it("sorts high to low (score_desc) and low to high (score_asc) placing unscored at the bottom", () => {
    // Dan has a scored problem with 0 points (tested, got 0)
    // Eve has no score (not in result)
    const extendedResult: BatchJudgeResult = {
      success: true,
      contestants: [
        ...sampleResult.contestants,
        {
          contestantName: "Dan",
          problems: [
            {
              problemName: "A_SUM",
              language: "cpp",
              compileStatus: "OK",
              testCases: [],
              summary: { total: 10, passed: 0, maxScore: 100, score: 0, status: "WA" },
            },
          ],
        },
      ],
    };

    const list = ["Eve", "Charlie", "Dan", "Alice", "Bob"];
    // Bob (170) > Alice (150) > Dan (0) > Charlie (unscored, A-Z) > Eve (unscored, A-Z)
    const desc = sortContestants(list, "score_desc", extendedResult, ["A_SUM", "B_SORT"], { A_SUM: true, B_SORT: true });
    assert.deepEqual(desc, ["Bob", "Alice", "Dan", "Charlie", "Eve"]);

    // In ascending mode: Dan (0) < Alice (150) < Bob (170) > unscored Charlie and Eve still at the bottom A-Z!
    const asc = sortContestants(list, "score_asc", extendedResult, ["A_SUM", "B_SORT"], { A_SUM: true, B_SORT: true });
    assert.deepEqual(asc, ["Dan", "Alice", "Bob", "Charlie", "Eve"]);

    // Tie-breaker when scores are equal: alphabetical A-Z
    const tiedResult: BatchJudgeResult = {
      success: true,
      contestants: [
        {
          contestantName: "Zara",
          problems: [{ problemName: "A", language: "cpp", compileStatus: "OK", testCases: [], summary: { total: 1, passed: 1, maxScore: 10, score: 10, status: "AC" } }],
        },
        {
          contestantName: "Adam",
          problems: [{ problemName: "A", language: "cpp", compileStatus: "OK", testCases: [], summary: { total: 1, passed: 1, maxScore: 10, score: 10, status: "AC" } }],
        },
      ],
    };
    const tiedDesc = sortContestants(["Zara", "Adam"], "score_desc", tiedResult, ["A"], { A: true });
    assert.deepEqual(tiedDesc, ["Adam", "Zara"]);

    const tiedAsc = sortContestants(["Zara", "Adam"], "score_asc", tiedResult, ["A"], { A: true });
    assert.deepEqual(tiedAsc, ["Adam", "Zara"]);
  });

  it("checks whether any contestant has a score dynamically", () => {
    assert.equal(hasAnyContestantScore(null, ["Alice"], ["A_SUM"], { A_SUM: true }), false);
    assert.equal(hasAnyContestantScore({ success: true, contestants: [] }, ["Alice"], ["A_SUM"], { A_SUM: true }), false);

    // Charlie has empty problems
    assert.equal(hasAnyContestantScore(sampleResult, ["Charlie"], ["A_SUM"], { A_SUM: true }), false);

    // Selected problems don't match scored problems
    assert.equal(hasAnyContestantScore(sampleResult, ["Alice"], ["C_TREE"], { C_TREE: true }), false);

    // Alice has scored on A_SUM
    assert.equal(hasAnyContestantScore(sampleResult, ["Alice"], ["A_SUM", "B_SORT"], { A_SUM: true, B_SORT: false }), true);

    // Whole list with Bob/Alice has score
    assert.equal(hasAnyContestantScore(sampleResult, ["Charlie", "Eve", "Bob"], ["A_SUM"], { A_SUM: true }), true);
  });
});
