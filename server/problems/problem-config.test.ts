import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultProblemConfig, normalizeProblemConfig } from "../../shared/problem-config.js";

test("problem config defaults use the problem name and safe grading defaults", () => {
  assert.deepEqual(createDefaultProblemConfig("SUM"), {
    useStdIO: false,
    useStdIn: false,
    useStdOut: false,
    inputFile: "SUM.inp",
    outputFile: "SUM.out",
    totalScore: null,
    defaultScore: 1,
    testScores: {},
    memoryLimit: 256,
    checkerType: "C1",
    polygonConfig: { enableGroups: false, tests: {}, groups: {} }
  });
});

test("stored config overrides request config and legacy useStdIO is normalized", () => {
  const config = normalizeProblemConfig(
    "SUM",
    { useStdIO: false, defaultScore: 2, checkerType: "C2", testScores: { test01: 2 } },
    {
      useStdIO: true,
      defaultScore: 3,
      checkerType: "C3",
      testScores: { test02: 4 },
      enableGroups: true,
      tests: { test01: { points: 5, group: "A" } },
      groups: { A: { policy: "EACH_TEST", dependencies: [] } }
    }
  );

  assert.equal(config.useStdIn, true);
  assert.equal(config.useStdOut, true);
  assert.equal(config.defaultScore, 3);
  assert.equal(config.checkerType, "C3");
  assert.deepEqual(config.testScores, { test01: 2, test02: 4 });
  assert.equal(config.polygonConfig.enableGroups, true);
});
