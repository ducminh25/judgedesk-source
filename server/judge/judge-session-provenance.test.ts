import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executorClient } from "../executor/client.js";
import { activeJobs } from "../jobs.js";
import type { ProblemResult } from "../types.js";
import { resetJudgePrewarmStateForTests, startBackgroundJudgePrewarm } from "./background-prewarm.js";
import type { JudgeEventWriter } from "./judge-event-writer.js";
import { runJudgeSession } from "./judge-session.js";
import type { PinnedJudgeToolchains } from "./toolchain-preflight.js";

import { ensureCertifiedLocalCppSessionProbe } from "./certified-local-session-probe.js";
import { runTestCase } from "./testcase-runner.js";
import { normalizeProblemConfig } from "../../shared/problem-config.js";

for (const scenario of ["setup", "cancel", "unreadable-test"] as const) {
  const cancelDuringCompile = scenario === "cancel";
  test(`session provenance: ${scenario}`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-session-provenance-"));
    const contestantsDirectory = path.join(root, "contestants");
    const testDirectory = path.join(root, "tests");
    const tempDirectory = path.join(root, "work");
    const jobId = `provenance-${scenario}`;
    resetJudgePrewarmStateForTests();
    t.after(() => { activeJobs.delete(jobId); resetJudgePrewarmStateForTests(); fs.rmSync(root, { recursive: true, force: true }); });
    fs.mkdirSync(path.join(contestantsDirectory, "Audit"), { recursive: true });
    fs.mkdirSync(path.join(testDirectory, "SUM", "01"), { recursive: true });
    fs.mkdirSync(tempDirectory);
    fs.writeFileSync(path.join(contestantsDirectory, "Audit", "SUM.cpp"), "int main(){}\n");
    fs.writeFileSync(path.join(testDirectory, "SUM", "01", "SUM.inp"), scenario === "unreadable-test" ? Buffer.from([0, 1, 2]) : "1 2\n");
    fs.writeFileSync(path.join(testDirectory, "SUM", "01", "SUM.out"), "3\n");
    activeJobs.set(jobId, { cancel: false, runIds: new Set(), startedRunIds: new Set() });
    let armed = false;
    let attempts = 0;
    t.mock.method(executorClient, "start", async () => {
      ++attempts;
      if (armed && cancelDuringCompile) activeJobs.get(jobId)!.cancel = true;
      return { ...executorClient.health, ready: false, diagnostics: ["fixture: isolation setup failed"] };
    });
    // Seed only the existing optional-prewarm cache; the real submission path
    // still crosses compiler -> session -> scoring -> event serialization.
    await startBackgroundJudgePrewarm(false, {
      waitForToolchainDiscovery: async () => ({ schemaVersion: 2, registryRevision: 1, status: "complete", completedAt: "2026-10-12T00:00:00.000Z", refreshing: false, profiles: {} }),
    }, ["cpp"]);
    armed = true;
    const pins: PinnedJudgeToolchains = {
      cpp: { kind: "cpp", source: "managed", ready: true, executablePath: path.join(root, "missing-cpp"), version: "fixture" },
      c: { kind: "c", source: "none", ready: false, executablePath: "", version: "" },
      python: { kind: "python", source: "none", ready: false, executablePath: "", version: "" },
      pascal: { kind: "pascal", source: "none", ready: false, executablePath: "", version: "" },
      go: { kind: "go", source: "none", ready: false, executablePath: "", version: "" },
      java: { kind: "java", source: "none", ready: false, executablePath: "", version: "" },
      rust: { kind: "rust", source: "none", ready: false, executablePath: "", version: "" },
      javascript: { kind: "javascript", source: "none", ready: false, executablePath: "", version: "" },
      csharp: { kind: "csharp", source: "none", ready: false, executablePath: "", version: "" },
      scratch: { kind: "scratch", source: "none", ready: false, executablePath: "", version: "" },
    };
    const results: ProblemResult[] = [];
    const events: JudgeEventWriter = { send(type, data) {
      if (type === "problem_completed" && "problemResult" in data) results.push(JSON.parse(JSON.stringify(data.problemResult)) as ProblemResult);
    }, end() {} };
    await runJudgeSession({ request: { thisinhPath: contestantsDirectory, testPath: testDirectory, jobId,
      problemConfigs: {}, targetContestants: ["Audit"], targetProblems: ["SUM"] },
      contestantsDirectory, testDirectory, tempDirectory, events, pinnedToolchains: pins });
    assert.equal(attempts, scenario === "unreadable-test" ? 1 : 2, "invalid test plans must not compile student submissions");
    if (cancelDuringCompile) {
      assert.deepEqual(results, []);
    } else {
      assert.equal(results.length, 1);
      assert.equal(results[0].compileStatus, "JE");
      assert.equal(results[0].summary.status, "JE");
      assert.equal(results[0].summary.score, 0);
      assert.deepEqual(results[0].testCases, []);
      assert.match(results[0].compileError || "", scenario === "unreadable-test" ? /Unreadable input file: SUM.inp/ : /isolation setup failed/);
    }
  });
}

