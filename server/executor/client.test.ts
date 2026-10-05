import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import test from "node:test";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  createStandaloneTreeGuard,
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
  executorErrored(child: ChildProcessWithoutNullStreams, error: Error): void;
  executorExited(child: ChildProcessWithoutNullStreams, error: Error): void;
  receive(child: ChildProcessWithoutNullStreams, chunk: Buffer): void;
  getEnvironment(): NodeJS.ProcessEnv;
  guardedDrainChild: ChildProcessWithoutNullStreams | null;
}

type FakeChild = ChildProcessWithoutNullStreams & {
  killCalls: number;
  stdinEndCalls: number;
  emitProcessExit(code: number | null, signal: NodeJS.Signals | null): void;
  emitClose(code: number | null, signal: NodeJS.Signals | null): void;
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

test("production executor environment ignores test-only root overrides", (t) => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jd_test_executor_env_boundary_"));
  const original = {
    nodeEnv: process.env.NODE_ENV,
    executorTestRoot: process.env.JUDGEDESK_EXECUTOR_TEST_ROOT,
    themisAppDataDir: process.env.THEMIS_APP_DATA_DIR,
    localAppData: process.env.LOCALAPPDATA,
    appData: process.env.APPDATA,
  };
  t.after(() => {
    for (const [key, value] of Object.entries({
      NODE_ENV: original.nodeEnv,
      JUDGEDESK_EXECUTOR_TEST_ROOT: original.executorTestRoot,
      THEMIS_APP_DATA_DIR: original.themisAppDataDir,
      LOCALAPPDATA: original.localAppData,
      APPDATA: original.appData,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  const hostLocalAppData = path.join(testRoot, "host-local");
  const hostAppData = path.join(testRoot, "host-roaming");
  process.env.NODE_ENV = "production";
  process.env.LOCALAPPDATA = hostLocalAppData;
  process.env.APPDATA = hostAppData;
  process.env.JUDGEDESK_EXECUTOR_TEST_ROOT = path.join(testRoot, "executor-test-root");
  process.env.THEMIS_APP_DATA_DIR = path.join(testRoot, "themis-test-root");

  const client = new ExecutorClient();
  const environment = (client as unknown as ExecutorClientInternals).getEnvironment();

  assert.equal(environment.LOCALAPPDATA, hostLocalAppData);
  assert.equal(environment.APPDATA, hostAppData);
  assert.equal(fs.existsSync(path.join(testRoot, "executor-test-root", "localappdata")), false);
  assert.equal(fs.existsSync(path.join(testRoot, "executor-test-root", "roamingappdata")), false);
});

test("executor child always authenticates the direct Node parent, never the Tauri sidecar parent", () => {
  const client = new ExecutorClient({
    environment: { JUDGEDESK_PARENT_PID: "41999" },
  });
  const environment = (client as unknown as ExecutorClientInternals).getEnvironment();

  assert.equal(environment.JUDGEDESK_PARENT_PID, String(process.pid));
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
  internals.guardedDrainChild = child;
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

test("standalone guard creation is private on POSIX and records the actual child contract", async (t) => {
  const guard = createStandaloneTreeGuard();
  t.after(() => guard.cleanup());

  assert.equal(guard.environment.JUDGEDESK_TREE_GUARD_REQUIRED, "1");
  assert.match(guard.environment.JUDGEDESK_TREE_GUARD_GENERATION ?? "", /^[0-9a-f]{64}$/);
  const guardPath = guard.environment.JUDGEDESK_TREE_GUARD_PATH;
  assert.ok(guardPath);
  assert.match(fs.readFileSync(guardPath, "utf8"), /^JUDGEDESK_PROCESS_TREE\/1\ngeneration=[0-9a-f]{64}\n$/);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(guardPath).mode & 0o777, 0o600);
  }

  const client = new ExecutorClient({
    platform: "darwin",
    environment: {},
    shutdownRequestTimeoutMs: 5,
    shutdownExitTimeoutMs: 5,
  });
  const child = fakeChild();
  const internals = client as unknown as ExecutorClientInternals;
  internals.child = child;
  internals.guardedDrainChild = child;
  internals.cachedHealth = readyHealth();
  internals.lifecycleState = "running";
  internals.startPromise = Promise.resolve(internals.cachedHealth);
  internals.request = async () => {
    throw new Error("simulated standalone shutdown timeout");
  };

  await assert.rejects(client.shutdown(), /simulated standalone shutdown timeout/);
  assert.equal(child.killCalls, 0);
  assert.equal(internals.child, child);
  assert.equal(internals.lifecycleState, "draining");
});

test("guarded macOS treats an unexpected current-executor exit as terminal", async () => {
  const client = new ExecutorClient({
    platform: "darwin",
    environment: { JUDGEDESK_TREE_GUARD_REQUIRED: "1" },
  });
  const child = fakeChild();
  const internals = client as unknown as ExecutorClientInternals;
  internals.child = child;
  internals.guardedDrainChild = child;
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

test("guarded macOS startup retry failure retains the executor without killing it", async () => {
  const client = new ExecutorClient({
    platform: "darwin",
    environment: { JUDGEDESK_TREE_GUARD_REQUIRED: "1" },
    shutdownRequestTimeoutMs: 5,
    shutdownExitTimeoutMs: 5,
  });
  const child = fakeChild({ exitOnKill: false });
  const internals = client as unknown as ExecutorClientInternals;
  internals.child = child;
  internals.guardedDrainChild = child;
  internals.cachedHealth = readyHealth();
  internals.lifecycleState = "starting";
  internals.request = async () => {
    throw new Error("simulated startup-retry shutdown failure");
  };

  await internals.stopChildForStartupRetry();

  assert.equal(child.killCalls, 0);
  assert.equal(internals.child, child);
  assert.equal(internals.lifecycleState, "terminal");
  const health = await client.start();
  assert.equal(health.ready, false);
  assert.match(health.diagnostics.join("; "), /could not prove guarded drain/);
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

test("an unknown IPC correlation terminalizes the live generation through stdin EOF", () => {
  const client = new ExecutorClient({ platform: "darwin", environment: {} });
  const child = fakeChild({ exitOnKill: false });
  const internals = client as unknown as ExecutorClientInternals & {
    ownedTreeGuardCleanup: (() => void) | null;
  };
  let cleanupCalls = 0;
  internals.child = child;
  internals.guardedDrainChild = child;
  internals.cachedHealth = readyHealth();
  internals.lifecycleState = "running";
  internals.startPromise = Promise.resolve(internals.cachedHealth);
  internals.ownedTreeGuardCleanup = () => {
    cleanupCalls += 1;
  };

  const response = Buffer.from(JSON.stringify({ type: "health", id: "unknown-id", health: readyHealth() }));
  const frame = Buffer.allocUnsafe(4 + response.length);
  frame.writeUInt32LE(response.length, 0);
  response.copy(frame, 4);
  internals.receive(child, frame);

  assert.equal(child.stdinEndCalls, 1);
  assert.equal(internals.child, child);
  assert.equal(internals.lifecycleState, "terminal");
  assert.equal(cleanupCalls, 0);
  assert.match(internals.cachedHealth.diagnostics.join("; "), /unknown correlation ID/i);
});

test("a malformed IPC payload terminalizes the live generation through stdin EOF", () => {
  const client = new ExecutorClient({ platform: "darwin", environment: {} });
  const child = fakeChild({ exitOnKill: false });
  const internals = client as unknown as ExecutorClientInternals;
  internals.child = child;
  internals.guardedDrainChild = child;
  internals.cachedHealth = readyHealth();
  internals.lifecycleState = "running";
  internals.startPromise = Promise.resolve(internals.cachedHealth);

  const payload = Buffer.from("{not-json", "utf8");
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  internals.receive(child, frame);

  assert.equal(child.stdinEndCalls, 1);
  assert.equal(internals.child, child);
  assert.equal(internals.lifecycleState, "terminal");
  assert.match(internals.cachedHealth.diagnostics.join("; "), /Unexpected token|JSON/i);
});

test("a non-object IPC payload terminalizes the live generation through stdin EOF", () => {
  const client = new ExecutorClient({ platform: "darwin", environment: {} });
  const child = fakeChild({ exitOnKill: false });
  const internals = client as unknown as ExecutorClientInternals;
  internals.child = child;
  internals.guardedDrainChild = child;
  internals.cachedHealth = readyHealth();
  internals.lifecycleState = "running";
  internals.startPromise = Promise.resolve(internals.cachedHealth);

  const payload = Buffer.from("null", "utf8");
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);

  assert.doesNotThrow(() => internals.receive(child, frame));
  assert.equal(child.stdinEndCalls, 1);
  assert.equal(internals.child, child);
  assert.equal(internals.lifecycleState, "terminal");
  assert.match(internals.cachedHealth.diagnostics.join("; "), /invalid response envelope/i);
});

test("an IPC stdin write failure terminalizes every pending request through EOF", async () => {
  const client = new ExecutorClient({ platform: "darwin", environment: {} });
  const child = fakeChild({ exitOnKill: false });
  const internals = client as unknown as ExecutorClientInternals;
  internals.child = child;
  internals.guardedDrainChild = child;
  internals.cachedHealth = readyHealth();
  internals.lifecycleState = "running";
  internals.startPromise = Promise.resolve(internals.cachedHealth);
  const stdin = child.stdin as unknown as {
    write(chunk: Uint8Array, callback: (error?: Error | null) => void): boolean;
  };
  stdin.write = (_chunk, callback) => {
    callback(new Error("simulated stdin write failure"));
    return false;
  };

  await assert.rejects(
    internals.request({ type: "health", id: "write-failure" }, 50),
    /simulated stdin write failure/,
  );

  assert.equal(child.stdinEndCalls, 1);
  assert.equal(internals.child, child);
  assert.equal(internals.lifecycleState, "terminal");
  assert.match(internals.cachedHealth.diagnostics.join("; "), /simulated stdin write failure/);
});

test("a mismatched IPC response type terminalizes the live generation", async () => {
  const client = new ExecutorClient({ platform: "darwin", environment: {} });
  const child = fakeChild({ exitOnKill: false });
  const internals = client as unknown as ExecutorClientInternals;
  internals.child = child;
  internals.guardedDrainChild = child;
  internals.cachedHealth = readyHealth();
  internals.lifecycleState = "running";
  internals.startPromise = Promise.resolve(internals.cachedHealth);

  const responsePromise = internals.request({ type: "health", id: "wrong-response-type" }, 50);
  const payload = Buffer.from(JSON.stringify({
    type: "shutdown_result",
    id: "wrong-response-type",
  }));
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  internals.receive(child, frame);

  await assert.rejects(responsePromise, /sent shutdown_result for a health request/);
  assert.equal(child.stdinEndCalls, 1);
  assert.equal(internals.child, child);
  assert.equal(internals.lifecycleState, "terminal");
});

test("startup retry retains its guard after exit until close completes", async () => {
  const client = new ExecutorClient({
    platform: "darwin",
    environment: { JUDGEDESK_TREE_GUARD_REQUIRED: "1" },
    shutdownExitTimeoutMs: 100,
  });
  const child = fakeChild({ exitOnKill: false });
  const internals = client as unknown as ExecutorClientInternals & {
    ownedTreeGuardCleanup: (() => void) | null;
  };
  let cleanupCalls = 0;
  let markExitObserved!: () => void;
  const exitObserved = new Promise<void>((resolve) => {
    markExitObserved = resolve;
  });
  internals.child = child;
  internals.guardedDrainChild = child;
  internals.cachedHealth = readyHealth();
  internals.lifecycleState = "starting";
  internals.ownedTreeGuardCleanup = () => {
    cleanupCalls += 1;
  };
  child.once("close", () => {
    internals.executorExited(child, new Error("startup retry close"));
  });
  internals.request = async (request) => {
    queueMicrotask(() => {
      child.emitProcessExit(0, null);
      markExitObserved();
    });
    return { type: "shutdown_result", id: request.id };
  };

  const stopping = internals.stopChildForStartupRetry();
  await exitObserved;
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(internals.child, child);
  assert.equal(internals.guardedDrainChild, child);
  assert.equal(cleanupCalls, 0);

  child.emitClose(0, null);
  await stopping;
  assert.equal(internals.child, null);
  assert.equal(internals.guardedDrainChild, null);
  assert.equal(cleanupCalls, 1);
});

test("a child error retains the guard until close proves executor exit", () => {
  const client = new ExecutorClient({ platform: "darwin", environment: {} });
  const child = fakeChild({ exitOnKill: false });
  const internals = client as unknown as ExecutorClientInternals & {
    ownedTreeGuardCleanup: (() => void) | null;
  };
  let cleanupCalls = 0;
  internals.child = child;
  internals.guardedDrainChild = child;
  internals.cachedHealth = readyHealth();
  internals.lifecycleState = "running";
  internals.startPromise = Promise.resolve(internals.cachedHealth);
  internals.ownedTreeGuardCleanup = () => {
    cleanupCalls += 1;
  };

  internals.executorErrored(child, new Error("simulated child error"));

  assert.equal(child.stdinEndCalls, 1);
  assert.equal(internals.child, child);
  assert.equal(internals.lifecycleState, "terminal");
  assert.equal(cleanupCalls, 0);

  internals.executorExited(child, new Error("simulated close"));
  assert.equal(internals.child, null);
  assert.equal(cleanupCalls, 1);
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
  assert.equal(internals.child, child);
  internals.executorExited(child, new Error("simulated close after shutdown"));
  assert.equal(internals.child, null);
  assert.equal(internals.lifecycleState, "terminal");
});

test("shutdown retains the standalone guard until close follows exit", async () => {
  const client = new ExecutorClient({
    platform: "win32",
    environment: {},
    shutdownExitTimeoutMs: 100,
  });
  const internals = client as unknown as ExecutorClientInternals;
  const child = fakeChild();
  internals.child = child;
  internals.guardedDrainChild = child;
  internals.cachedHealth = readyHealth();
  internals.lifecycleState = "running";
  internals.startPromise = Promise.resolve(internals.cachedHealth);
  const cleanup = internals as unknown as { ownedTreeGuardCleanup: (() => void) | null };
  let cleanupCalls = 0;
  cleanup.ownedTreeGuardCleanup = () => {
    cleanupCalls += 1;
  };
  internals.request = async (request) => {
    setTimeout(() => child.emitProcessExit(0, null), 10);
    return { type: "shutdown_result", id: request.id };
  };

  await client.shutdown();

  assert.equal(internals.child, child);
  assert.equal(internals.guardedDrainChild, child);
  assert.equal(cleanupCalls, 0);

  internals.executorExited(child, new Error("simulated close after exit"));
  assert.equal(internals.child, null);
  assert.equal(internals.guardedDrainChild, null);
  assert.equal(cleanupCalls, 1);
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
  child.stdinEndCalls = 0;
  const stdin = new EventEmitter() as unknown as ChildProcessWithoutNullStreams["stdin"];
  Object.defineProperty(stdin, "writable", { configurable: true, value: true });
  stdin.write = ((_chunk: Uint8Array, callback?: (error?: Error | null) => void) => {
    callback?.();
    return true;
  }) as typeof stdin.write;
  stdin.end = (() => {
    child.stdinEndCalls += 1;
    return stdin;
  }) as typeof stdin.end;
  Object.defineProperty(child, "stdin", { configurable: true, value: stdin });
  child.emitProcessExit = (code, signal) => {
    exitCode = code;
    signalCode = signal;
    child.emit("exit", code, signal);
  };
  child.emitClose = (code, signal) => {
    child.emit("close", code, signal);
  };
  child.emitExit = (code, signal) => {
    child.emitProcessExit(code, signal);
    child.emitClose(code, signal);
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
