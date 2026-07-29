import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  ExecutorClient,
  executorPathCandidates,
  isTransientExecutorStartupFailure,
} from "./client.js";
import type {
  ExecutorHealth,
  ExecutorRequest,
  ExecutorResponse,
  ExecutorRunSpec,
} from "./protocol.js";

type ExecutorLifecycleState = "idle" | "starting" | "running" | "draining" | "terminal";

interface ExecutorClientInternals {
  child: ChildProcessWithoutNullStreams | null;
  cachedHealth: ExecutorHealth;
  lifecycleState: ExecutorLifecycleState;
  startPromise: Promise<ExecutorHealth> | null;
  request(request: ExecutorRequest, timeoutMs?: number): Promise<ExecutorResponse>;
  startWithTransientRetry(): Promise<ExecutorHealth>;
  stopChildForStartupRetry(): Promise<void>;
  executorExited(child: ChildProcessWithoutNullStreams, error: Error): void;
  receive(child: ChildProcessWithoutNullStreams, chunk: Buffer): void;
}

type FakeChild = ChildProcessWithoutNullStreams & {
  killCalls: number;
  emitExit(code: number | null, signal: NodeJS.Signals | null): void;
};

test("executor resolver includes Tauri's suffix-free Windows runtime name", () => {
  const execPath = String.raw`D:\JudgeDesk\server.exe`;
  const candidates = executorPathCandidates({
    platform: "win32",
    arch: "x64",
    execPath,
    appRoot: String.raw`D:\JudgeDesk`,
    cwd: String.raw`D:\source`,
    production: true,
    override: "",
  });

  assert.equal(candidates[0], path.join(path.dirname(execPath), "judgedesk-executor.exe"));
  assert.ok(candidates.includes(path.join(path.dirname(execPath), "judgedesk-executor-x86_64-pc-windows-msvc.exe")));
});

test("startup retry is limited to the transient empty security-probe result", () => {
  const health: ExecutorHealth = {
    ready: false,
    mode: "windows-lpac-job",
    executorVersion: "1.2.0",
    executorRoot: "root",
    diagnostics: [
      "SECURE_RUNNER_SELF_TEST_FAILED: security probe returned invalid JSON: EOF while parsing a value at line 1 column 0",
    ],
    networkBlocked: false,
    filesystemIsolated: false,
    processTreeControlled: false,
    memoryLimitSupported: true,
  };

  assert.equal(isTransientExecutorStartupFailure(health), true);
  assert.equal(isTransientExecutorStartupFailure({
    ...health,
    diagnostics: ["LPAC security probe failed: network was reachable"],
  }), false);
  assert.equal(isTransientExecutorStartupFailure({ ...health, ready: true }), false);
});

test("the pre-submit barrier can stop a run after executor startup but before IPC submission", async () => {
  const client = new ExecutorClient();
  const events: string[] = [];
  const controllable = client as unknown as {
    start(): Promise<ExecutorHealth>;
    request(request: ExecutorRequest): Promise<ExecutorResponse>;
  };
  controllable.start = async () => readyHealth();
  controllable.request = async (request) => {
    events.push(`request:${request.type}`);
    throw new Error("executor request must not be reached");
  };

  await assert.rejects(
    client.run(runSpec(), () => {
      events.push("barrier");
      throw new Error("cancelled before submit");
    }),
    /cancelled before submit/,
  );
  assert.deepEqual(events, ["barrier"]);
});

test("run and cancel responses reject mismatched run identities", async () => {
  const client = new ExecutorClient();
  const internals = client as unknown as ExecutorClientInternals & {
    start(): Promise<ExecutorHealth>;
  };
  internals.start = async () => readyHealth();
  internals.child = fakeChild();
  internals.request = async (request) => {
    if (request.type === "run") {
      return {
        type: "run_result",
        id: request.id,
        result: runResult("different-run"),
      };
    }
    if (request.type === "cancel") {
      return {
        type: "cancel_result",
        id: request.id,
        runId: "different-run",
        cancelled: true,
      };
    }
    throw new Error(`unexpected request ${request.type}`);
  };

  await assert.rejects(
    client.run(runSpec()),
    /result runId mismatch: expected reserved-run, received different-run/,
  );
  await assert.rejects(
    client.cancel("reserved-run"),
    /cancellation runId mismatch: expected reserved-run, received different-run/,
  );
});

