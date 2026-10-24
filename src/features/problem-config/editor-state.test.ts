import assert from "node:assert/strict";
import test from "node:test";
import { PolygonConfig } from "../../types";
import {
  applyTestEdit,
  assignTestsToGroup,
  createsGroupCycle,
  distributeTotalScore,
  editGroupTests,
  normalizePointInputText,
  parseNonNegativePointInput,
  parsePositivePointInput,
  setGroupDependency,
} from "./editor-state";

const baseConfig = (): PolygonConfig => ({
  enableGroups: true,
  tests: { "01": { points: 1 }, "02": { points: 1 } },
  groups: {}
});

test("batch point edits update only selected tests without mutating input", () => {
  const original = baseConfig();
  const result = applyTestEdit(
    original,
    { type: "batchPoints", x: 0, y: 0 },
    "2.5",
    new Set(["01"])
  );
  assert.equal(result.tests["01"].points, 2.5);
  assert.equal(result.tests["02"].points, 1);
  assert.equal(original.tests["01"].points, 1);
});

test("supports fraction points in test edits", () => {
  const original = baseConfig();
  const result = applyTestEdit(
    original,
    { type: "points", testName: "01", x: 0, y: 0 },
    "1/3",
    new Set()
  );
  assert.equal(result.tests["01"].points, "1/3");

  const batchResult = applyTestEdit(
    original,
    { type: "batchPoints", x: 0, y: 0 },
    "5/3",
    new Set(["01", "02"])
  );
  assert.equal(batchResult.tests["01"].points, "5/3");
  assert.equal(batchResult.tests["02"].points, "5/3");
});

test("score edits retain decimal forms without integer or fractional part", () => {
  for (const [input, expected] of [[".5", 0.5], ["1.", 1]] as const) {
    const result = applyTestEdit(baseConfig(), { type: "points", testName: "01", x: 0, y: 0 }, input, new Set());
    assert.equal(result.tests["01"].points, expected);
  }
});

test("point helpers normalize comma decimals and reject invalid score inputs", () => {
  assert.equal(normalizePointInputText("2,5"), "2.5");
  assert.equal(normalizePointInputText("2,5/5"), "2.5/5");
  assert.deepEqual(parseNonNegativePointInput("2,5"), { n: 5, d: 2 });
  assert.deepEqual(parseNonNegativePointInput("2,5/5"), { n: 1, d: 2 });
  assert.deepEqual(parseNonNegativePointInput("0"), { n: 0, d: 1 });
  assert.deepEqual(parsePositivePointInput("2,5"), { n: 5, d: 2 });
  assert.throws(() => parsePositivePointInput("0"), /greater than zero/i);
  assert.throws(() => parsePositivePointInput("-2,5"), /non-negative/i);
  assert.throws(() => parseNonNegativePointInput("abc"), /non-negative/i);
  assert.throws(() => parseNonNegativePointInput("2,,5"), /non-negative/i);

  const edited = applyTestEdit(baseConfig(), { type: "points", testName: "01", x: 0, y: 0 }, "2,5", new Set());
  assert.equal(edited.tests["01"].points, 2.5);
  assert.throws(() => applyTestEdit(baseConfig(), { type: "points", testName: "01", x: 0, y: 0 }, "invalid", new Set()));

  const distributed = distributeTotalScore(baseConfig(), "2,5", ["01", "02"]);
  assert.equal(distributed.tests["01"].points, 1.25);
  assert.equal(distributed.tests["02"].points, 1.25);
});

test("group edits create a default group and can remove the assignment", () => {
  const assigned = applyTestEdit(
    baseConfig(),
    { type: "group", testName: "01", x: 0, y: 0 },
    "subtask-1",
    new Set()
  );
  assert.equal(assigned.tests["01"].group, "subtask-1");
  assert.deepEqual(assigned.groups["subtask-1"], { policy: "EACH_TEST", dependencies: [] });

  const removed = applyTestEdit(
    assigned,
    { type: "group", testName: "01", x: 0, y: 0 },
    "",
    new Set()
  );
  assert.equal(removed.tests["01"].group, undefined);
});

