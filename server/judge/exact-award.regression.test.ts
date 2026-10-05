import assert from "node:assert/strict";
import { test } from "node:test";
import { checkerResultFromExit } from "./custom-checker-runner.js";
import { parseRational } from "../../shared/rational.js";
import { resolveInteractiveAward } from "./testcase-runner.js";

test("partial checker awards preserve exact proportional points", () => {
  const maxScoreExact = parseRational("9007199254740991/3");
  const result = checkerResultFromExit(7, "points 0.5", "", Number.MAX_SAFE_INTEGER / 3, maxScoreExact);
  assert.deepEqual(result.scoreExact, { n: Number.MAX_SAFE_INTEGER, d: 6 });
  assert.equal(result.status, "PARTIAL");
});

test("full checker awards preserve exact proportional points", () => {
  const maxScoreExact = parseRational("9007199254740991/3");
  const result = checkerResultFromExit(0, "ok", "", Number.MAX_SAFE_INTEGER / 3, maxScoreExact);
  assert.deepEqual(result.scoreExact, maxScoreExact);
});

test("zero-point tests retain checker verdicts independently of awarded zero", () => {
  for (const exitCode of [0, 7]) {
    const message = exitCode === 7 ? "points 0" : "";
    assert.equal(checkerResultFromExit(exitCode, message, "0", 0, parseRational(0)).status, "WA");
    assert.equal(checkerResultFromExit(exitCode, exitCode === 7 ? "points 0.5" : "", "0.5", 0, parseRational(0)).status, "PARTIAL");
  }
});

test("executor interactive score takes precedence over conflicting text", () => {
  assert.deepEqual(resolveInteractiveAward(parseRational("1/3"), 0.5, "score: 0.25", ""), { n: 1, d: 6 });
  assert.deepEqual(resolveInteractiveAward(parseRational("1/3"), undefined, "score: 0.25", ""), { n: 1, d: 12 });
});

test("final partial display rounding does not overflow an otherwise finite score", () => {
  const maximum = parseRational("1e307");
  const result = checkerResultFromExit(7, "points 0.5", "", 1e307, maximum);
  assert.ok(Number.isFinite(result.score));
  assert.deepEqual(result.scoreExact, parseRational("5e306"));
});
