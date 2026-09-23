import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { checkerResultFromExit, parsePartialScore } from "./custom-checker-runner.js";

test("partial checker scores accept multipliers and absolute points", () => {
  assert.equal(parsePartialScore("result = 0.25", "", 10), 0.25);
  assert.equal(parsePartialScore("points 2.5", "", 10), 0.25);
  assert.equal(parsePartialScore("", "details\n0.75\n", 10), 0.75);
});

test("partial checker scores reject missing and negative values", () => {
  assert.equal(parsePartialScore("no score", "", 10), null);
  assert.equal(parsePartialScore("result = -1", "", 10), null);
});

test("Themis checker output format parses float verdicts under exit code 0", () => {
  const ac = checkerResultFromExit(0, "OK", "OK\n1.00\n", 10);
  assert.equal(ac.status, "AC");
  assert.equal(ac.score, 10);
  assert.equal(ac.message, "OK");

  const wa = checkerResultFromExit(0, "", "WA: tong tien khong bang S\n0.00\n", 10);
  assert.equal(wa.status, "WA");
  assert.equal(wa.score, 0);
  assert.equal(wa.message, "WA: tong tien khong bang S");

  const partial = checkerResultFromExit(0, "", "Partially optimal\n0.60\n", 10);
  assert.equal(partial.status, "PARTIAL");
  assert.equal(partial.score, 6);
  assert.equal(partial.message, "Partially optimal");
});

test("Testlib checker exit codes and messages are preserved", () => {
  const ac = checkerResultFromExit(0, "ok CHECKER_SMOKE_OK", "", 10);
  assert.equal(ac.status, "AC");
  assert.equal(ac.score, 10);

  const wa = checkerResultFromExit(1, "wrong answer expected 42", "", 10);
  assert.equal(wa.status, "WA");
  assert.equal(wa.score, 0);

  const pe = checkerResultFromExit(2, "presentation error", "", 10);
  assert.equal(pe.status, "PE");
  assert.equal(pe.score, 0);

  const partial = checkerResultFromExit(7, "points 5.0", "", 10);
  assert.equal(partial.status, "PARTIAL");
  assert.equal(partial.score, 5);
});

test("custom checker execution has no host child-process escape hatch", () => {
  const runner = fs.readFileSync(
    path.join(process.cwd(), "server/judge/custom-checker-runner.ts"),
    "utf8",
  );
  const pythonChecker = fs.readFileSync(
    path.join(process.cwd(), "server/judge/python-checker.ts"),
    "utf8",
  );
  for (const source of [runner, pythonChecker]) {
    assert.doesNotMatch(source, /from ["'](?:node:)?child_process["']/);
    assert.doesNotMatch(source, /\bspawn(?:Sync)?\s*\(|execFileSync|taskkill/);
    assert.match(source, /runReservedExecutor/);
  }
});
