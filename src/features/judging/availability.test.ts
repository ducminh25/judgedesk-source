import assert from "node:assert/strict";
import test from "node:test";
import { canExportScoreboard, canStartJudge, getJudgeDisabledReason, selectedNames } from "./availability.js";

test("judge becomes available again after selecting all contestants and problems", () => {
  const contestants = ["Alice", "Bob"];
  const problems = ["A", "B"];
  const selectedContestants: Record<string, boolean> = { Alice: false, Bob: false };
  const selectedProblems: Record<string, boolean> = { A: false, B: false };
  const availability = () => canStartJudge({
    contestantsPath: String.raw`D:\contestants`,
    testsPath: String.raw`D:\tests`,
    contestantNames: selectedNames(contestants, selectedContestants),
    problemNames: selectedNames(problems, selectedProblems),
    secureRunnerReady: true,
  });

  assert.equal(availability(), false);
  Object.assign(selectedContestants, { Alice: true, Bob: true });
  Object.assign(selectedProblems, { A: true, B: true });
  assert.equal(availability(), true);
});

test("judge requires paths, one selected target of each kind, and a ready runner", () => {
  const valid = {
    contestantsPath: "contestants",
    testsPath: "tests",
    contestantNames: ["Alice"],
    problemNames: ["A"],
    secureRunnerReady: true,
  };

  assert.equal(canStartJudge(valid), true);
  assert.equal(canStartJudge({ ...valid, contestantNames: [] }), false);
  assert.equal(canStartJudge({ ...valid, problemNames: [] }), false);
  assert.equal(canStartJudge({ ...valid, secureRunnerReady: false }), false);
  assert.equal(canStartJudge({ ...valid, contestantsPath: " " }), false);
  assert.equal(canStartJudge({ ...valid, testsPath: " " }), false);

  assert.equal(getJudgeDisabledReason(valid), null);
  assert.equal(getJudgeDisabledReason({ ...valid, secureRunnerReady: false }), "runnerUnavailable");
  assert.equal(getJudgeDisabledReason({ ...valid, contestantsPath: "" }), "missingData");
  assert.equal(getJudgeDisabledReason({ ...valid, testsPath: "" }), "missingData");
  assert.equal(getJudgeDisabledReason({ ...valid, contestantNames: [] }), "noSelection");
  assert.equal(getJudgeDisabledReason({ ...valid, problemNames: [] }), "noSelection");
});

test("score export needs a contestant or a problem, but not both", () => {
  assert.equal(canExportScoreboard([], []), false);
  assert.equal(canExportScoreboard(["Alice"], []), true);
  assert.equal(canExportScoreboard([], ["A"]), true);
  assert.equal(canExportScoreboard(["Alice"], ["A"]), true);
});

test("selected judging targets preserve the current scoreboard order", () => {
  const displayed = ["C03_QUANGMINH", "C03-BaHung", "C03-khanh"];
  assert.deepEqual(
    selectedNames(displayed, {
      "C03_QUANGMINH": true,
      "C03-BaHung": true,
      "C03-khanh": true,
    }),
    displayed,
  );
});
