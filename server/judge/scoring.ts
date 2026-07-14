import type { ProblemResult, TestCaseRun } from "../types.js";

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
  let score = testCases.reduce((total, test) => total + test.score, 0);
  const status = calculateProblemStatus(compileStatus, testCases);
  const polygonConfig = config.polygonConfig;
  let maxScore = 0;

  if (polygonConfig?.enableGroups) {
    maxScore = Object.values(polygonConfig.tests || {}).reduce(
      (total, test) => total + (Number(test.points) || 0),
      0
    );
  } else if (config.totalScore !== undefined && config.totalScore !== null && config.totalScore !== "") {
    maxScore = Number(config.totalScore);
    score = roundDisplayScore(score);
  } else {
    if (testCases.length > 0) {
      maxScore = testDirectories.reduce((total, testDirectory) => {
        const configuredScore = config.testScores?.[testDirectory];
        const testScore =
          configuredScore !== undefined && configuredScore !== ""
            ? Number(configuredScore)
            : config.defaultScore !== undefined
              ? Number(config.defaultScore)
              : 1;
        return total + testScore;
      }, 0);
    }
    score = roundDisplayScore(score);
  }

  return {
    total: testCases.length,
    passed,
    score,
    maxScore,
    status
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

function roundDisplayScore(score: number): number {
  return Math.round(score * 100) / 100;
}
