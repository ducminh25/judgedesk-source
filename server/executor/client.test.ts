import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { executorPathCandidates, isTransientExecutorStartupFailure } from "./client.js";
import type { ExecutorHealth } from "./protocol.js";

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
