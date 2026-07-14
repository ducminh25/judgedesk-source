import type { NormalizedProblemConfig, PolygonConfig, ProblemConfig } from "./contracts.js";

export type ProblemConfigInput = Partial<ProblemConfig> & Partial<PolygonConfig>;

export function createDefaultProblemConfig(problemName: string): NormalizedProblemConfig {
  return {
    useStdIO: false,
    useStdIn: false,
    useStdOut: false,
    inputFile: `${problemName}.inp`,
    outputFile: `${problemName}.out`,
    totalScore: null,
    defaultScore: 1,
    testScores: {},
    memoryLimit: 256,
    checkerType: "C1",
    polygonConfig: { enableGroups: false, tests: {}, groups: {} }
  };
}

export function normalizeProblemConfig(
  problemName: string,
  requestConfig?: ProblemConfigInput | null,
  storedConfig?: ProblemConfigInput | null
): NormalizedProblemConfig {
  const defaults = createDefaultProblemConfig(problemName);
  const request = requestConfig || {};
  const stored = storedConfig || {};
  const storedPolygon = hasPolygonFields(stored)
    ? {
        enableGroups: stored.enableGroups ?? false,
        tests: { ...(stored.tests || {}) },
        groups: { ...(stored.groups || {}) }
      }
    : undefined;
  const polygonConfig = storedPolygon || request.polygonConfig || defaults.polygonConfig;
  const useStdIO = stored.useStdIO ?? request.useStdIO ?? defaults.useStdIO;
  const totalScoreValue = stored.totalScore ?? request.totalScore ?? defaults.totalScore;

  return {
    useStdIO,
    useStdIn: stored.useStdIn ?? stored.useStdIO ?? request.useStdIn ?? request.useStdIO ?? defaults.useStdIn,
    useStdOut: stored.useStdOut ?? stored.useStdIO ?? request.useStdOut ?? request.useStdIO ?? defaults.useStdOut,
    inputFile: stored.inputFile || request.inputFile || defaults.inputFile,
    outputFile: stored.outputFile || request.outputFile || defaults.outputFile,
    totalScore: toNullableNumber(totalScoreValue),
    defaultScore: toNumber(stored.defaultScore ?? request.defaultScore, defaults.defaultScore),
    testScores: normalizeTestScores(request.testScores, stored.testScores),
    memoryLimit: toNumber(stored.memoryLimit ?? request.memoryLimit, defaults.memoryLimit),
    checkerType: stored.checkerType || request.checkerType || defaults.checkerType,
    polygonConfig: {
      enableGroups: polygonConfig.enableGroups ?? false,
      tests: { ...(polygonConfig.tests || {}) },
      groups: { ...(polygonConfig.groups || {}) }
    }
  };
}

function hasPolygonFields(config: ProblemConfigInput): boolean {
  return config.enableGroups !== undefined || config.tests !== undefined || config.groups !== undefined;
}

function toNullableNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toNumber(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeTestScores(
  requestScores?: Record<string, unknown>,
  storedScores?: Record<string, unknown>
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [testName, value] of Object.entries({ ...(requestScores || {}), ...(storedScores || {}) })) {
    const parsed = Number(value);
    if (value !== "" && Number.isFinite(parsed)) result[testName] = parsed;
  }
  return result;
}
