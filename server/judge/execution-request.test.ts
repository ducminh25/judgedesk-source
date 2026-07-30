import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCheckerExecutorRunSpec,
  buildCompilerExecutorRunSpec,
  buildSubmissionExecutorRunSpec,
  CHECKER_OUTPUT_LIMIT_BYTES,
} from "./execution-request.js";

const MiB = 1024 * 1024;

test("compiler executor request preserves the current role, files, and limits", () => {
  assert.deepEqual(
    buildCompilerExecutorRunSpec({
      runId: "compile_fixed",
      workspaceId: "workspace_fixed",
      executableId: "toolchain/compiler",
      args: ["-std=c++14", "submission.cpp", "-o", "compiled-output.bin"],
      environment: {
        Path: "C:\\JudgeDesk\\toolchains\\gcc\\bin",
        COMPILER_PATH: "C:\\JudgeDesk\\toolchains\\gcc\\libexec",
      },
      timeoutMs: 15_000,
      memoryBytes: 512 * MiB,
      maxGeneratedFileBytes: 32 * MiB,
    }),
    {
      runId: "compile_fixed",
      role: "compiler",
      workspaceId: "workspace_fixed",
      executableId: "toolchain/compiler",
      args: ["-std=c++14", "submission.cpp", "-o", "compiled-output.bin"],
      stdoutFile: "compiler.stdout",
      stderrFile: "compiler.stderr",
      environment: {
        Path: "C:\\JudgeDesk\\toolchains\\gcc\\bin",
        COMPILER_PATH: "C:\\JudgeDesk\\toolchains\\gcc\\libexec",
      },
      limits: {
        processCount: 8,
        threadCount: 64,
        outputBytes: 4 * MiB,
        totalWriteBytes: 36 * MiB,
        openFiles: 128,
        createdFiles: 256,
        wallTimeMs: 15_000,
        memoryBytes: 512 * MiB,
      },
    },
  );
});

test("native submission wire request preserves the current empty launch contract", () => {
  const request = buildSubmissionExecutorRunSpec({
    runId: "submission_cpp",
    workspaceId: "workspace_cpp",
    executableId: "artifacts/cpp",
    args: [],
    environment: {},
    timeLimitMs: 1_000,
    memoryBytes: 256 * MiB,
  });

  assert.deepEqual(
    JSON.parse(JSON.stringify(request)),
    {
      runId: "submission_cpp",
      role: "submission",
      workspaceId: "workspace_cpp",
      executableId: "artifacts/cpp",
      args: [],
      stdoutFile: "stdout.txt",
      stderrFile: "stderr.txt",
      environment: {},
      limits: {
        processCount: 1,
        threadCount: 64,
        outputBytes: 16 * MiB,
        totalWriteBytes: 128 * MiB,
        openFiles: 64,
        createdFiles: 256,
        wallTimeMs: 1_000,
        memoryBytes: 256 * MiB,
      },
    },
  );
});

test("Python submission request preserves isolated launch markers and clamps wall time", () => {
  assert.deepEqual(
    buildSubmissionExecutorRunSpec({
      runId: "submission_python",
      workspaceId: "workspace_python",
      executableId: "toolchains/python",
      args: ["-I", "-B", "submission.py"],
      stdinFile: "stdin.txt",
      environment: {
        JUDGEDESK_PYTHON_ISOLATED: "1",
        PYTHONNOUSERSITE: "1",
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONHOME: "toolchains/python",
        PATH: "toolchains/python/bin",
      },
      timeLimitMs: 0,
      memoryBytes: 384 * MiB,
    }),
    {
      runId: "submission_python",
      role: "submission",
      workspaceId: "workspace_python",
      executableId: "toolchains/python",
      args: ["-I", "-B", "submission.py"],
      stdinFile: "stdin.txt",
      stdoutFile: "stdout.txt",
      stderrFile: "stderr.txt",
      environment: {
        JUDGEDESK_PYTHON_ISOLATED: "1",
        PYTHONNOUSERSITE: "1",
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONHOME: "toolchains/python",
        PATH: "toolchains/python/bin",
      },
      limits: {
        processCount: 1,
        threadCount: 64,
        outputBytes: 16 * MiB,
        totalWriteBytes: 128 * MiB,
        openFiles: 64,
        createdFiles: 256,
        wallTimeMs: 1,
        memoryBytes: 384 * MiB,
      },
    },
  );
});

test("native and runtime-backed checkers use distinct typed roles with the same strict limits", () => {
  const base = {
    runId: "checker_fixed",
    workspaceId: "workspace_fixed",
    executableId: "artifacts/checker",
    args: ["input.txt", "actual.txt", "expected.txt"],
    environment: {},
    timeoutMs: 5_000,
    memoryBytes: 256 * MiB,
  };
  const native = buildCheckerExecutorRunSpec({
    ...base,
    runtimeBacked: false,
  });
  const runtime = buildCheckerExecutorRunSpec({
    ...base,
    executableId: "toolchains/python/python.exe",
    runtimeBacked: true,
  });

  assert.equal(native.role, "checker");
  assert.equal(runtime.role, "checker-runtime");
  for (const request of [native, runtime]) {
    assert.equal(request.limits.processCount, 1);
    assert.equal(request.limits.outputBytes, CHECKER_OUTPUT_LIMIT_BYTES);
    assert.equal(request.limits.wallTimeMs, 5_000);
    assert.equal(request.limits.memoryBytes, 256 * MiB);
  }
});

test("built-in toolchain identities become role-scoped grants on the wire", () => {
  const identity = {
    packageId: "python-windows-x64",
    packageDigest: "a".repeat(64),
    componentId: "python",
  };
  const submission = buildSubmissionExecutorRunSpec({
    runId: "submission_builtin",
    workspaceId: "workspace_builtin",
    executableId: "builtin-toolchains/python-windows-x64/python.exe",
    args: ["-I", "submission.py"],
    environment: {},
    toolchain: identity,
    timeLimitMs: 1_000,
    memoryBytes: 256 * MiB,
  });
  const checker = buildCheckerExecutorRunSpec({
    runId: "checker_builtin",
    workspaceId: "workspace_builtin",
    executableId: "builtin-toolchains/python-windows-x64/python.exe",
    args: ["checker.py"],
    environment: {},
    toolchain: identity,
    runtimeBacked: true,
    timeoutMs: 5_000,
    memoryBytes: 256 * MiB,
  });
  const compiler = buildCompilerExecutorRunSpec({
    runId: "compiler_builtin",
    workspaceId: "workspace_builtin",
    executableId: "builtin-toolchains/gcc-windows-x64/bin/g++.exe",
    args: ["submission.cpp"],
    environment: {},
    toolchain: {
      packageId: "gcc-windows-x64",
      packageDigest: "b".repeat(64),
      componentId: "gpp",
    },
    timeoutMs: 15_000,
    memoryBytes: 512 * MiB,
    maxGeneratedFileBytes: 32 * MiB,
  });

  assert.equal(submission.toolchain?.role, "submission-runtime");
  assert.equal(checker.toolchain?.role, "checker-runtime");
  assert.equal(compiler.toolchain?.role, "compiler");
  assert.deepEqual(
    { ...submission.toolchain, role: undefined },
    { ...identity, role: undefined },
  );
});
