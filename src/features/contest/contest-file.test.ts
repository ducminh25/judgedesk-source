import assert from "node:assert/strict";
import test from "node:test";
import {
  buildContestManifest,
  ensureContestExtension,
  validateContestManifest,
} from "./contest-file";

const workspace = {
  contestants: ["Alice"],
  problems: ["A"],
  problemConfigs: {},
  selectedContestants: { Alice: true },
  selectedProblems: { A: true },
  judgeResult: null,
};

test("buildContestManifest creates a portable versioned manifest", () => {
  const now = new Date("2026-07-19T01:02:03.000Z");
  const manifest = buildContestManifest(workspace, undefined, now);
  assert.equal(manifest.format, "judgedesk-contest");
  assert.equal(manifest.formatVersion, 1);
  assert.equal(manifest.createdAt, now.toISOString());
  assert.equal("timeLimit" in manifest.workspace, false);
  assert.deepEqual(validateContestManifest(JSON.parse(JSON.stringify(manifest))), manifest);
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
