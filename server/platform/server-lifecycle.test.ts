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
