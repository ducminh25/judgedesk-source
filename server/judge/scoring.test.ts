import assert from "node:assert/strict";
import test from "node:test";
import { calculateProblemSummary } from "./scoring.js";
import type { TestCaseRun } from "../types.js";
import { createRational, parseRational } from "../../shared/rational.js";

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

test("polygon test points define max score even when groups are disabled", () => {
  const testCases = [
    testCase("test01", "AC", 0.4),
    testCase("test02", "AC", 0.4),
    testCase("test03", "WA", 0),
  ];
  const summary = calculateProblemSummary({
    compileStatus: "OK",
    testCases,
    testDirectories: ["test01", "test02", "test03"],
    config: {
      defaultScore: 1,
      polygonConfig: {
        enableGroups: false,
        tests: {
          test01: { points: 0.4 },
          test02: { points: 0.4 },
          test03: { points: 0.4 },
        },
      },
    },
  });

  assert.deepEqual(summary, { total: 3, passed: 2, score: 0.8, maxScore: 1.2, status: "PARTIAL" });
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

test("infrastructure compilation failures with no tests are JE, never AC", () => {
  const summary = calculateProblemSummary({ compileStatus: "JE", testCases: [], testDirectories: ["01"], config: { totalScore: "1/3" } });
  assert.equal(summary.status, "JE");
  assert.equal(summary.score, 0);
  assert.equal(summary.maxScore, 1 / 3);
  assert.equal(summary.total, 0);
});

test("a runtime JE invalidates the aggregate even after an exact AC award", () => {
  const testCases = [{ ...testCase("01", "AC", 1 / 3), scoreExact: parseRational("1/3") }, testCase("02", "JE", 0)];
  const summary = calculateProblemSummary({ compileStatus: "OK", testCases, testDirectories: ["01", "02"], config: { totalScore: "2/3" } });
  assert.equal(summary.status, "JE");
  assert.equal(summary.score, 0);
  assert.deepEqual(summary.scoreExact, createRational(0));
  assert.deepEqual(summary.maxScoreExact, parseRational("2/3"));
  assert.equal(summary.passed, 1);
  assert.deepEqual(testCases[0].scoreExact, parseRational("1/3"), "keep testcase evidence, not a valid problem award");
});

test("JE preserves exact testcase evidence in incomplete and dependent groups", () => {
  const runs = [
    { ...testCase("01", "AC", 1 / 3), scoreExact: parseRational("1/3") },
    testCase("02", "JE", 0),
    { ...testCase("03", "AC", 1 / 2), scoreExact: parseRational("1/2") },
  ];
  const evidence = structuredClone(runs);
  const summary = calculateProblemSummary({ compileStatus: "OK", testCases: runs, testDirectories: ["01", "02", "03"],
    config: { polygonConfig: { enableGroups: true,
      groups: { A: { policy: "COMPLETE_GROUP" }, B: { dependencies: ["A"] } },
      tests: { "01": { group: "A", points: "1/3" }, "02": { group: "A", points: "1/3" }, "03": { group: "B", points: "1/2" } },
    } } });
  assert.equal(summary.status, "JE");
  assert.deepEqual(summary.scoreExact, createRational(0));
  assert.deepEqual(runs, evidence);
});

test("scoring eliminates IEEE floating point epsilon (0.35*10=3.5 and 0.3*10=3)", () => {
  const testCases35 = Array.from({ length: 10 }, (_, i) => testCase(`t${i}`, "AC", 0.35));
  const summary35 = calculateProblemSummary({
    compileStatus: "OK",
    testCases: testCases35,
    testDirectories: testCases35.map(t => t.name),
    config: {
      polygonConfig: {
        tests: Object.fromEntries(testCases35.map(t => [t.name, { points: 0.35 }]))
      }
    }
  });
  assert.equal(summary35.score, 3.5);
  assert.equal(summary35.maxScore, 3.5);

  const testCases30 = Array.from({ length: 10 }, (_, i) => testCase(`t${i}`, "AC", 0.3));
  const summary30 = calculateProblemSummary({
    compileStatus: "OK",
    testCases: testCases30,
    testDirectories: testCases30.map(t => t.name),
    config: {
      polygonConfig: {
        tests: Object.fromEntries(testCases30.map(t => [t.name, { points: 0.3 }]))
      }
    }
  });
  assert.equal(summary30.score, 3);
  assert.equal(summary30.maxScore, 3);
});

test("scoring supports fractional points with exact rational accumulation", () => {
  const testCases = Array.from({ length: 6 }, (_, i) => testCase(`t${i}`, "AC", 1/3));
  const summary = calculateProblemSummary({
    compileStatus: "OK",
    testCases,
    testDirectories: testCases.map(t => t.name),
    config: {
      polygonConfig: {
        tests: Object.fromEntries(testCases.map(t => [t.name, { points: "1/3" }]))
      }
    }
  });
  assert.equal(summary.score, 2);
  assert.equal(summary.maxScore, 2);
});

test("scoring preserves the safe-integer boundary after fractional test points", () => {
  const names = ["01", "02", "03", "04"];
  const points = ["1/3", "1/2", "1/6", "9007199254740990"];
  const scores = [1 / 3, 1 / 2, 1 / 6, 9007199254740990];
  const testCases = names.map((name, index) => testCase(name, "AC", scores[index]));
  const summary = calculateProblemSummary({
    compileStatus: "OK",
    testCases,
    testDirectories: names,
    config: { testScores: Object.fromEntries(names.map((name, index) => [name, points[index]])) },
  });
  assert.equal(summary.score, Number.MAX_SAFE_INTEGER);
  assert.equal(summary.maxScore, Number.MAX_SAFE_INTEGER);
});

test("proportional boundary scores retain the awarded fraction instead of reparsing display", () => {
  const runs = [{ ...testCase("01", "AC", Number.MAX_SAFE_INTEGER / 3), scoreExact: parseRational("9007199254740991/3") }];
  const summary = calculateProblemSummary({ compileStatus: "OK", testCases: runs, testDirectories: ["01", "02", "03"], config: { totalScore: "9007199254740991" } });
  assert.deepEqual(summary.scoreExact, { n: Number.MAX_SAFE_INTEGER, d: 3 });
  assert.deepEqual(summary.maxScoreExact, { n: Number.MAX_SAFE_INTEGER, d: 1 });
});

test("group rejection clears the exact awarded score with its display", () => {
  const runs = [{ ...testCase("01", "AC", 1 / 3), scoreExact: parseRational("1/3") }, testCase("02", "WA", 0)];
  calculateProblemSummary({ compileStatus: "OK", testCases: runs, testDirectories: ["01", "02"], config: { polygonConfig: { enableGroups: true, groups: { A: { policy: "COMPLETE_GROUP" } }, tests: { "01": { group: "A", points: "1/3" }, "02": { group: "A", points: "1/3" } } } } });
  assert.deepEqual(runs[0].scoreExact, createRational(0));
});

test("group scoring ignores stale configured tests and handles built-in-like group names", () => {
  const runs = [testCase("01", "AC", 2), testCase("02", "WA", 0)];
  const summary = calculateProblemSummary({
    compileStatus: "OK", testCases: runs, testDirectories: ["01", "02"],
    config: { polygonConfig: {
      enableGroups: true,
      groups: { constructor: { policy: "COMPLETE_GROUP" } },
      tests: { "01": { points: 2, group: "constructor" }, "02": { points: 3, group: "constructor" }, stale: { points: 100 } },
    } },
  });
  assert.equal(summary.maxScore, 5);
  assert.equal(summary.score, 0);
  assert.equal(runs[0].score, 0);
});

test("group-only test configuration uses default points for its maximum", () => {
  const summary = calculateProblemSummary({
    compileStatus: "OK", testCases: [testCase("01", "AC", 2)], testDirectories: ["01"],
    config: { defaultScore: 2, polygonConfig: { enableGroups: true, tests: { "01": { group: "A" } } } },
  });
  assert.equal(summary.maxScore, 2);
});
