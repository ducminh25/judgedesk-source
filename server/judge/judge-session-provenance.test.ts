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
