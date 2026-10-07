import assert from "node:assert/strict";
import test from "node:test";
import { formatTestSelection, parseTestSelection } from "./test-selection.js";

test("selection accepts whitespace, descending ranges and overlaps as a set", () => {
  assert.deepEqual(parseTestSelection("1-8, 10,12 - 19, 31- 28,90-100, 7-3", 100),
    [...Array.from({ length: 8 }, (_, i) => i + 1), 10, ...Array.from({ length: 8 }, (_, i) => i + 12), 28, 29, 30, 31, ...Array.from({ length: 11 }, (_, i) => i + 90)]);
  assert.equal(formatTestSelection(parseTestSelection("3,1,2,6,9-8,8", 10)), "1-3, 6, 8-9");
});

test("selection rejects invalid or out-of-range text before applying any part", () => {
  for (const input of ["0", "1,11", "1-999999999999999999", "1,,2", "1 2", "1-2-3", "1.5", "-1", "abc"]) {
    assert.throws(() => parseTestSelection(input, 10));
  }
  assert.deepEqual(parseTestSelection("", 10), []);
});
