import type { NormalizedProblemConfig, PolygonConfig, ProblemConfig } from "./contracts.js";
import { createCompileConfig, normalizeCompileConfig } from "./compile-config.js";
import {
  addRational,
  createRational,
  divideRational,
  formatRational,
  multiplyRational,
  parseRational,
  toCanonicalPointValue,
} from "./rational.js";

export type ProblemConfigInput = Partial<ProblemConfig> & Partial<PolygonConfig>;

export interface DefaultProblemConfigOverrides {
  checkerType?: string;
  interactor?: string;
}

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

export function createDefaultProblemConfig(
  problemName: string,
  overrides?: DefaultProblemConfigOverrides,
): NormalizedProblemConfig {
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
    checkerType: overrides?.checkerType || "C1",
    compile: createCompileConfig(),
    polygonConfig: { enableGroups: false, tests: {}, groups: {} },
    isInteractive: false,
    interactor: overrides?.interactor || "interactor.cpp",
  };
}

export function createDefaultStoredProblemConfig(
  problemName: string,
  overrides?: DefaultProblemConfigOverrides,
): ProblemConfigInput {
  const defaults = createDefaultProblemConfig(problemName, overrides);
  const { polygonConfig, ...rest } = defaults;
  return {
    ...rest,
    enableGroups: polygonConfig.enableGroups,
    tests: polygonConfig.tests,
    groups: polygonConfig.groups,
  };
}

export function reconcileStoredProblemConfig(
  stored: ProblemConfigInput,
  discoveredTests: readonly string[],
): { config: ProblemConfigInput; changed: boolean } {
  if (discoveredTests.length === 0 || !stored || typeof stored !== "object") {
    return { config: stored, changed: false };
  }
  const oldTests = stored.tests && typeof stored.tests === "object" ? stored.tests : undefined;
  const oldScores = stored.testScores && typeof stored.testScores === "object" ? stored.testScores : undefined;
  const hasTests = Boolean(oldTests && Object.keys(oldTests).length > 0);
  const hasTestScores = Boolean(oldScores && Object.keys(oldScores).length > 0);
  if (!hasTests && !hasTestScores) {
    return { config: stored, changed: false };
  }

  const testsMatch = !hasTests || (
    Object.keys(oldTests!).length === discoveredTests.length
    && discoveredTests.every((name) => Object.hasOwn(oldTests!, name))
  );
  const scoresMatch = !hasTestScores || (
    Object.keys(oldScores!).length === discoveredTests.length
    && discoveredTests.every((name) => Object.hasOwn(oldScores!, name))
  );
  if (testsMatch && scoresMatch) {
    return { config: stored, changed: false };
  }

  const enableGroups = Boolean(stored.enableGroups);
  if (enableGroups) {
    return { config: stored, changed: false };
  }
  const defaultScoreRat = stored.defaultScore !== undefined && stored.defaultScore !== null && stored.defaultScore !== ""
    ? parseRational(stored.defaultScore)
    : createRational(1);

  const oldPoints = hasTests
    ? Object.entries(oldTests!).map(([k, v]) => {
        const raw = v?.points !== undefined && v?.points !== null && v?.points !== ""
          ? v.points
          : oldScores?.[k];
        return raw !== undefined && raw !== null && raw !== "" ? parseRational(raw) : defaultScoreRat;
      })
    : Object.values(oldScores!).map((raw) => (
        raw !== undefined && raw !== null && raw !== "" ? parseRational(raw) : defaultScoreRat
      ));

  const oldCount = oldPoints.length;
  const allOldEqual = oldPoints.length > 0 && oldPoints.every(
    (p) => p.n === oldPoints[0].n && p.d === oldPoints[0].d,
  );
  const uniformOldPoint = allOldEqual ? oldPoints[0] : null;

  const hasTotalScore = stored.totalScore !== undefined && stored.totalScore !== null && String(stored.totalScore).trim() !== "";
  const totalRat = hasTotalScore ? parseRational(stored.totalScore) : null;
  const oldDefaultSum = multiplyRational(defaultScoreRat, createRational(oldCount));
  const wasDefaultSumTotal = !enableGroups
    && oldCount > 0
    && allOldEqual
    && uniformOldPoint !== null
    && uniformOldPoint.n === defaultScoreRat.n
    && uniformOldPoint.d === defaultScoreRat.d
    && totalRat !== null
    && totalRat.n === oldDefaultSum.n
    && totalRat.d === oldDefaultSum.d;

  const fallbackPt = uniformOldPoint ?? defaultScoreRat;
  const initialPoints = discoveredTests.map((name) => {
    const raw = (oldTests && Object.hasOwn(oldTests, name) ? oldTests[name]?.points : undefined)
      ?? (oldScores && Object.hasOwn(oldScores, name) ? oldScores[name] : undefined);
    return raw !== undefined && raw !== null && raw !== "" ? parseRational(raw) : fallbackPt;
  });

  let finalPoints = initialPoints;
  if (wasDefaultSumTotal) {
    finalPoints = discoveredTests.map(() => defaultScoreRat);
  } else if (!enableGroups && totalRat !== null && BigInt(totalRat.n) > 0n) {
    const allInitEqual = initialPoints.length > 0 && initialPoints.every(
      (p) => p.n === initialPoints[0].n && p.d === initialPoints[0].d,
    );
    const sumInit = initialPoints.reduce((acc, p) => addRational(acc, p), createRational(0));
    const countRat = createRational(discoveredTests.length);
    finalPoints = initialPoints.map((p) => {
      if (allInitEqual || BigInt(sumInit.n) === 0n) {
        return divideRational(totalRat, countRat);
      }
      const ratio = divideRational(p, sumInit);
      return multiplyRational(totalRat, ratio);
    });
  }

  const nextConfig: ProblemConfigInput = { ...stored };
  if (wasDefaultSumTotal) {
    nextConfig.totalScore = null;
  }
  if (hasTests) {
    const newTests: PolygonConfig["tests"] = {};
    for (let i = 0; i < discoveredTests.length; ++i) {
      const name = discoveredTests[i];
      const prevEntry = oldTests && Object.hasOwn(oldTests, name) ? oldTests[name] : {};
      newTests[name] = {
        ...prevEntry,
        points: toCanonicalPointValue(finalPoints[i]),
      };
    }
    nextConfig.tests = newTests;
  }
  if (hasTestScores) {
    const newScores: Record<string, number | string> = {};
    for (let i = 0; i < discoveredTests.length; ++i) {
      newScores[discoveredTests[i]] = toCanonicalPointValue(finalPoints[i]);
    }
    nextConfig.testScores = newScores;
  }

  return { config: nextConfig, changed: true };
}

export function normalizeProblemConfig(
  problemName: string,
  requestConfig?: ProblemConfigInput | null,
  storedConfig?: ProblemConfigInput | null,
  defaultOverrides?: DefaultProblemConfigOverrides,
): NormalizedProblemConfig {
  const defaults = createDefaultProblemConfig(problemName, defaultOverrides);
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
