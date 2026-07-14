import assert from "node:assert/strict";
import test from "node:test";
import { PolygonConfig } from "../../types";
import { applyTestEdit, createsGroupCycle, setGroupDependency } from "./editor-state";

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
