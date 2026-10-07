import type { NormalizedProblemConfig, PolygonConfig, ProblemConfig } from "./contracts.js";
import { createCompileConfig, normalizeCompileConfig } from "./compile-config.js";
import { parseRational, formatRational } from "./rational.js";

export type ProblemConfigInput = Partial<ProblemConfig> & Partial<PolygonConfig>;

export const MIN_PROBLEM_MEMORY_LIMIT_MB = 8;
export const MAX_PROBLEM_MEMORY_LIMIT_MB = 1024;
export const DEFAULT_PROBLEM_MEMORY_LIMIT_MB = 256;

export function normalizeProblemMemoryLimit(
  value: unknown,
  fallback = DEFAULT_PROBLEM_MEMORY_LIMIT_MB,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(
    MAX_PROBLEM_MEMORY_LIMIT_MB,
    Math.max(MIN_PROBLEM_MEMORY_LIMIT_MB, Math.round(parsed)),
  );
}

export function createDefaultProblemConfig(problemName: string): NormalizedProblemConfig {
  return {
    testWellFormed: false,
    useStdIO: false,
    useStdIn: false,
    useStdOut: false,
    inputFile: `${problemName}.inp`,
    outputFile: `${problemName}.out`,
    totalScore: null,
    defaultScore: 1,
    testScores: {},
    memoryLimit: DEFAULT_PROBLEM_MEMORY_LIMIT_MB,
    checkerType: "C1",
    compile: createCompileConfig(),
    polygonConfig: { enableGroups: false, tests: {}, groups: {} },
    isInteractive: false,
    interactor: "interactor.cpp",
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
  const isInteractive = Boolean(stored.isInteractive ?? request.isInteractive ?? defaults.isInteractive);
  const interactor = stored.interactor || request.interactor || defaults.interactor;
  const useStdIO = isInteractive ? true : (stored.useStdIO ?? request.useStdIO ?? defaults.useStdIO);
  const totalScoreValue = stored.totalScore ?? request.totalScore ?? defaults.totalScore;

  return {
    testWellFormed: Boolean(stored.testWellFormed ?? request.testWellFormed ?? defaults.testWellFormed),
    useStdIO,
    useStdIn: isInteractive ? true : (stored.useStdIn ?? stored.useStdIO ?? request.useStdIn ?? request.useStdIO ?? defaults.useStdIn),
    useStdOut: isInteractive ? true : (stored.useStdOut ?? stored.useStdIO ?? request.useStdOut ?? request.useStdIO ?? defaults.useStdOut),
    inputFile: stored.inputFile || request.inputFile || defaults.inputFile,
    outputFile: stored.outputFile || request.outputFile || defaults.outputFile,
    totalScore: toNullableScore(totalScoreValue),
    defaultScore: toScoreValue(stored.defaultScore ?? request.defaultScore, defaults.defaultScore),
    testScores: normalizeTestScores(request.testScores, stored.testScores),
    memoryLimit: normalizeProblemMemoryLimit(stored.memoryLimit ?? request.memoryLimit, defaults.memoryLimit),
    checkerType: stored.checkerType || request.checkerType || defaults.checkerType,
    compile: normalizeCompileConfig(stored.compile ?? request.compile),
    polygonConfig: {
      enableGroups: polygonConfig.enableGroups ?? false,
      tests: Object.fromEntries(
        Object.entries(polygonConfig.tests || {}).map(([name, test]) => [
          name,
          {
            ...test,
            points: test.points !== undefined ? toScoreValue(test.points, 1) : 1,
          },
        ])
      ),
      groups: { ...(polygonConfig.groups || {}) }
    },
    isInteractive,
    interactor,
  };
}

function hasPolygonFields(config: ProblemConfigInput): boolean {
  return config.enableGroups !== undefined || config.tests !== undefined || config.groups !== undefined;
}

function toNullableScore(value: unknown): number | string | null {
  if (value === undefined || value === null || value === "") return null;
  const r = parseRational(value);
  if (r.n === 0 && r.d === 1 && typeof value === "string" && value.trim() !== "0") {
    return null;
  }
  return r.d === 1 ? r.n : formatRational(r);
}

function toScoreValue(value: unknown, fallback: number | string): number | string {
  if (value === undefined || value === null || value === "") return fallback;
  const r = parseRational(value);
  if (r.n === 0 && r.d === 1 && typeof value === "string" && value.trim() !== "0") {
    return fallback;
  }
  return r.d === 1 ? r.n : formatRational(r);
}

function normalizeTestScores(
  requestScores?: Record<string, unknown>,
  storedScores?: Record<string, unknown>
): Record<string, number | string> {
  const result: Record<string, number | string> = {};
  for (const [testName, value] of Object.entries({ ...(requestScores || {}), ...(storedScores || {}) })) {
    if (value !== "" && value !== undefined && value !== null) {
      const r = parseRational(value);
      if (r.n !== 0 || value === 0 || value === "0") {
        result[testName] = r.d === 1 ? r.n : formatRational(r);
      }
    }
  }
  return result;
}