test("certified-local C++ session probe reserves and detaches its sandbox run on an active job", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-cert-probe-job-"));
  const executorRoot = path.join(root, "executor");
  const toolchainRoot = path.join(executorRoot, "toolchains", "cert-cpp");
  const compilerPath = path.join(toolchainRoot, "bin", "g++.exe");
  const tempDirectory = path.join(root, "work");
  const jobId = "active-cert-probe-job";
  t.after(() => {
    activeJobs.delete(jobId);
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const file of [
    compilerPath,
    path.join(toolchainRoot, "libexec", "cc1plus.exe"),
    path.join(toolchainRoot, "lib", "libstdc++.a"),
    path.join(toolchainRoot, "include", "c++", "13", "iostream"),
    path.join(toolchainRoot, "lib", "gcc", "x86_64", "13", "include", "stddef.h"),
    path.join(toolchainRoot, "include", "windows.h"),
  ]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "stub");
  }
  fs.mkdirSync(path.join(executorRoot, "workspaces"), { recursive: true });
  fs.mkdirSync(path.join(executorRoot, "artifacts"), { recursive: true });
  fs.mkdirSync(tempDirectory, { recursive: true });
  const jobState = { cancel: false, runIds: new Set<string>(), startedRunIds: new Set<string>() };
  activeJobs.set(jobId, jobState);
  t.mock.method(executorClient, "start", async () => ({
    ...executorClient.health,
    ready: true,
    executorRoot,
  }));
  const observedSubmissionRuns: string[] = [];
  t.mock.method(executorClient, "run", async (spec, onReadyToSend) => {
    onReadyToSend?.();
    const wsPath = path.join(executorRoot, "workspaces", spec.workspaceId);
    if (spec.role === "compiler") {
      fs.writeFileSync(path.join(wsPath, "compiled-output.bin"), "binary");
    } else {
      observedSubmissionRuns.push(spec.runId);
      assert.equal(jobState.startedRunIds.has(spec.runId), true, "sandbox probe run must be tracked as started");
      fs.writeFileSync(path.join(wsPath, spec.stdoutFile), "JUDGEDESK_SESSION_PROBE_OK\n");
    }
    return {
      runId: spec.runId,
      reason: "exited" as const,
      exitCode: 0,
      wallTimeUs: 1_000,
      userCpuTimeUs: 0,
      kernelCpuTimeUs: 0,
      peakMemoryBytes: 1_024,
      securitySetupTimeUs: 0,
      resultCollectionTimeUs: 0,
      stdoutBytes: 27,
      stderrBytes: 0,
    };
  });

  await ensureCertifiedLocalCppSessionProbe(
    {
      kind: "cpp",
      source: "custom",
      ready: true,
      provenance: "certified-local",
      certificateId: "cert-active-job",
      snapshotDigest: "digest-active-job",
      executablePath: compilerPath,
      executionPath: compilerPath,
      executionId: "toolchains/cert-cpp/bin/g++.exe",
      certifiedRoles: ["submission", "checker"],
      version: "13.2.0",
    },
    tempDirectory,
    jobId,
  );
  assert.equal(observedSubmissionRuns.length, 1);
  assert.equal(jobState.runIds.size, 0, "probe run must be detached after completion");
  assert.equal(jobState.startedRunIds.size, 0);
});

