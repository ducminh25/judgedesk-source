import assert from "node:assert/strict";
import test from "node:test";
import type { Express } from "express";
import {
  JudgeJobCancelledError,
  JudgeJobRegistry,
} from "./jobs.js";
import { ServerLifecycle } from "./platform/server-lifecycle.js";
import {
  drainServerForProcessExit,
  prepareServerShutdown,
  registerSystemRoutes,
  type ServerShutdownDependencies,
} from "./routes/system-routes.js";

test("a batch without jobId receives a registered effective job ID", () => {
  const lifecycle = new ServerLifecycle();
  const registry = new JudgeJobRegistry(
    lifecycle,
    async () => true,
    () => "generated-job-id",
  );

  const registration = registry.tryRegister(undefined);
  assert.equal(registration.accepted, true);
  if (!registration.accepted) return;
  assert.equal(registration.jobId, "generated-job-id");
  assert.equal(registry.activeJobs.get(registration.jobId), registration.job);
  assert.equal(lifecycle.activeJudgeSessionCount, 1);

  registration.finish();
  registration.finish();
  assert.equal(registry.activeJobs.size, 0);
  assert.equal(lifecycle.activeJudgeSessionCount, 0);
});

test("a generated job ID cannot bypass an earlier cancellation tombstone", async () => {
  const lifecycle = new ServerLifecycle();
  const generatedIds = ["cancelled-generated-id", "fresh-generated-id"];
  const registry = new JudgeJobRegistry(
    lifecycle,
    async () => true,
    () => generatedIds.shift() ?? "fallback-generated-id",
  );

  const cancellation = await registry.cancelJob("cancelled-generated-id");
  assert.equal(cancellation.accepted, true);

  const registration = registry.tryRegister(undefined);
  assert.equal(registration.accepted, true);
  if (!registration.accepted) return;
  assert.equal(registration.jobId, "fresh-generated-id");
  registration.finish();
});

test("cancel-before-register creates a bounded tombstone and rejects the reordered batch", async () => {
  let clock = 1_000;
  const lifecycle = new ServerLifecycle();
  const registry = new JudgeJobRegistry(
    lifecycle,
    async () => true,
    () => "unused-generated-id",
    {
      pendingCancelTtlMs: 100,
      maxPendingCancels: 1,
      now: () => clock,
    },
  );

  assert.deepEqual(await registry.cancelJob("reordered-job"), {
    found: false,
    pending: true,
    accepted: true,
    failedRunCancellations: 0,
  });
  assert.deepEqual(registry.tryRegister("reordered-job"), {
    accepted: false,
    reason: "cancelled",
  });
  // The tombstone is retained so a repeated batch cannot consume it and run.
  assert.deepEqual(registry.tryRegister("reordered-job"), {
    accepted: false,
    reason: "cancelled",
  });

  const saturated = await registry.cancelJob("another-job");
  assert.equal(saturated.accepted, false);
  assert.equal(saturated.pending, false);

  clock += 101;
  const afterExpiry = registry.tryRegister("reordered-job");
  assert.equal(afterExpiry.accepted, true);
  if (afterExpiry.accepted) afterExpiry.finish();
});

test("cancelling a job marks it synchronously, cancels started runs, and rejects late attaches", async () => {
  const cancelledRuns: string[] = [];
  const lifecycle = new ServerLifecycle();
  const registry = new JudgeJobRegistry(
    lifecycle,
    async (runId) => {
      cancelledRuns.push(runId);
      return true;
    },
  );
  const registration = registry.tryRegister("active-job");
  assert.equal(registration.accepted, true);
  if (!registration.accepted) return;
  registry.attachExecutorRun(registration.jobId, "run-1");
  registry.startExecutorRun(registration.jobId, "run-1");

  const cancelling = registry.cancelJob(registration.jobId);
  assert.equal(registration.job.cancel, true);
  assert.throws(
    () => registry.attachExecutorRun(registration.jobId, "run-after-cancel"),
    JudgeJobCancelledError,
  );
  assert.deepEqual(await cancelling, {
    found: true,
    pending: false,
    accepted: true,
    failedRunCancellations: 0,
  });
  assert.deepEqual(cancelledRuns, ["run-1"]);

  registration.finish();
});

test("cancellation during preparation blocks a reserved run before native submission", async () => {
  const cancelledRuns: string[] = [];
  const lifecycle = new ServerLifecycle();
  const registry = new JudgeJobRegistry(
    lifecycle,
    async (runId) => {
      cancelledRuns.push(runId);
      return false;
    },
  );
  const registration = registry.tryRegister("preparing-job");
  assert.equal(registration.accepted, true);
  if (!registration.accepted) return;
  registry.attachExecutorRun(registration.jobId, "reserved-run");

  const cancellation = registry.cancelJob(registration.jobId);
  assert.equal(registration.job.cancel, true);
  assert.throws(
    () => registry.startExecutorRun(registration.jobId, "reserved-run"),
    JudgeJobCancelledError,
  );
  assert.deepEqual(await cancellation, {
    found: true,
    pending: false,
    accepted: true,
    failedRunCancellations: 0,
  });
  assert.deepEqual(cancelledRuns, []);

  registry.detachExecutorRun(registration.jobId, "reserved-run");
  registration.finish();
});