test("guarded macOS shutdown timeout retains the executor and prevents restart", async () => {
  const client = new ExecutorClient({
    platform: "darwin",
    environment: { JUDGEDESK_TREE_GUARD_REQUIRED: "1" },
    shutdownRequestTimeoutMs: 5,
    shutdownExitTimeoutMs: 5,
  });
  const child = fakeChild();
  const internals = client as unknown as ExecutorClientInternals;
  internals.child = child;
  internals.cachedHealth = readyHealth();
  internals.lifecycleState = "running";
  internals.startPromise = Promise.resolve(internals.cachedHealth);
  internals.request = async () => {
    throw new Error("simulated shutdown timeout");
  };
  let restartAttempts = 0;
  internals.startWithTransientRetry = async () => {
    restartAttempts += 1;
    return readyHealth();
  };

  await assert.rejects(client.shutdown(), /simulated shutdown timeout/);

  assert.equal(internals.child, child);
  assert.equal(child.killCalls, 0);
  assert.equal(internals.lifecycleState, "draining");
  const health = await client.start();
  assert.equal(health.ready, false);
  assert.match(health.diagnostics.join("; "), /drain is still in progress/);
  assert.equal(restartAttempts, 0);
});

test("guarded macOS treats an unexpected current-executor exit as terminal", async () => {
  const client = new ExecutorClient({
    platform: "darwin",
    environment: { JUDGEDESK_TREE_GUARD_REQUIRED: "1" },
  });
  const child = fakeChild();
  const internals = client as unknown as ExecutorClientInternals;
  internals.child = child;
  internals.cachedHealth = readyHealth();
  internals.lifecycleState = "running";
  internals.startPromise = Promise.resolve(internals.cachedHealth);
  let restartAttempts = 0;
  internals.startWithTransientRetry = async () => {
    restartAttempts += 1;
    return readyHealth();
  };

  internals.executorExited(child, new Error("simulated executor crash"));

  assert.equal(internals.child, null);
  assert.equal(internals.lifecycleState, "terminal");
  const health = await client.start();
  assert.equal(health.ready, false);
  assert.match(health.diagnostics.join("; "), /simulated executor crash/);
  assert.equal(restartAttempts, 0);
});

test("startup retry retains a non-exiting executor and prevents replacement", async () => {
  const client = new ExecutorClient({
    platform: "darwin",
    environment: { JUDGEDESK_TREE_GUARD_REQUIRED: "1" },
    shutdownRequestTimeoutMs: 5,
    shutdownExitTimeoutMs: 5,
  });
  const child = fakeChild({ exitOnKill: false });
  const internals = client as unknown as ExecutorClientInternals;
  internals.child = child;
  internals.cachedHealth = readyHealth();
  internals.lifecycleState = "starting";
  internals.request = async () => {
    throw new Error("simulated startup-retry shutdown failure");
  };

  await internals.stopChildForStartupRetry();

  assert.equal(child.killCalls, 2);
  assert.equal(internals.child, child);
  assert.equal(internals.lifecycleState, "terminal");
  const health = await client.start();
  assert.equal(health.ready, false);
  assert.match(health.diagnostics.join("; "), /did not exit before a startup retry/);
});

test("unguarded shutdown rejects and retains a non-exiting executor", async () => {
  const client = new ExecutorClient({
    platform: "win32",
    environment: {},
    shutdownRequestTimeoutMs: 5,
    shutdownExitTimeoutMs: 5,
  });
  const child = fakeChild({ exitOnKill: false });
  const internals = client as unknown as ExecutorClientInternals;
  internals.child = child;
  internals.cachedHealth = readyHealth();
  internals.lifecycleState = "running";
  internals.startPromise = Promise.resolve(internals.cachedHealth);
  internals.request = async () => {
    throw new Error("simulated shutdown request failure");
  };

  await assert.rejects(client.shutdown(), /did not exit after its shutdown request failed/);

  assert.equal(child.killCalls, 1);
  assert.equal(internals.child, child);
  assert.equal(internals.lifecycleState, "terminal");
  const health = await client.start();
  assert.equal(health.ready, false);
  assert.match(health.diagnostics.join("; "), /simulated shutdown request failure/);
});

test("a delayed old-executor callback cannot clear or corrupt its replacement", () => {
  const client = new ExecutorClient({ platform: "win32", environment: {} });
  const oldChild = fakeChild();
  const newChild = fakeChild();
  const health = readyHealth();
  const startPromise = Promise.resolve(health);
  const internals = client as unknown as ExecutorClientInternals;
  internals.child = newChild;
  internals.cachedHealth = health;
  internals.lifecycleState = "running";
  internals.startPromise = startPromise;

  // A stale malformed frame and close callback both belong to the old process.
  internals.receive(oldChild, Buffer.alloc(4));
  internals.executorExited(oldChild, new Error("old executor exited late"));

  assert.equal(internals.child, newChild);
  assert.equal(internals.cachedHealth, health);
  assert.equal(internals.lifecycleState, "running");
  assert.equal(internals.startPromise, startPromise);
});