test("judge session stops without scanning or interactor compilation when cancelled during prewarm or checker resolution", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-session-cancel-checkpoints-"));
  const contestantsDirectory = path.join(root, "contestants");
  const testDirectory = path.join(root, "tests");
  const tempDirectory = path.join(root, "work");
  const pythonExe = path.join(root, "python.exe");
  fs.writeFileSync(pythonExe, "stub");
  fs.mkdirSync(path.join(contestantsDirectory, "Audit"), { recursive: true });
  fs.mkdirSync(path.join(testDirectory, "GUESS", "01"), { recursive: true });
  fs.mkdirSync(tempDirectory, { recursive: true });
  fs.writeFileSync(path.join(contestantsDirectory, "Audit", "GUESS.py"), "print(1)\n");
  fs.writeFileSync(path.join(testDirectory, "GUESS", "checker.py"), "import sys\nsys.exit(0)\n");
  fs.writeFileSync(path.join(testDirectory, "GUESS", "interactor.py"), "import sys\nsys.exit(0)\n");
  fs.writeFileSync(path.join(testDirectory, "GUESS", "01", "GUESS.inp"), "1\n");
  fs.writeFileSync(path.join(testDirectory, "GUESS", "01", "GUESS.out"), "1\n");

  const jobId = "cancel-during-checker-job";
  resetJudgePrewarmStateForTests();
  t.after(() => {
    activeJobs.delete(jobId);
    resetJudgePrewarmStateForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });
  activeJobs.set(jobId, { cancel: false, runIds: new Set(), startedRunIds: new Set() });

  t.mock.method(executorClient, "start", async () => {
    activeJobs.get(jobId)!.cancel = true;
    return { ...executorClient.health, ready: false, diagnostics: ["cancelled during checker"] };
  });

  const actions: string[] = [];
  const events: JudgeEventWriter = {
    send(type, data) {
      if (type === "progress" && "action" in data) actions.push(data.action);
      if (type === "problem_completed") actions.push("problem_completed");
    },
    end() {},
  };
  const pins: PinnedJudgeToolchains = {
    cpp: { kind: "cpp", source: "none", ready: false, executablePath: "", version: "" },
    c: { kind: "c", source: "none", ready: false, executablePath: "", version: "" },
    python: { kind: "python", source: "managed", ready: true, executablePath: pythonExe, version: "3.12" },
    pascal: { kind: "pascal", source: "none", ready: false, executablePath: "", version: "" },
    go: { kind: "go", source: "none", ready: false, executablePath: "", version: "" },
    java: { kind: "java", source: "none", ready: false, executablePath: "", version: "" },
    rust: { kind: "rust", source: "none", ready: false, executablePath: "", version: "" },
    javascript: { kind: "javascript", source: "none", ready: false, executablePath: "", version: "" },
    csharp: { kind: "csharp", source: "none", ready: false, executablePath: "", version: "" },
    scratch: { kind: "scratch", source: "none", ready: false, executablePath: "", version: "" },
  };

  await runJudgeSession({
    request: {
      thisinhPath: contestantsDirectory,
      testPath: testDirectory,
      jobId,
      problemConfigs: {
        GUESS: {
          useStdIO: true,
          totalScore: null,
          defaultScore: 1,
          testScores: {},
          checkerType: "checker.py",
          isInteractive: true,
          interactor: "interactor.py",
        },
      },
      targetContestants: ["Audit"],
      targetProblems: ["GUESS"],
    },
    contestantsDirectory,
    testDirectory,
    tempDirectory,
    events,
    pinnedToolchains: pins,
  });

  assert.equal(
    actions.some((action) => action.includes("Compiling interactor")),
    false,
    `cancelled job during checker resolution must not start interactor compilation, got: ${actions.join(", ")}`,
  );
  assert.equal(actions.includes("problem_completed"), false);
});

test("interactive testcase runner returns a cancelled result instead of rejecting when job is cancelled before execution", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-interactive-cancel-"));
  const executorRoot = path.join(root, "executor");
  fs.mkdirSync(path.join(executorRoot, "workspaces"), { recursive: true });
  fs.mkdirSync(path.join(executorRoot, "artifacts"), { recursive: true });
  const binaryPath = path.join(root, "sub.exe");
  const interactorPath = path.join(root, "interactor.exe");
  const inputPath = path.join(root, "01.inp");
  const outputPath = path.join(root, "01.out");
  for (const file of [binaryPath, interactorPath, inputPath, outputPath]) {
    fs.writeFileSync(file, "stub");
  }
  const jobId = "interactive-cancelled-job";
  activeJobs.set(jobId, { cancel: true, runIds: new Set(), startedRunIds: new Set() });
  t.after(() => {
    activeJobs.delete(jobId);
    fs.rmSync(root, { recursive: true, force: true });
  });
  t.mock.method(executorClient, "start", async () => ({
    ...executorClient.health,
    ready: true,
    executorRoot,
  }));

  const result = await runTestCase({
    contestant: "Audit",
    problemName: "GUESS",
    testName: "01",
    language: "cpp",
    submissionPath: binaryPath,
    executablePath: binaryPath,
    inputPath,
    expectedOutputPath: outputPath,
    expectedOutputPreview: "stub",
    testRoot: root,
    contestantsRoot: root,
    tempDirectory: root,
    pythonCommand: "",
    timeLimitMs: 1_000,
    score: 1,
    config: normalizeProblemConfig("GUESS", { useStdIO: true, isInteractive: true, interactor: "interactor.exe" }, null),
    checker: { path: null },
    interactor: { path: interactorPath, runtime: "native" },
    jobId,
  });
  assert.equal(result.score, 0);
  assert.equal(result.status, "FAIL");
  assert.equal(result.errorDetail, "cancelled");
});