test("a native cancel response of false is reported as a cancellation failure", async () => {
  const lifecycle = new ServerLifecycle();
  const registry = new JudgeJobRegistry(
    lifecycle,
    async () => false,
  );
  const registration = registry.tryRegister("false-cancel-job");
  assert.equal(registration.accepted, true);
  if (!registration.accepted) return;
  registry.attachExecutorRun(registration.jobId, "started-run");
  registry.startExecutorRun(registration.jobId, "started-run");

  assert.deepEqual(await registry.cancelJob(registration.jobId), {
    found: true,
    pending: false,
    accepted: true,
    failedRunCancellations: 1,
  });

  registration.finish();
});

test("a settled executor run is no longer cancelled while its outer testcase remains active", async () => {
  const cancelledRuns: string[] = [];
  const lifecycle = new ServerLifecycle();
  const registry = new JudgeJobRegistry(
    lifecycle,
    async (runId) => {
      cancelledRuns.push(runId);
      return false;
    },
  );
  const registration = registry.tryRegister("checking-job");
  assert.equal(registration.accepted, true);
  if (!registration.accepted) return;
  registry.attachExecutorRun(registration.jobId, "completed-submission");
  registry.startExecutorRun(registration.jobId, "completed-submission");
  registry.completeExecutorRun(registration.jobId, "completed-submission");

  assert.deepEqual(await registry.cancelJob(registration.jobId), {
    found: true,
    pending: false,
    accepted: true,
    failedRunCancellations: 0,
  });
  assert.deepEqual(cancelledRuns, []);

  registry.detachExecutorRun(registration.jobId, "completed-submission");
  registration.finish();
});

test("shutdown locks admission, cancels all jobs, waits for handlers, then shuts down executor", async () => {
  const calls: string[] = [];
  const lifecycle = new ServerLifecycle();
  const registry = new JudgeJobRegistry(
    lifecycle,
    async (runId) => {
      calls.push(`cancel:${runId}`);
      return true;
    },
  );
  const registration = registry.tryRegister("drained-job");
  assert.equal(registration.accepted, true);
  if (!registration.accepted) return;
  registry.attachExecutorRun(registration.jobId, "active-run");
  registry.startExecutorRun(registration.jobId, "active-run");

  const dependencies: ServerShutdownDependencies = {
    beginDrain: () => {
      calls.push("begin-drain");
      lifecycle.beginDrain();
    },
    cancelActiveJudgeJobs: () => {
      calls.push("cancel-all");
      return registry.cancelAllActiveJobs();
    },
    waitForJudgeSessionsToFinish: (timeoutMs) => {
      calls.push(`wait:${timeoutMs}`);
      return lifecycle.waitForJudgeSessionsToFinish(timeoutMs);
    },
    activeJudgeSessionCount: () => lifecycle.activeJudgeSessionCount,
    shutdownExecutor: async () => {
      calls.push("shutdown-executor");
    },
    scheduleProcessExit: () => {
      calls.push("schedule-exit");
    },
    drainTimeoutMs: 1_000,
  };

  const shuttingDown = prepareServerShutdown(dependencies);
  assert.equal(registration.job.cancel, true);
  assert.deepEqual(lifecycle.tryStartJudgeSession("late-job"), {
    accepted: false,
    reason: "draining",
  });
  registration.finish();

  assert.deepEqual(await shuttingDown, { ok: true });
  assert.deepEqual(calls, [
    "begin-drain",
    "cancel-all",
    "cancel:active-run",
    "wait:1000",
    "shutdown-executor",
  ]);
});

test("shutdown timeout returns non-2xx and never shuts down the executor or exits", async () => {
  let shutdownHandler:
    | ((request: unknown, response: TestResponse) => Promise<unknown>)
    | undefined;
  const app = {
    get: () => app,
    post: (path: string, handler: typeof shutdownHandler) => {
      if (path === "/api/shutdown") shutdownHandler = handler;
      return app;
    },
  } as unknown as Express;
  let executorShutdown = false;
  let exitScheduled = false;
  const dependencies: ServerShutdownDependencies = {
    beginDrain: () => {},
    cancelActiveJudgeJobs: () => 1,
    waitForJudgeSessionsToFinish: async () => false,
    activeJudgeSessionCount: () => 1,
    shutdownExecutor: async () => {
      executorShutdown = true;
    },
    scheduleProcessExit: () => {
      exitScheduled = true;
    },
    drainTimeoutMs: 10,
  };
  registerSystemRoutes(app, dependencies);
  assert.ok(shutdownHandler);

  const response = createTestResponse();
  await shutdownHandler({}, response);
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.body, {
    success: false,
    code: "JUDGE_DRAIN_TIMEOUT",
    message: "Timed out waiting for 1 active judging session(s) to stop.",
  });
  assert.equal(executorShutdown, false);
  assert.equal(exitScheduled, false);
});

