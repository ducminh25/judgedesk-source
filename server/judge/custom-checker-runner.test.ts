import assert from "node:assert/strict";
import test from "node:test";
import { parsePartialScore } from "./custom-checker-runner";

test("partial checker scores accept multipliers and absolute points", () => {
  assert.equal(parsePartialScore("result = 0.25", "", 10), 0.25);
  assert.equal(parsePartialScore("points 2.5", "", 10), 0.25);
  assert.equal(parsePartialScore("", "details\n0.75\n", 10), 0.75);
});

test("partial checker scores reject missing and negative values", () => {
  assert.equal(parsePartialScore("no score", "", 10), null);
  assert.equal(parsePartialScore("result = -1", "", 10), null);
});
