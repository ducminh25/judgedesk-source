import assert from "node:assert/strict";
import test from "node:test";
import { runStandardChecker } from "./standard-checkers.js";

test("C1 ignores case and horizontal whitespace but preserves lines", () => {
  assert.equal(runStandardChecker("C1", "Hello   WORLD\n42\n", "hello world\n42").status, "AC");
  assert.equal(runStandardChecker("C1", "hello\nworld", "hello world").status, "WA");
});

test("C2 preserves case while normalizing horizontal whitespace", () => {
  assert.equal(runStandardChecker("C2", "Hello   world\n", "Hello world").status, "AC");
  assert.equal(runStandardChecker("C2", "Hello world", "hello world").status, "WA");
});

test("C3 ignores whitespace, line boundaries and case", () => {
  assert.equal(runStandardChecker("C3", "Hello\nWORLD 42", "hello world\n42").status, "AC");
  assert.equal(runStandardChecker("C3", "one two", "one three").message, "Wrong answer at word 2");
});

test("C4 ignores whitespace and line boundaries but preserves case", () => {
  assert.equal(runStandardChecker("C4", "Hello\nworld", "Hello world").status, "AC");
  assert.equal(runStandardChecker("C4", "Hello", "hello").status, "WA");
});

test("C5 requires byte-for-byte identical text", () => {
  assert.equal(runStandardChecker("C5", "answer\n", "answer\n").status, "AC");
  assert.equal(runStandardChecker("C5", "answer\n", "answer").status, "WA");
});
