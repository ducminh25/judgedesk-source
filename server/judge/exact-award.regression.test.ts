import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { executorClient } from "../executor/client.js";
import { createCompileConfig } from "../../shared/compile-config.js";
import { checkerResultFromExit } from "./custom-checker-runner.js";
import { parseRational } from "../../shared/rational.js";
import { resolveInteractiveAward, runTestCase } from "./testcase-runner.js";

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

test("interactive testcase runner disposes first workspace if interactor workspace creation fails", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jd_test_interactive_ws_cleanup_"));
  const workspacesRoot = path.join(root, "workspaces");
  fs.mkdirSync(workspacesRoot, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const origStart = executorClient.start.bind(executorClient);
  let startCount = 0;
  executorClient.start = async () => {
    startCount += 1;
    if (startCount === 2) {
      return {
        ready: false,
        mode: "unavailable",
        executorVersion: "1.5.5",
        executorRoot: root,
        diagnostics: ["SIMULATED_SECOND_WORKSPACE_FAILURE"],
        networkBlocked: false,
        filesystemIsolated: false,
        processTreeControlled: false,
        memoryLimitSupported: false,
      };
    }
    return {
      ready: true,
      mode: "macos-seatbelt-native",
      executorVersion: "1.5.5",
      executorRoot: root,
      diagnostics: [],
      networkBlocked: true,
      filesystemIsolated: true,
      processTreeControlled: true,
      memoryLimitSupported: true,
    };
  };
  t.after(() => {
    executorClient.start = origStart;
  });

  const result = await runTestCase({
    contestant: "student",
    problemName: "PAIR",
    testName: "1",
    language: "cpp",
    submissionPath: path.join(root, "Main.cpp"),
    executablePath: path.join(root, "Main"),
    inputPath: path.join(root, "input.txt"),
    expectedOutputPath: path.join(root, "answer.txt"),
    expectedOutputPreview: "",
    testRoot: root,
    contestantsRoot: root,
    tempDirectory: root,
    pythonCommand: "",
    timeLimitMs: 1000,
    score: 1,
    config: {
      useStdIO: true,
      useStdIn: true,
      useStdOut: true,
      inputFile: "PAIR.inp",
      outputFile: "PAIR.out",
      totalScore: 1,
      defaultScore: 1,
      testScores: {},
      memoryLimit: 256,
      checkerType: "C1",
      isInteractive: true,
      compile: createCompileConfig(),
      polygonConfig: { enableGroups: false, tests: {}, groups: {} },
    },
    checker: undefined,
    interactor: { path: path.join(root, "interactor"), runtime: "native" },
  });

  assert.equal(result.status, "JE");
  assert.match(result.errorDetail, /SIMULATED_SECOND_WORKSPACE_FAILURE/);
  assert.deepEqual(fs.readdirSync(workspacesRoot), []);
});

