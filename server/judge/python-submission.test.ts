import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { clearToolchainDetectionCache, findSystemPython } from "../toolchains/resolver.js";
import { normalizeProblemConfig } from "../../shared/problem-config.js";
import { compileSubmission } from "./compiler.js";
import { buildMacSandboxProfile, runTestCase } from "./testcase-runner.js";

test("macOS sandbox grants runtime reads but only temp writes", () => {
  const runtimeRoot = path.resolve("python-runtime");
  const writableRoot = path.resolve("themis-run");
  const escapedRuntimeRoot = runtimeRoot.replaceAll("\\", "\\\\");
  const escapedWritableRoot = writableRoot.replaceAll("\\", "\\\\");
  const profile = buildMacSandboxProfile({
    readPaths: [runtimeRoot],
    writePaths: [writableRoot],
  });
  assert.ok(profile.includes(`file-read* (subpath "${escapedRuntimeRoot}")`));
  assert.ok(profile.includes(`file-write* (subpath "${escapedWritableRoot}")`));
  assert.ok(!profile.includes(`file-write* (subpath "${escapedRuntimeRoot}")`));
  assert.match(profile, /\(deny network\*\)/);
  assert.ok(profile.includes("(allow file-read*)"));
  assert.ok(profile.includes('(allow file-read* (literal "/"))'));
  assert.ok(profile.includes("(allow file-read-metadata (vnode-type DIRECTORY))"));
});

test("a Python submission is accepted and runnable without resolving C++", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "themis-python-submission-"));
  const appData = path.join(root, "app-data");
  const source = path.join(root, "sum.py");
  fs.writeFileSync(source, "a, b = map(int, input().split())\nprint(a + b)\n", "utf8");
  t.after(() => {
    delete process.env.THEMIS_APP_DATA_DIR;
    clearToolchainDetectionCache();
    fs.rmSync(root, { recursive: true, force: true });
  });
  process.env.THEMIS_APP_DATA_DIR = appData;
  clearToolchainDetectionCache();

  const detectedPython = findSystemPython();
  if (!detectedPython) {
    t.skip("No supported Python runtime is installed on this test host.");
    return;
  }

  const compiled = await compileSubmission({
    language: "python",
    contestantName: "Alice",
    problemName: "SUM",
    submissionPath: source,
    tempDirectory: root,
  });
  assert.equal(compiled.compileStatus, "OK");
  assert.equal(compiled.executablePath, detectedPython);

  const run = spawnSync(compiled.executablePath, [source], {
    input: "20 22\n",
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), "42");

  const inputPath = path.join(root, "SUM.inp");
  const expectedOutputPath = path.join(root, "SUM.out");
  const runDirectory = path.join(root, "run");
  fs.mkdirSync(runDirectory);
  fs.writeFileSync(inputPath, "20 22\n", "utf8");
  fs.writeFileSync(expectedOutputPath, "42\n", "utf8");
  const judged = await runTestCase({
    contestant: "Alice",
    problemName: "SUM",
    testName: "1",
    language: "python",
    submissionPath: source,
    executablePath: compiled.executablePath,
    inputPath,
    expectedOutputPath,
    expectedOutput: "42\n",
    testRoot: root,
    contestantsRoot: root,
    tempDirectory: runDirectory,
    pythonCommand: compiled.executablePath,
    timeLimitMs: 1_000,
    score: 1,
    config: normalizeProblemConfig("SUM", {
      useStdIn: true,
      useStdOut: true,
      memoryLimit: 256,
      checkerType: "C1",
    }),
    checker: { path: null },
  });
  assert.equal(judged.status, "AC", JSON.stringify(judged, null, 2));
  assert.equal(judged.score, 1);
  assert.ok(judged.executionTime < 1_000);
});
