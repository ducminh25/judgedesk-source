import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ResolvedToolchain } from "../toolchains/types.js";
import type { JudgeEventWriter } from "./judge-event-writer.js";
import { runJudgeSession } from "./judge-session.js";

function pin(
  kind: "cpp" | "c" | "python",
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
      },
    }),
    /TOOLCHAIN_PREFLIGHT_FAILED: C\+\+ submissions: CERTIFICATION_REQUIRED/,
  );
  assert.deepEqual(emitted, []);
});
