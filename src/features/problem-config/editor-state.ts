import { PolygonConfig } from "../../types";
import {
  addRational,
  createRational,
  divideRational,
  multiplyRational,
  parseRational,
  Rational,
  toCanonicalPointValue,
} from "../../../shared/rational";

export interface TestDetail {
  name: string;
  preview: string;
  size: number;
}

export type TestEditType = "points" | "group" | "time" | "batchPoints" | "batchGroup" | "batchTime";

export interface TestEditPopover {
  type: TestEditType;
  testName?: string;
  x: number;
  y: number;
}

export function createEmptyPolygonConfig(): PolygonConfig {
  return { enableGroups: false, tests: {}, groups: {} };
}

export function applyTestEdit(
  config: PolygonConfig,
  edit: TestEditPopover,
  input: string,
  selectedTests: ReadonlySet<string>
): PolygonConfig {
  const next: PolygonConfig = {
    ...config,
    tests: Object.fromEntries(Object.entries(config.tests).map(([name, test]) => [name, { ...test }])),
    groups: Object.fromEntries(Object.entries(config.groups).map(([name, group]) => [name, { ...group, dependencies: [...group.dependencies] }]))
  };
  const targets = edit.type.startsWith("batch")
    ? Array.from(selectedTests)
    : edit.testName
      ? [edit.testName]
      : [];

  for (const testName of targets) {
    const test = next.tests[testName] ?? { points: 1 };
    next.tests[testName] = test;

    if (edit.type === "points" || edit.type === "batchPoints") {
      if (!input || !input.trim()) {
        test.points = 1;
      } else {
        const r = parseRational(input.trim());
        test.points = toCanonicalPointValue(r);
      }
    } else if (edit.type === "time" || edit.type === "batchTime") {
      const value = parseFloat(input);
      test.timeLimit = !Number.isNaN(value) && value > 0 ? value : undefined;
    } else {
      const groupName = input.trim();
      if (!groupName) {
        delete test.group;
        continue;
      }
      test.group = groupName;
      next.groups[groupName] ??= { policy: "EACH_TEST", dependencies: [] };
    }
  }

  return next;
}

export function createsGroupCycle(groups: PolygonConfig["groups"], startGroup: string, newDependency: string): boolean {
  const visited = new Set<string>();
  const stack = [newDependency];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === startGroup) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    stack.push(...(groups[current]?.dependencies ?? []));
  }
  return false;
}

export function setGroupDependency(
  config: PolygonConfig,
  groupName: string,
  dependency: string,
  enabled: boolean
): PolygonConfig {
  const group = config.groups[groupName];
  if (!group) return config;
  const dependencies = new Set(group.dependencies);
  if (enabled) dependencies.add(dependency);
  else dependencies.delete(dependency);
  return {
    ...config,
    groups: {
      ...config.groups,
      [groupName]: { ...group, dependencies: Array.from(dependencies) }
    }
  };
}

export function formatTestSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function distributeTotalScore(
  config: PolygonConfig,
  totalScoreInput: string | number | null | undefined,
  testNames: readonly string[]
): PolygonConfig {
  if (testNames.length === 0) return config;
  if (totalScoreInput === null || totalScoreInput === undefined || String(totalScoreInput).trim() === "") {
    return config;
  }
  const totalRational = parseRational(totalScoreInput);
  if (BigInt(totalRational.n) <= 0n) return config;

  const currentPoints = testNames.map((name) =>
    parseRational(config.tests[name]?.points ?? 1)
  );
  const currentSum = currentPoints.reduce(
    (acc, p) => addRational(acc, p),
    createRational(0)
  );

  const allEqual = currentPoints.every(
    (p) => p.n === currentPoints[0].n && p.d === currentPoints[0].d
  );

  const nextTests = { ...config.tests };
  const countRat = createRational(testNames.length);

  for (let i = 0; i < testNames.length; i++) {
    const testName = testNames[i];
    let newPt: Rational;
    if (allEqual || currentSum.n === 0) {
      newPt = divideRational(totalRational, countRat);
    } else {
      const ratio = divideRational(currentPoints[i], currentSum);
      newPt = multiplyRational(totalRational, ratio);
    }
    nextTests[testName] = {
      ...(nextTests[testName] ?? {}),
      points: toCanonicalPointValue(newPt),
    };
  }

  return {
    ...config,
    tests: nextTests,
  };
}
