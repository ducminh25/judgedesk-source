import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { executorClient } from "../executor/client.js";
import { DEFAULT_EXECUTOR_LIMITS, type ExecutorLimits, type ExecutorRunResult } from "../executor/protocol.js";
import { createExecutorWorkspace, importExecutorArtifact } from "../executor/workspace.js";
import { prepareIsolatedPythonScript } from "../judge/python-runtime.js";
import { resolveManagedToolchain } from "../toolchains/resolver.js";

const MiB = 1024 * 1024;
const helperBinary = path.join(
  process.cwd(),
  "src-tauri",
  "binaries",
  process.platform === "win32"
    ? "judgedesk-executor-x86_64-pc-windows-msvc.exe"
    : `judgedesk-executor-${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`,
);
after(async () => {
  await executorClient.shutdown();
});

test("security fixtures can only reach the native executor harness", () => {
  const harness = fs.readFileSync(import.meta.filename, "utf8");
  assert.doesNotMatch(harness, /from\s+["'](?:node:)?child_process["']/);
  assert.doesNotMatch(harness, /\bspawn\s*\(/);
  for (const relative of [
    "server/judge/compiler.ts",
    "server/judge/testcase-runner.ts",
    "server/judge/custom-checker-runner.ts",
    "server/jobs.ts",
  ]) {
    const source = fs.readFileSync(path.join(process.cwd(), relative), "utf8");
    assert.doesNotMatch(source, /from\s+["'](?:node:)?child_process["']/);
    assert.doesNotMatch(source, /tree-kill|tasklist|sandbox-exec/);
  }
  assert.ok(fs.existsSync(path.join(process.cwd(), "server/security-fixtures/cpp/resource_attacks.cpp")));
  assert.ok(fs.existsSync(path.join(process.cwd(), "server/security-fixtures/python/resource_attacks.py")));
});

test("startup self-test proves the platform boundaries before hostile fixtures run", async () => {
  assert.ok(fs.existsSync(helperBinary), `Build the native executor first: ${helperBinary}`);
  const health = await executorClient.start();
  assert.equal(health.ready, true, health.diagnostics.join("; "));
  assert.equal(health.networkBlocked, true);
  assert.equal(health.filesystemIsolated, true);
  assert.equal(health.processTreeControlled, true);
  assert.equal(health.memoryLimitSupported, true);
});

test("submission cannot modify the immutable artifact cache", async () => {
  const artifact = await importExecutorArtifact(helperBinary);
  const workspace = await createExecutorWorkspace();
  const tamperPath = path.join(path.dirname(artifact.path), `tamper-${crypto.randomUUID()}.txt`);
  try {
    const result = await executorClient.run({
      runId: `artifact_${crypto.randomUUID().replaceAll("-", "_")}`,
      role: "submission",
      workspaceId: workspace.id,
      executableId: artifact.executableId,
      args: ["--test-write", tamperPath, "16"],
      stdoutFile: "stdout.txt",
      stderrFile: "stderr.txt",
      environment: {},
      limits: {
        ...DEFAULT_EXECUTOR_LIMITS.submission,
        wallTimeMs: 2_000,
        memoryBytes: 128 * MiB,
      },
    });
    assert.notEqual(result.exitCode, 0, JSON.stringify(result));
    assert.equal(fs.existsSync(tamperPath), false);
  } finally {
    workspace.dispose();
    fs.rmSync(tamperPath, { force: true });
  }
});

test(
  "managed Python AppContainer blocks private files, network, and child processes",
  {
    timeout: 30_000,
    skip: process.platform !== "win32" || !resolveManagedToolchain("python").ready,
  },
  async () => {
    const hostDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-python-boundary-"));
    const secretPath = path.join(hostDirectory, "secret.txt");
    const escapePath = path.join(hostDirectory, "escape.txt");
    fs.writeFileSync(secretPath, "PRIVATE", "utf8");
    try {
      const read = await runManagedPython(["read", secretPath]);
      assert.equal(read.result.reason, "exited", JSON.stringify(read.result));
      assert.notEqual(read.result.exitCode, 0, read.stdout);
      assert.doesNotMatch(read.stdout, /SECURITY_ESCAPE/);

      const write = await runManagedPython(["write", escapePath]);
      assert.equal(write.result.reason, "exited", JSON.stringify(write.result));
      assert.notEqual(write.result.exitCode, 0, write.stdout);
      assert.equal(fs.existsSync(escapePath), false);

      const network = await runManagedPython(["network"]);
      assert.equal(network.result.reason, "exited", JSON.stringify(network.result));
      assert.notEqual(network.result.exitCode, 0, network.stdout);

      const child = await runManagedPython(["subprocess"]);
      assert.ok(
        child.result.reason === "process_limit"
          || (child.result.reason === "exited" && child.result.exitCode !== 0),
        JSON.stringify(child.result),
      );
      assert.doesNotMatch(child.stdout, /SECURITY_ESCAPE/);
    } finally {
      fs.rmSync(hostDirectory, { recursive: true, force: true });
    }
  },
);

test("wall-clock boundary matrix is stable across 20 repetitions", { timeout: 90_000 }, async () => {
  // LPAC/Seatbelt loader time is part of wall time, so calibrate it once and choose payloads whose
  // total observed workload targets 80/120% of the configured boundary.
  // Keep the same 80/120% boundary but use a one-second window so an occasional
  // Windows scheduler/Defender pause cannot consume the entire 20% safety margin.
  const limitMs = 1_000;
  const baseline = await runHelper(["--test-sleep-ms", "0"], { wallTimeMs: 2000 });
  assert.equal(baseline.reason, "exited");
  const loaderMs = baseline.wallTimeUs / 1000;
  const underPayloadMs = Math.max(1, Math.floor(limitMs * 0.8 - loaderMs));
  const overPayloadMs = Math.max(1, Math.ceil(limitMs * 1.2 - loaderMs));
  for (let index = 0; index < 20; index += 1) {
    const result = await runHelper(["--test-sleep-ms", String(underPayloadMs)], { wallTimeMs: limitMs });
    assert.equal(result.reason, "exited", `80% repetition ${index}: ${JSON.stringify(result)}`);
    assert.equal(result.exitCode, 0);
  }
  const elapsed: number[] = [];
  for (let index = 0; index < 20; index += 1) {
    const result = await runHelper(["--test-sleep-ms", String(overPayloadMs)], { wallTimeMs: limitMs });
    assert.equal(result.reason, "wall_time_limit", `120% repetition ${index}: ${JSON.stringify(result)}`);
    assert.ok(result.wallTimeUs >= (limitMs - 10) * 1000, `killed too early: ${result.wallTimeUs}us`);
    elapsed.push(result.wallTimeUs / 1000);
  }
  elapsed.sort((left, right) => left - right);
  const p95 = elapsed[Math.ceil(elapsed.length * 0.95) - 1];
  assert.ok(p95 <= limitMs + Math.max(50, limitMs * 0.05), `p95 deadline lateness was ${p95 - limitMs}ms`);
});

test("CPU loop and sleep both receive TLE", { timeout: 10_000 }, async () => {
  const cpu = await runHelper(["--test-cpu-loop"], { wallTimeMs: 100 });
  const sleep = await runHelper(["--test-sleep-ms", "500"], { wallTimeMs: 100 });
  assert.equal(cpu.reason, "wall_time_limit");
  assert.equal(sleep.reason, "wall_time_limit");
});

test("job-wide memory boundary is stable across 20 repetitions", { timeout: 60_000 }, async () => {
  for (let index = 0; index < 20; index += 1) {
    const pass = await runHelper(["--test-allocate-mib", "48", "5"], { memoryBytes: 64 * MiB });
    assert.equal(pass.reason, "exited", `under-limit repetition ${index}: ${JSON.stringify(pass)}`);
  }
  for (let index = 0; index < 20; index += 1) {
    const fail = await runHelper(["--test-allocate-mib", "80", "2000"], { memoryBytes: 64 * MiB });
    assert.equal(fail.reason, "memory_limit", `over-limit repetition ${index}: ${JSON.stringify(fail)}`);
    assert.ok((fail.peakMemoryBytes ?? 0) > 0);
    assert.ok(
      (fail.peakMemoryBytes ?? 0) <= 64 * MiB,
      `reported MLE memory exceeded the configured limit: ${JSON.stringify(fail)}`,
    );
  }
});

test("output, workspace-write, and thread bombs get distinct reasons", { timeout: 20_000 }, async () => {
  const output = await runHelper(["--test-output-bytes", String(2 * MiB)], {
    outputBytes: 64 * 1024,
    totalWriteBytes: 2 * MiB,
  });
  assert.equal(output.reason, "output_limit");

  for (let index = 0; index < 20; index += 1) {
    const written = await runHelperWithWorkspace(
      (workspacePath) => ["--test-write", path.join(workspacePath, "bomb.bin"), String(2 * MiB)],
      { outputBytes: 32 * 1024, totalWriteBytes: 64 * 1024 },
    );
    assert.equal(written.reason, "write_limit", `write-limit repetition ${index}: ${JSON.stringify(written)}`);
  }

  const threads = await runHelper(["--test-thread-bomb", "32", "1000"], { threadCount: 8 });
  assert.equal(threads.reason, "thread_limit");
});

test("kernel process ceiling contains a real process bomb", { timeout: 30_000 }, async () => {
  for (let index = 0; index < 20; index += 1) {
    const processes = await runHelper(["--test-process-bomb", "128", "500"], {
      processCount: 1,
      wallTimeMs: 2_000,
    });
    assert.equal(
      processes.reason,
      "process_limit",
      `process-limit repetition ${index}: ${JSON.stringify(processes)}`,
    );
  }
});

test("explicit cancellation kills the whole active run", { timeout: 10_000 }, async () => {
  const workspace = await createExecutorWorkspace();
  try {
    const executableName = process.platform === "win32" ? "fixture.exe" : "fixture";
    workspace.stage(helperBinary, executableName, true);
    const runId = `cancel_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const pending = executorClient.run({
      runId,
      role: "security-probe",
      workspaceId: workspace.id,
      executableId: workspace.relative(executableName),
      args: ["--test-sleep-ms", "5000"],
      stdoutFile: "stdout.txt",
      stderrFile: "stderr.txt",
      environment: {},
      limits: limits({ wallTimeMs: 6000 }),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await executorClient.cancel(runId), true);
    assert.equal((await pending).reason, "cancelled");
  } finally {
    workspace.dispose();
  }
});

async function runHelper(
  args: string[],
  overrides: Partial<ExecutorLimits> = {},
): Promise<ExecutorRunResult> {
  return runHelperWithWorkspace(() => args, overrides);
}

async function runManagedPython(
  args: string[],
): Promise<{ result: ExecutorRunResult; stdout: string }> {
  const workspace = await createExecutorWorkspace();
  try {
    const launch = await prepareIsolatedPythonScript(
      workspace,
      path.join(process.cwd(), "server/security-fixtures/python/resource_attacks.py"),
      "resource_attacks.py",
    );
    const result = await executorClient.run({
      runId: `python_security_${crypto.randomUUID().replaceAll("-", "_")}`,
      role: "submission",
      workspaceId: workspace.id,
      executableId: launch.executableId,
      args: [...launch.args, ...args],
      stdoutFile: "stdout.txt",
      stderrFile: "stderr.txt",
      environment: launch.environment,
      limits: limits({
        wallTimeMs: 2_000,
        memoryBytes: 128 * MiB,
        processCount: 1,
      }),
    });
    return {
      result,
      stdout: fs.existsSync(path.join(workspace.path, "stdout.txt"))
        ? fs.readFileSync(path.join(workspace.path, "stdout.txt"), "utf8")
        : "",
    };
  } finally {
    workspace.dispose();
  }
}

async function runHelperWithWorkspace(
  args: (workspacePath: string) => string[],
  overrides: Partial<ExecutorLimits> = {},
): Promise<ExecutorRunResult> {
  const workspace = await createExecutorWorkspace();
  try {
    const executableName = process.platform === "win32" ? "fixture.exe" : "fixture";
    workspace.stage(helperBinary, executableName, true);
    return await executorClient.run({
      runId: `fixture_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      role: "security-probe",
      workspaceId: workspace.id,
      executableId: workspace.relative(executableName),
      args: args(workspace.path),
      stdoutFile: "stdout.txt",
      stderrFile: "stderr.txt",
      environment: {},
      limits: limits(overrides),
    });
  } finally {
    workspace.dispose();
  }
}

function limits(overrides: Partial<ExecutorLimits>): ExecutorLimits {
  return {
    ...DEFAULT_EXECUTOR_LIMITS.submission,
    wallTimeMs: 2000,
    memoryBytes: 128 * MiB,
    ...overrides,
  };
}
