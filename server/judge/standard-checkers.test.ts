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

test("C5 compares raw bytes without UTF-8 normalization", () => {
  assert.equal(
    runStandardChecker("C5", Buffer.from([0, 255, 10]), Buffer.from([0, 255, 10])).status,
    "AC",
  );
  assert.equal(
    runStandardChecker("C5", Buffer.from([0, 255, 10]), Buffer.from([0, 254, 10])).message,
    "Wrong answer at byte 2",
  );
});

test("Polygon line checkers preserve their whitespace semantics", () => {
  assert.equal(runStandardChecker("polygon:fcmp", "a  b\n", "a b\n").status, "WA");
  assert.equal(runStandardChecker("polygon:lcmp", "a  b\n", " a b \n").status, "AC");
  assert.equal(runStandardChecker("polygon:fcmp", "answer\n", "answer\nextra\n").status, "AC");
  assert.equal(runStandardChecker("polygon:fcmp", "answer\n\n", "answer\n").status, "AC");
  assert.equal(runStandardChecker("polygon:fcmp", "answer\n\n\n", "answer\n").status, "WA");
});

test("Polygon integer checkers validate canonical huge integers and int64 ranges", () => {
  assert.equal(runStandardChecker("polygon:hcmp", "-123", "-123 trailing").status, "AC");
  assert.equal(runStandardChecker("polygon:hcmp", "1", "+1").status, "PE");
  assert.equal(runStandardChecker("polygon:hcmp", "01", "1").status, "FAIL");
  assert.equal(
    runStandardChecker("polygon:ncmp", "-9223372036854775808 2", "-9223372036854775808 2").status,
    "AC",
  );
  assert.equal(runStandardChecker("polygon:ncmp", "9223372036854775808", "0").status, "FAIL");
  assert.equal(runStandardChecker("polygon:ncmp", "1", "1 2").status, "WA");
  assert.equal(runStandardChecker("polygon:ncmp", "1 invalid", "1").status, "FAIL");
  assert.equal(runStandardChecker("polygon:ncmp", "1", "1 invalid").status, "PE");
});

test("Polygon yes/no checkers are case-insensitive and preserve verdict classes", () => {
  assert.equal(runStandardChecker("polygon:yesno", "YES", "yes").status, "AC");
  assert.equal(runStandardChecker("polygon:yesno", "YES", "maybe").status, "PE");
  assert.equal(runStandardChecker("polygon:nyesno", "YES no", "yes NO").status, "AC");
  assert.equal(runStandardChecker("polygon:nyesno", "YES", "NO").status, "WA");
});

test("Polygon real checkers use absolute or relative epsilon", () => {
  assert.equal(runStandardChecker("polygon:rcmp4", "10000", "10001").status, "AC");
  assert.equal(runStandardChecker("polygon:rcmp6", "1", "1.00001").status, "WA");
  assert.equal(runStandardChecker("polygon:rcmp9", "nan", "NaN").status, "AC");
  assert.equal(runStandardChecker("polygon:rcmp9", "inf", "inf").status, "AC");
});

test("Polygon token checker compares an exact ordered token sequence", () => {
  assert.equal(runStandardChecker("polygon:wcmp", "a\nb c", "a b\n c").status, "AC");
  assert.equal(runStandardChecker("polygon:wcmp", "a b", "a b c").message, "Participant output contains extra tokens");
});
