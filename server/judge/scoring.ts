import type { ProblemResult, TestCaseRun } from "../types.js";
import { addRational, createRational, parseRational, rationalToNumber } from "../../shared/rational.js";

interface PolygonTestConfig {
  group?: string;
  points?: unknown;
}

interface PolygonGroupConfig {
  dependencies?: string[];
  policy?: string;
}

interface PolygonScoringConfig {
  enableGroups?: boolean;
  groups?: Record<string, PolygonGroupConfig>;
  tests?: Record<string, PolygonTestConfig>;
}

export interface ProblemScoringConfig {
  polygonConfig?: PolygonScoringConfig;
  totalScore?: unknown;
  defaultScore?: unknown;
  testScores?: Record<string, unknown>;
}

interface ProblemSummaryOptions {
  compileStatus: ProblemResult["compileStatus"];
  testCases: TestCaseRun[];
  testDirectories: string[];
  config: ProblemScoringConfig;
}

interface GroupResult {
  allAccepted: boolean;
  tests: TestCaseRun[];
  config: PolygonGroupConfig;
}

export function calculateProblemSummary({
  compileStatus,
  testCases,
  testDirectories,
  config
}: ProblemSummaryOptions): ProblemResult["summary"] {
  applyGroupScoring(testCases, config.polygonConfig);

  const passed = testCases.filter((test) => test.status === "AC").length;
  const scoreRat = testCases.reduce(
    (total, test) => addRational(total, parseRational(test.scoreExact ?? test.score)),
    createRational(0)
  );
  const score = rationalToNumber(scoreRat);
  const status = calculateProblemStatus(compileStatus, testCases);
  const polygonConfig = config.polygonConfig;
  const hasConfiguredPolygonPoints = testDirectories.some(
    (testDirectory) => polygonConfig?.tests?.[testDirectory]?.points !== undefined
  );
  let maxScoreRat = createRational(0);

  if (polygonConfig?.enableGroups) {
    maxScoreRat = Object.values(polygonConfig.tests || {}).reduce(
      (total, test) => addRational(total, parseRational(test.points)),
      createRational(0)
    );
  } else if (config.totalScore !== undefined && config.totalScore !== null && config.totalScore !== "") {
    maxScoreRat = parseRational(config.totalScore);
  } else if (hasConfiguredPolygonPoints) {
    maxScoreRat = testDirectories.reduce(
      (total, testDirectory) => addRational(total, parseRational(polygonConfig?.tests?.[testDirectory]?.points)),
      createRational(0)
    );
  } else {
    if (testCases.length > 0) {
      maxScoreRat = testDirectories.reduce((total, testDirectory) => {
        const configuredScore = config.testScores?.[testDirectory];
        const testScore =
          configuredScore !== undefined && configuredScore !== ""
            ? parseRational(configuredScore)
            : config.defaultScore !== undefined
              ? parseRational(config.defaultScore)
              : createRational(1);
        return addRational(total, testScore);
      }, createRational(0));
    }
  }

  const maxScore = rationalToNumber(maxScoreRat);
  const hasExactAwards = testCases.some(test => test.scoreExact !== undefined);

  return {
    total: testCases.length,
    passed,
    score,
    maxScore,
    status,
    ...(hasExactAwards ? { scoreExact: scoreRat, maxScoreExact: maxScoreRat } : {}),
  };
}

function applyGroupScoring(testCases: TestCaseRun[], polygonConfig?: PolygonScoringConfig): void {
  if (!polygonConfig?.enableGroups || !polygonConfig.groups || testCases.length === 0) return;

  const groupResults: Record<string, GroupResult> = {};
  for (const [groupName, groupConfig] of Object.entries(polygonConfig.groups)) {
    const tests = testCases.filter((test) => polygonConfig.tests?.[test.name]?.group === groupName);
    groupResults[groupName] = {
      allAccepted: tests.length > 0 && tests.every((test) => test.status === "AC"),
      tests,
      config: groupConfig
    };
  }

  for (const groupResult of Object.values(groupResults)) {
    const dependenciesPassed = (groupResult.config.dependencies || []).every(
      (dependency) => !groupResults[dependency] || groupResults[dependency].allAccepted
    );
    for (const test of groupResult.tests) {
      if (!dependenciesPassed || (groupResult.config.policy === "COMPLETE_GROUP" && !groupResult.allAccepted)) {
        test.score = 0;
        if (test.scoreExact !== undefined) test.scoreExact = createRational(0);
      }
    }
  }
}

function calculateProblemStatus(
  compileStatus: ProblemResult["compileStatus"],
  testCases: TestCaseRun[]
): ProblemResult["summary"]["status"] {
  if (compileStatus === "CE") return "CE";
  if (testCases.length === 0) return "AC";

  const failedTests = testCases.filter((test) => test.status !== "AC");
  if (failedTests.length === testCases.length) return failedTests[0].status;
  if (failedTests.length > 0) return "PARTIAL";
  return "AC";
}
