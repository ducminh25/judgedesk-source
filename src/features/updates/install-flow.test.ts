import assert from "node:assert/strict";
import test from "node:test";
import {
  runUpdateInstallFlow,
  UpdateInstallFlowError,
  type UpdateInstallPhase,
} from "./install-flow.js";

function createFlow(
  calls: UpdateInstallPhase[],
  failure?: { phase: UpdateInstallPhase; error: unknown },
) {
  const step = (phase: UpdateInstallPhase) => async () => {
    calls.push(phase);
    if (failure?.phase === phase) throw failure.error;
  };
  return {
    prepare: step("prepare"),
    install: step("install"),
    relaunch: step("relaunch"),
  };
}

test("update install handoff prepares before install and relaunch", async () => {
  const calls: UpdateInstallPhase[] = [];

  await runUpdateInstallFlow(createFlow(calls));

  assert.deepEqual(calls, ["prepare", "install", "relaunch"]);
});

test("update install handoff waits for each step to settle", async () => {
  const calls: UpdateInstallPhase[] = [];
  let finishPrepare!: () => void;
  let finishInstall!: () => void;
  const flow = runUpdateInstallFlow({
    prepare: () => new Promise<void>((resolve) => {
      calls.push("prepare");
      finishPrepare = resolve;
    }),
    install: () => new Promise<void>((resolve) => {
      calls.push("install");
      finishInstall = resolve;
    }),
    relaunch: async () => {
      calls.push("relaunch");
    },
  });

  assert.deepEqual(calls, ["prepare"]);
  finishPrepare();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["prepare", "install"]);
  finishInstall();
  await flow;
  assert.deepEqual(calls, ["prepare", "install", "relaunch"]);
});

for (const testCase of [
  {
    phase: "prepare",
    expectedCalls: ["prepare"],
  },
  {
    phase: "install",
    expectedCalls: ["prepare", "install"],
  },
  {
    phase: "relaunch",
    expectedCalls: ["prepare", "install", "relaunch"],
  },
] as const) {
  test(`update install handoff stops after a ${testCase.phase} failure`, async () => {
    const calls: UpdateInstallPhase[] = [];
    const cause = new Error(`${testCase.phase} failed`);

    await assert.rejects(
      runUpdateInstallFlow(createFlow(calls, { phase: testCase.phase, error: cause })),
      (error: unknown) => {
        assert.ok(error instanceof UpdateInstallFlowError);
        assert.equal(error.phase, testCase.phase);
        assert.equal(error.message, cause.message);
        assert.equal(error.cause, cause);
        return true;
      },
    );
    assert.deepEqual(calls, testCase.expectedCalls);
  });
}

test("update install handoff preserves a non-Error failure message and phase", async () => {
  await assert.rejects(
    runUpdateInstallFlow(createFlow([], { phase: "prepare", error: "backend drain timed out" })),
    (error: unknown) => {
      assert.ok(error instanceof UpdateInstallFlowError);
      assert.equal(error.phase, "prepare");
      assert.equal(error.message, "backend drain timed out");
      return true;
    },
  );
});
