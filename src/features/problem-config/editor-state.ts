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
    const test = Object.hasOwn(next.tests, testName) ? next.tests[testName] : { points: 1 };
    next.tests[testName] = test;

    if (edit.type === "points" || edit.type === "batchPoints") {
      if (!input || !input.trim()) {
        test.points = 1;
      } else {
        const r = parseNonNegativePointInput(input);
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
      if (!Object.hasOwn(next.groups, groupName)) {
        next.groups = { ...next.groups, [groupName]: { policy: "EACH_TEST", dependencies: [] } };
      }
    }
  }

  return next;
}

export function assignTestsToGroup(
  config: PolygonConfig,
  testNames: readonly string[],
  rawGroupName: string,
): PolygonConfig {
  const groupName = rawGroupName.trim();
  const tests = { ...config.tests };
  for (const name of testNames) {
    const previous = Object.hasOwn(tests, name) ? tests[name] : { points: 1 };
    const next = { ...previous };
    if (groupName) next.group = groupName;
    else delete next.group;
    Object.defineProperty(tests, name, { value: next, writable: true, enumerable: true, configurable: true });
  }
  return {
    ...config,
    tests,
    groups: groupName && !Object.hasOwn(config.groups, groupName)
      ? { ...config.groups, [groupName]: { policy: "EACH_TEST", dependencies: [] } }
      : config.groups,
  };
}

/** A group's Edit list is its full membership; existing per-test scores survive list-only edits. */
export function editGroupTests(
  config: PolygonConfig,
  groupName: string,
  testNames: readonly string[],
  totalPoints?: string,
): PolygonConfig {
  if (!Object.hasOwn(config.groups, groupName)) throw new Error("Group does not exist");
  const selected = new Set(testNames);
  const tests = { ...config.tests };
  for (const [name, current] of Object.entries(config.tests)) {
    if (current.group === groupName && !selected.has(name)) {
      Object.defineProperty(tests, name, { value: { ...current, group: undefined }, writable: true, enumerable: true, configurable: true });
    }
  }
  const reassigned = assignTestsToGroup({ ...config, tests }, testNames, groupName);
  if (totalPoints === undefined) return reassigned;
  const total = parseNonNegativePointInput(totalPoints);
  if (testNames.length === 0 && BigInt(total.n) !== 0n) throw new Error("An empty group cannot have points");
  const each = testNames.length ? toCanonicalPointValue(divideRational(total, createRational(testNames.length))) : 0;
  const withPoints = { ...reassigned.tests };
  for (const name of testNames) {
    Object.defineProperty(withPoints, name, { value: { ...withPoints[name], points: each }, writable: true, enumerable: true, configurable: true });
  }
  return { ...reassigned, tests: withPoints };
}

export function normalizePointInputText(input: string): string {
  return input.replace(/,/g, ".");
}

/** parseRational intentionally returns zero on invalid text; editor inputs must be strict. */
export function parseNonNegativePointInput(input: string): Rational {
  const text = normalizePointInputText(input).trim();
  const decimal = "(?:\\d+(?:\\.\\d*)?|\\.\\d+)";
  if (text.length > 1024 || !new RegExp(`^(?:${decimal}|${decimal}/${decimal})$`).test(text)) {
    throw new Error("Enter a non-negative number or fraction");
  }
  const [, denominator] = text.split("/");
  if (denominator !== undefined && BigInt(parseRational(denominator).n) === 0n) {
    throw new Error("The denominator must be greater than zero");
  }
  const value = parseRational(text);
  if (BigInt(value.n) < 0n) throw new Error("Points cannot be negative");
  return value;
}

export function parsePositivePointInput(input: string): Rational {
  const value = parseNonNegativePointInput(input);
  if (BigInt(value.n) <= 0n) {
    throw new Error("Enter a positive number or fraction greater than zero");
  }
  return value;
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
