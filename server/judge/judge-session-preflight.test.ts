import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  ResolvedToolchain,
  ToolchainKind,
} from "../toolchains/types.js";
import type { JudgeEventWriter } from "./judge-event-writer.js";
import { planProblemTestCases, runJudgeSession } from "./judge-session.js";
import { normalizeProblemConfig } from "../../shared/problem-config.js";

function pin(
  kind: ToolchainKind,
  overrides: Partial<ResolvedToolchain> = {},
): ResolvedToolchain {
  return {
    kind,
    source: "managed",
    executablePath: `C:\\managed\\${kind}.exe`,
    version: "test",
    ready: true,
    ...overrides,
  };
}

test("judge session preflight rejects a missing C++ capability before emitting results", async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-session-preflight-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const contestantsDirectory = path.join(temporary, "contestants");
  const contestantDirectory = path.join(contestantsDirectory, "student");
  const testDirectory = path.join(temporary, "tests");
  const problemDirectory = path.join(testDirectory, "SUM");
  const workDirectory = path.join(temporary, "work");
  fs.mkdirSync(contestantDirectory, { recursive: true });
  fs.mkdirSync(problemDirectory, { recursive: true });
  fs.mkdirSync(workDirectory, { recursive: true });
  fs.writeFileSync(path.join(contestantDirectory, "SUM.cpp"), "int main(){}\n");

  const emitted: string[] = [];
  const events: JudgeEventWriter = {
    send(type) {
      emitted.push(type);
    },
    end() {},
  };
  await assert.rejects(
    runJudgeSession({
      request: {
        thisinhPath: contestantsDirectory,
        testPath: testDirectory,
        jobId: "preflight-test",
        problemConfigs: {},
        targetContestants: ["student"],
        targetProblems: ["SUM"],
      },
      contestantsDirectory,
      testDirectory,
      tempDirectory: workDirectory,
      events,
      pinnedToolchains: {
        cpp: pin("cpp", {
          source: "custom",
          ready: false,
          diagnosticCode: "CERTIFICATION_REQUIRED",
        }),
        c: pin("c"),
        python: pin("python"),
        pascal: pin("pascal"),
        go: pin("go"),
        java: pin("java"),
        rust: pin("rust"),
        javascript: pin("javascript"),
        csharp: pin("csharp"),
      },
    }),
    /TOOLCHAIN_PREFLIGHT_FAILED: C\+\+ submissions: CERTIFICATION_REQUIRED/,
  );
  assert.deepEqual(emitted, []);
});

test("session testcase plan preserves score, time, order, and preview semantics", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-session-plan-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ["10", "2"]) {
    const directory = path.join(root, name);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "data.in"), `${name}\n`);
    fs.writeFileSync(path.join(directory, "data.out"), "x".repeat(600));
  }
  const config = normalizeProblemConfig("SUM", {
    useStdIO: true,
    totalScore: 10,
    defaultScore: 1,
    testScores: { "2": 1, "10": 3 },
    polygonConfig: {
      enableGroups: false,
      tests: { "10": { points: 7, timeLimit: 2 } },
      groups: {},
    },
  }, null);

  const planned = planProblemTestCases(root, config);
  assert.deepEqual(planned.map(testCase => testCase.files.name), ["2", "10"]);
  assert.deepEqual(planned.map(testCase => testCase.score), [1.25, 8.75]);
  assert.deepEqual(planned.map(testCase => testCase.timeLimitMs), [1_000, 2_000]);
  assert.equal(planned[0].inputIsText, true);
  assert.equal(planned[0].expectedOutputPreview, `${"x".repeat(500)}...`);
});