test("interactive testcase runner preserves TLE verdict when peer participant is cleaned up with reason cancelled", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-interactive-peer-cleanup-"));
  const executorRoot = path.join(root, "executor");
  fs.mkdirSync(path.join(executorRoot, "workspaces"), { recursive: true });
  fs.mkdirSync(path.join(executorRoot, "artifacts"), { recursive: true });
  const binaryPath = path.join(root, "sub.exe");
  const interactorPath = path.join(root, "interactor.exe");
  const inputPath = path.join(root, "01.inp");
  const outputPath = path.join(root, "01.out");
  for (const file of [binaryPath, interactorPath, inputPath, outputPath]) {
    fs.writeFileSync(file, "stub");
  }
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  t.mock.method(executorClient, "start", async () => ({
    ...executorClient.health,
    ready: true,
    executorRoot,
  }));
  t.mock.method(executorClient, "runInteractive", async (spec) => ({
    runId: spec.runId,
    verdict: "TLE" as const,
    scoreMultiplier: 0,
    executionTimeMs: 500,
    peakMemoryBytes: 4096,
    submissionResult: {
      runId: spec.submission.runId,
      reason: "wall_time_limit" as const,
      exitCode: null,
      securitySetupTimeUs: 100,
      wallTimeUs: 500_000,
      resultCollectionTimeUs: 50,
      stdoutBytes: 0,
      stderrBytes: 0,
    },
    interactorResult: {
      runId: spec.interactor.runId,
      reason: "cancelled" as const,
      exitCode: null,
      securitySetupTimeUs: 100,
      wallTimeUs: 500_000,
      resultCollectionTimeUs: 50,
      stdoutBytes: 0,
      stderrBytes: 0,
    },
  }));

  const result = await runTestCase({
    contestant: "Audit",
    problemName: "GUESS",
    testName: "01",
    language: "cpp",
    submissionPath: binaryPath,
    executablePath: binaryPath,
    inputPath,
    expectedOutputPath: outputPath,
    expectedOutputPreview: "stub",
    testRoot: root,
    contestantsRoot: root,
    tempDirectory: root,
    pythonCommand: "",
    timeLimitMs: 500,
    score: 1,
    config: normalizeProblemConfig("GUESS", { useStdIO: true, isInteractive: true, interactor: "interactor.exe" }, null),
    checker: { path: null },
    interactor: { path: interactorPath, runtime: "native" },
  });
  assert.equal(result.status, "TLE");
  assert.equal(result.score, 0);
  assert.equal(result.execution?.reason, "wall_time_limit");
});

test("certified-local C++ session probe rethrows JudgeJobCancelledError instead of TOOLCHAIN_PREFLIGHT_FAILED when job is cancelled", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-cert-probe-cancel-"));
  const jobId = "cancelled-cert-probe-job";
  activeJobs.set(jobId, { cancel: true, runIds: new Set(), startedRunIds: new Set() });
  t.after(() => {
    activeJobs.delete(jobId);
    fs.rmSync(root, { recursive: true, force: true });
  });

  await assert.rejects(
    ensureCertifiedLocalCppSessionProbe(
      {
        kind: "cpp",
        source: "custom",
        ready: true,
        provenance: "certified-local",
        certificateId: "cert-cancelled-job",
        snapshotDigest: "digest-cancelled-job",
        executablePath: path.join(root, "g++.exe"),
        executionPath: path.join(root, "g++.exe"),
        executionId: "toolchains/cert-cpp/bin/g++.exe",
        certifiedRoles: ["submission", "checker"],
        version: "13.2.0",
      },
      root,
      jobId,
    ),
    (error: unknown) =>
      error instanceof Error
      && error.name === "JudgeJobCancelledError"
      && !error.message.includes("TOOLCHAIN_PREFLIGHT_FAILED"),
  );
});
