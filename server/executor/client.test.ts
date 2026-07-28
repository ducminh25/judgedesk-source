import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
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
