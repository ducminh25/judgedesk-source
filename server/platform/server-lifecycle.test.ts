import assert from "node:assert/strict";
import test from "node:test";
import { ServerLifecycle } from "./server-lifecycle.js";

test("server lifecycle rejects new judge sessions as soon as draining begins", () => {
  const lifecycle = new ServerLifecycle();
  assert.equal(lifecycle.acceptsNewJudgeSessions, true);

  const admitted = lifecycle.tryStartJudgeSession("job-before-drain");
  assert.equal(admitted.accepted, true);
  assert.equal(lifecycle.activeJudgeSessionCount, 1);

  lifecycle.beginDrain();
  assert.equal(lifecycle.acceptsNewJudgeSessions, false);
  assert.deepEqual(
    lifecycle.tryStartJudgeSession("job-after-drain"),
    { accepted: false, reason: "draining" },
  );

  lifecycle.beginDrain();
  assert.equal(lifecycle.acceptsNewJudgeSessions, false);

  if (admitted.accepted) admitted.lease.finish();
  assert.equal(lifecycle.activeJudgeSessionCount, 0);
});

test("server lifecycle admission and registration share one synchronous operation", () => {
  const lifecycle = new ServerLifecycle();
  const first = lifecycle.tryStartJudgeSession("same-job");
  assert.equal(first.accepted, true);
  assert.deepEqual(
    lifecycle.tryStartJudgeSession("same-job"),
    { accepted: false, reason: "duplicate" },
  );
  assert.equal(lifecycle.activeJudgeSessionCount, 1);

  if (first.accepted) {
    first.lease.finish();
    first.lease.finish();
  }
  assert.equal(lifecycle.activeJudgeSessionCount, 0);
});

test("server lifecycle waits for every admitted handler to settle", async () => {
  const lifecycle = new ServerLifecycle();
  const first = lifecycle.tryStartJudgeSession("job-a");
  const second = lifecycle.tryStartJudgeSession("job-b");
  assert.equal(first.accepted, true);
  assert.equal(second.accepted, true);
  lifecycle.beginDrain();

  const waiting = lifecycle.waitForJudgeSessionsToFinish(1_000);
  if (first.accepted) first.lease.finish();
  let settled = false;
  void waiting.then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  if (second.accepted) second.lease.finish();
  assert.equal(await waiting, true);
});

test("server lifecycle drain wait is bounded and remains fail-closed", async () => {
  const lifecycle = new ServerLifecycle();
  const admitted = lifecycle.tryStartJudgeSession("stuck-job");
  assert.equal(admitted.accepted, true);
  lifecycle.beginDrain();

  assert.equal(await lifecycle.waitForJudgeSessionsToFinish(10), false);
  assert.equal(lifecycle.acceptsNewJudgeSessions, false);
  assert.equal(lifecycle.activeJudgeSessionCount, 1);

  if (admitted.accepted) admitted.lease.finish();
  assert.equal(await lifecycle.waitForJudgeSessionsToFinish(10), true);
});

test("server lifecycle drain never shuts down executor while judge sessions remain active and allows retry after session completion", async (t) => {
  const { executorClient } = await import("../executor/client.js");
  let executorShutdownCalls = 0;
  t.mock.method(executorClient, "shutdown", async () => {
    executorShutdownCalls += 1;
  });

  const lifecycle = new ServerLifecycle();
  const admitted = lifecycle.tryStartJudgeSession("active-during-drain");
  assert.equal(admitted.accepted, true);

  await assert.rejects(
    lifecycle.drain(20),
    /active judging session/,
  );
  assert.equal(
    executorShutdownCalls,
    0,
    "executor must not be shut down while a judge session failed to drain",
  );

  if (admitted.accepted) admitted.lease.finish();
  await lifecycle.drain(200);
  assert.equal(
    executorShutdownCalls,
    1,
    "subsequent drain after session completion must not return a stale rejected promise",
  );
});

test("background judge prewarm defers immediately without running PCH when server lifecycle begins draining", async () => {
  const { executeJudgePrewarm, resetJudgePrewarmStateForTests } = await import("../judge/background-prewarm.js");
  resetJudgePrewarmStateForTests();
  let pchCalled = false;
  let closing = false;
  const outcome = await executeJudgePrewarm({
    isClosing: () => closing,
    waitForToolchainDiscovery: async () => {
      closing = true;
      return {
        schemaVersion: 2,
        registryRevision: 1,
        status: "complete",
        refreshing: false,
        completedAt: new Date().toISOString(),
        profiles: {},
      };
    },
    ensureUniversalCppPch: async () => {
      pchCalled = true;
      return null;
    },
  });
  assert.deepEqual(outcome, { status: "deferred", reason: "SERVER_CLOSING" });
  assert.equal(pchCalled, false, "PCH compilation must not start after server drain begins");
});
