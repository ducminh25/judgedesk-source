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
  const status = calculateProblemStatus(compileStatus, testCases);
  if (status !== "JE") applyGroupScoring(testCases, config.polygonConfig);
  const passed = testCases.filter((test) => test.status === "AC").length;
  // Retain testcase evidence but never award a partial problem grade for a
  // broken judge. Exact rational scoring for valid results is unchanged.
  const scoreRat = status === "JE" ? createRational(0) : testCases.reduce(
    (total, test) => addRational(total, parseRational(test.scoreExact ?? test.score)),
    createRational(0)
  );
  const score = rationalToNumber(scoreRat);
  const polygonConfig = config.polygonConfig;
  const hasConfiguredPolygonPoints = testDirectories.some(
    (testDirectory) => Object.hasOwn(polygonConfig?.tests || {}, testDirectory)
      && polygonConfig?.tests?.[testDirectory]?.points !== undefined
  );
  let maxScoreRat = createRational(0);

  if (polygonConfig?.enableGroups) {
    maxScoreRat = testDirectories.reduce(
      (total, name) => addRational(total, parseRational((Object.hasOwn(polygonConfig.tests || {}, name) ? polygonConfig.tests?.[name]?.points : undefined) ?? config.defaultScore ?? 1)),
      createRational(0)
    );
  } else if (config.totalScore !== undefined && config.totalScore !== null && config.totalScore !== "") {
    maxScoreRat = parseRational(config.totalScore);
  } else if (hasConfiguredPolygonPoints) {
    maxScoreRat = testDirectories.reduce((total, testDirectory) => {
      const polyPoints = Object.hasOwn(polygonConfig?.tests || {}, testDirectory)
        ? polygonConfig?.tests?.[testDirectory]?.points
        : undefined;
      const configuredScore = polyPoints !== undefined && polyPoints !== null && polyPoints !== ""
        ? polyPoints
        : config.testScores?.[testDirectory];
      const testScore =
        configuredScore !== undefined && configuredScore !== null && configuredScore !== ""
          ? parseRational(configuredScore)
          : config.defaultScore !== undefined && config.defaultScore !== null && config.defaultScore !== ""
            ? parseRational(config.defaultScore)
            : createRational(1);
      return addRational(total, testScore);
    }, createRational(0));
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

  const groupResults = new Map<string, GroupResult>();
  for (const [groupName, groupConfig] of Object.entries(polygonConfig.groups)) {
    const tests = testCases.filter((test) => Object.hasOwn(polygonConfig.tests || {}, test.name)
      && polygonConfig.tests?.[test.name]?.group === groupName);
    groupResults.set(groupName, {
      allAccepted: tests.length > 0 && tests.every((test) => test.status === "AC"),
      tests,
      config: groupConfig
    });
  }

  for (const groupResult of groupResults.values()) {
    const dependenciesPassed = (groupResult.config.dependencies || []).every(
      (dependency) => groupResults.get(dependency)?.allAccepted === true
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
  if (compileStatus === "JE" || testCases.some(test => test.status === "JE")) return "JE";
  if (compileStatus === "CE") return "CE";
  if (testCases.length === 0) return "AC";

  const failedTests = testCases.filter((test) => test.status !== "AC");
  if (failedTests.length === testCases.length) return failedTests[0].status;
  if (failedTests.length > 0) return "PARTIAL";
  return "AC";
}