test("dependency helpers reject indirect cycles and preserve other groups", () => {
  const config = baseConfig();
  config.groups = {
    A: { policy: "EACH_TEST", dependencies: ["B"] },
    B: { policy: "EACH_TEST", dependencies: ["C"] },
    C: { policy: "EACH_TEST", dependencies: [] }
  };
  assert.equal(createsGroupCycle(config.groups, "C", "A"), true);
  const updated = setGroupDependency(config, "C", "B", true);
  assert.deepEqual(updated.groups.C.dependencies, ["B"]);
  assert.deepEqual(updated.groups.A.dependencies, ["B"]);
});

test("distributeTotalScore evenly divides total score when tests have equal points", () => {
  const config = baseConfig(); // 2 tests with 1 pt each
  const result = distributeTotalScore(config, 4, ["01", "02"]);
  assert.equal(result.tests["01"].points, 2);
  assert.equal(result.tests["02"].points, 2);
});

test("distributeTotalScore proportionally scales when tests have different weights", () => {
  const config: PolygonConfig = {
    enableGroups: false,
    tests: { "01": { points: 1 }, "02": { points: 3 } },
    groups: {},
  };
  const result = distributeTotalScore(config, "100", ["01", "02"]);
  assert.equal(result.tests["01"].points, 25);
  assert.equal(result.tests["02"].points, 75);
});

test("distributeTotalScore supports fractional division", () => {
  const config: PolygonConfig = {
    enableGroups: false,
    tests: { "01": { points: 1 }, "02": { points: 1 }, "03": { points: 1 } },
    groups: {},
  };
  const result = distributeTotalScore(config, "10", ["01", "02", "03"]);
  assert.equal(result.tests["01"].points, "10/3");
  assert.equal(result.tests["02"].points, "10/3");
  assert.equal(result.tests["03"].points, "10/3");
});

test("bulk membership is additive, reassigns safely and leaves points and limits unchanged", () => {
  const config = baseConfig();
  config.tests["01"] = { points: "1/3", group: "old", timeLimit: 2 };
  config.groups.old = { policy: "COMPLETE_GROUP", dependencies: [] };
  const result = assignTestsToGroup(config, ["01"], "constructor");
  assert.deepEqual(result.tests["01"], { points: "1/3", group: "constructor", timeLimit: 2 });
  assert.deepEqual(result.groups.constructor, { policy: "EACH_TEST", dependencies: [] });
  assert.equal(config.tests["01"].group, "old");
  const removed = assignTestsToGroup(result, ["01", "02"], " ");
  assert.equal(removed.tests["01"].group, undefined);
  assert.equal(removed.tests["01"].points, "1/3");
  assert.equal(removed.tests["02"].group, undefined);
  assert.ok(Object.hasOwn(removed.groups, "old"));
});

test("group edit replaces membership and preserves nonuniform points unless a score is entered", () => {
  const original = assignTestsToGroup(baseConfig(), ["01"], "A");
  original.tests["02"].points = 3;
  const result = editGroupTests(original, "A", ["02"]);
  assert.equal(result.tests["01"].group, undefined);
  assert.equal(result.tests["01"].points, 1);
  assert.equal(result.tests["02"].group, "A");
  assert.equal(result.tests["02"].points, 3);
  const divided = editGroupTests(result, "A", ["01", "02"], "1/3");
  assert.equal(divided.tests["01"].points, "1/6");
  assert.equal(divided.tests["02"].points, "1/6");
  assert.throws(() => editGroupTests(result, "A", ["02"], "1/0"));
  assert.throws(() => editGroupTests(result, "A", ["02"], "-1"));
  assert.equal(editGroupTests(result, "A", ["02"], "0").tests["02"].points, 0);
  assert.equal(editGroupTests(result, "A", []).tests["02"].group, undefined);
});

