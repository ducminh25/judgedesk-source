import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
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
