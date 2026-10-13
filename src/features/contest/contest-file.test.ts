import assert from "node:assert/strict";
import test from "node:test";
import {
  buildContestManifest,
  ensureContestExtension,
  validateContestManifest,
} from "./contest-file";
import {
  hasSavableContestData,
  shouldPromptForUnsavedContest,
} from "./dirty-state";

test("an empty scoreboard never prompts to save a phantom contest", () => {
  assert.equal(hasSavableContestData(0, 0), false);
  assert.equal(shouldPromptForUnsavedContest(true, 0, 0), false);
  assert.equal(shouldPromptForUnsavedContest(false, 1, 1), false);
  assert.equal(shouldPromptForUnsavedContest(true, 1, 0), true);
  assert.equal(shouldPromptForUnsavedContest(true, 0, 1), true);
});

const workspace = {
  contestants: ["Alice"],
  problems: ["A"],
  problemConfigs: {},
  selectedContestants: { Alice: true },
  selectedProblems: { A: true },
  judgeResult: null,
};

test("loaded judging results reject forged exact-score carriers", () => {
  const manifest = buildContestManifest(workspace);
  for (const scoreExact of [{ n: "bad", d: 1 }, { n: 1, d: 0 }, { n: 2, d: 4 }, { n: "1".repeat(1025), d: 1 }]) {
    assert.throws(() => validateContestManifest({ ...manifest, workspace: { ...workspace, judgeResult: {
      success: true, contestants: [{ contestantName: "Alice", problems: [{ problemName: "A", compileStatus: "OK", testCases: [], summary: { score: 1, status: "AC", scoreExact } }] }],
    } } }), /judg|result/i);
  }
});

test("buildContestManifest creates a portable versioned manifest", () => {
  const now = new Date("2026-07-19T01:02:03.000Z");
  const manifest = buildContestManifest(workspace, undefined, now);
  assert.equal(manifest.format, "judgedesk-contest");
  assert.equal(manifest.formatVersion, 1);
  assert.equal(manifest.createdAt, now.toISOString());
  assert.equal("timeLimit" in manifest.workspace, false);
  assert.deepEqual(validateContestManifest(JSON.parse(JSON.stringify(manifest))), manifest);
});

test("saved JE and legacy CE survive the contest manifest JSON round-trip unchanged", () => {
  const result = { success: true, contestants: [{ contestantName: "Alice", problems: [
    { problemName: "A", language: "cpp", compileStatus: "JE" as const, compileError: "runner setup failed", testCases: [], summary: { total: 0, passed: 0, score: 0, maxScore: 1, status: "JE" as const } },
    { problemName: "B", language: "cpp", compileStatus: "CE" as const, compileError: "historical diagnostic", testCases: [], summary: { total: 0, passed: 0, score: 0, maxScore: 1, status: "CE" as const } },
  ] }] };
  const manifest = buildContestManifest({ ...workspace, judgeResult: result });
  assert.deepEqual(validateContestManifest(JSON.parse(JSON.stringify(manifest))).workspace.judgeResult, result);
});

test("validateContestManifest accepts legacy archives that contain a global time limit", () => {
  const manifest = buildContestManifest(workspace);
  const legacyManifest = {
    ...manifest,
    workspace: { ...manifest.workspace, timeLimit: 1000 },
  };
  assert.equal(validateContestManifest(legacyManifest).workspace.problems[0], "A");
});

test("validateContestManifest rejects unsupported content", () => {
  assert.throws(
    () => validateContestManifest({ format: "judgedesk-contest", formatVersion: 99 }),
    /not supported/,
  );
});

test("validateContestManifest rejects malformed judging results", () => {
  const manifest = buildContestManifest(workspace);
  assert.throws(
    () => validateContestManifest({
      ...manifest,
      workspace: { ...manifest.workspace, judgeResult: { success: true } },
    }),
    /judging result is invalid/,
  );
});

test("ensureContestExtension adds the extension once", () => {
  assert.equal(ensureContestExtension("C:\\contests\\Final"), "C:\\contests\\Final.judgedesk");
  assert.equal(ensureContestExtension("Final.JUDGEDESK"), "Final.JUDGEDESK");
});