test("shutdown waits for the acknowledged executor to exit before completing", async () => {
  const client = new ExecutorClient({
    platform: "win32",
    environment: {},
    shutdownExitTimeoutMs: 100,
  });
  const child = fakeChild();
  const internals = client as unknown as ExecutorClientInternals;
  internals.child = child;
  internals.cachedHealth = readyHealth();
  internals.lifecycleState = "running";
  internals.startPromise = Promise.resolve(internals.cachedHealth);
  const events: string[] = [];
  internals.request = async (request) => {
    events.push("ack");
    setTimeout(() => {
      events.push("exit");
      child.emitExit(0, null);
    }, 10);
    return { type: "shutdown_result", id: request.id };
  };

  await client.shutdown();
  events.push("done");

  assert.deepEqual(events, ["ack", "exit", "done"]);
  assert.equal(child.killCalls, 0);
  assert.equal(internals.child, null);
  assert.equal(internals.lifecycleState, "terminal");
});

test("unguarded executor crashes retain the existing restart behavior", async () => {
  const client = new ExecutorClient({ platform: "win32", environment: {} });
  const child = fakeChild();
  const internals = client as unknown as ExecutorClientInternals;
  internals.child = child;
  internals.cachedHealth = readyHealth();
  internals.lifecycleState = "running";
  internals.startPromise = Promise.resolve(internals.cachedHealth);
  let restartAttempts = 0;
  internals.startWithTransientRetry = async () => {
    restartAttempts += 1;
    return readyHealth();
  };

  internals.executorExited(child, new Error("simulated Windows executor crash"));
  const health = await client.start();

  assert.equal(health.ready, true);
  assert.equal(restartAttempts, 1);
});

test("an unguarded crash during startup cannot recache the failed startup promise", async () => {
  const client = new ExecutorClient({ platform: "win32", environment: {} });
  const child = fakeChild();
  const internals = client as unknown as ExecutorClientInternals;
  internals.child = child;
  let releaseStartup!: () => void;
  internals.startWithTransientRetry = async () => {
    await new Promise<void>((resolve) => {
      releaseStartup = resolve;
    });
    return client.health;
  };

  const firstStartup = client.start();
  internals.executorExited(child, new Error("simulated crash during startup"));
  releaseStartup();
  const failedHealth = await firstStartup;

  assert.equal(failedHealth.ready, false);
  assert.equal(internals.startPromise, null);

  let restartAttempts = 0;
  internals.startWithTransientRetry = async () => {
    restartAttempts += 1;
    return readyHealth();
  };
  const restartedHealth = await client.start();

  assert.equal(restartedHealth.ready, true);
  assert.equal(restartAttempts, 1);
});

function readyHealth(): ExecutorHealth {
  return {
    ready: true,
    mode: "windows-lpac-job",
    executorVersion: "test",
    executorRoot: "test",
    diagnostics: [],
    networkBlocked: true,
    filesystemIsolated: true,
    processTreeControlled: true,
    memoryLimitSupported: true,
  };
}

function runSpec(): ExecutorRunSpec {
  return {
    runId: "reserved-run",
    role: "submission",
    workspaceId: "workspace",
    executableId: "program",
    args: [],
    stdoutFile: "stdout.txt",
    stderrFile: "stderr.txt",
    environment: {},
    limits: {
      wallTimeMs: 1_000,
      memoryBytes: 64 * 1024 * 1024,
      processCount: 1,
      threadCount: 1,
      outputBytes: 1_024,
      totalWriteBytes: 1_024,
      openFiles: 8,
      createdFiles: 8,
    },
  };
}

function runResult(runId: string) {
  return {
    runId,
    reason: "exited" as const,
    exitCode: 0,
    securitySetupTimeUs: 0,
    wallTimeUs: 0,
    resultCollectionTimeUs: 0,
    stdoutBytes: 0,
    stderrBytes: 0,
  };
}

function fakeChild({ exitOnKill = true }: { exitOnKill?: boolean } = {}): FakeChild {
  const child = new EventEmitter() as unknown as FakeChild;
  let exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;
  Object.defineProperties(child, {
    exitCode: {
      configurable: true,
      get: () => exitCode,
    },
    signalCode: {
      configurable: true,
      get: () => signalCode,
    },
  });
  child.killCalls = 0;
  child.emitExit = (code, signal) => {
    exitCode = code;
    signalCode = signal;
    child.emit("exit", code, signal);
    child.emit("close", code, signal);
  };
  child.kill = ((signal: NodeJS.Signals | number = "SIGTERM") => {
    child.killCalls += 1;
    if (exitOnKill) {
      child.emitExit(null, typeof signal === "string" ? signal : "SIGTERM");
    }
    return true;
  }) as FakeChild["kill"];
  return child;
}