test("successful shutdown returns 200 and schedules exit only after executor shutdown", async () => {
  let shutdownHandler:
    | ((request: unknown, response: TestResponse) => Promise<unknown>)
    | undefined;
  const app = {
    get: () => app,
    post: (path: string, handler: typeof shutdownHandler) => {
      if (path === "/api/shutdown") shutdownHandler = handler;
      return app;
    },
  } as unknown as Express;
  const calls: string[] = [];
  const dependencies: ServerShutdownDependencies = {
    beginDrain: () => {
      calls.push("begin-drain");
    },
    cancelActiveJudgeJobs: () => {
      calls.push("cancel-all");
      return 0;
    },
    waitForJudgeSessionsToFinish: async () => {
      calls.push("wait");
      return true;
    },
    activeJudgeSessionCount: () => 0,
    shutdownExecutor: async () => {
      calls.push("shutdown-executor");
    },
    scheduleProcessExit: () => {
      calls.push("schedule-exit");
    },
    drainTimeoutMs: 10,
  };
  registerSystemRoutes(app, dependencies);
  assert.ok(shutdownHandler);

  const response = createTestResponse();
  await shutdownHandler({}, response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { success: true });
  assert.deepEqual(calls, [
    "begin-drain",
    "cancel-all",
    "wait",
    "shutdown-executor",
    "schedule-exit",
  ]);
});

test("process-level shutdown uses the same cancel-then-drain protocol as the HTTP route", async () => {
  const calls: string[] = [];
  const dependencies: ServerShutdownDependencies = {
    beginDrain: () => {
      calls.push("begin-drain");
    },
    cancelActiveJudgeJobs: () => {
      calls.push("cancel-all");
      return 1;
    },
    waitForJudgeSessionsToFinish: async () => {
      throw new Error("composed lifecycle drain must own the wait");
    },
    activeJudgeSessionCount: () => 1,
    shutdownExecutor: async () => {
      throw new Error("composed lifecycle drain must own executor shutdown");
    },
    drainLifecycle: async (timeoutMs) => {
      calls.push(`drain:${timeoutMs}`);
    },
    scheduleProcessExit: () => {
      throw new Error("process-level drain must not schedule its own exit");
    },
    drainTimeoutMs: 321,
  };

  await drainServerForProcessExit(dependencies);

  assert.deepEqual(calls, ["begin-drain", "cancel-all", "drain:321"]);
});

test("process-level shutdown rejects instead of hiding a failed drain", async () => {
  const dependencies: ServerShutdownDependencies = {
    beginDrain: () => {},
    cancelActiveJudgeJobs: () => 1,
    waitForJudgeSessionsToFinish: async () => false,
    activeJudgeSessionCount: () => 1,
    shutdownExecutor: async () => {},
    drainLifecycle: async () => {
      throw new Error("run container did not drain");
    },
    scheduleProcessExit: () => {},
    drainTimeoutMs: 10,
  };

  await assert.rejects(
    drainServerForProcessExit(dependencies),
    /SERVER_SHUTDOWN_FAILED: run container did not drain/,
  );
});

test("shutdown with drainLifecycle classifies active session drain failure as JUDGE_DRAIN_TIMEOUT", async () => {
  const dependencies: ServerShutdownDependencies = {
    beginDrain: () => {},
    cancelActiveJudgeJobs: () => 1,
    waitForJudgeSessionsToFinish: async () => false,
    activeJudgeSessionCount: () => 1,
    shutdownExecutor: async () => {},
    drainLifecycle: async () => {
      throw new AggregateError(
        [new Error("Timed out waiting for 1 active judging session(s) to finish")],
        "ServerLifecycle.drain() failed with 1 background/shutdown error(s):\n  Timed out waiting for 1 active judging session(s) to finish",
      );
    },
    scheduleProcessExit: () => {},
    drainTimeoutMs: 10,
  };

  assert.deepEqual(await prepareServerShutdown(dependencies), {
    ok: false,
    code: "JUDGE_DRAIN_TIMEOUT",
    message: "Timed out waiting for 1 active judging session(s) to stop.",
  });
});


interface TestResponse {
  statusCode: number;
  body: unknown;
  status(code: number): TestResponse;
  json(body: unknown): TestResponse;
}

function createTestResponse(): TestResponse {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}
