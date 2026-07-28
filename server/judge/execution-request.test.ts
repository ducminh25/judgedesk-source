import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCompilerExecutorRunSpec,
  buildSubmissionExecutorRunSpec,
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

test("native submission executor request preserves the current empty launch contract", () => {
  assert.deepEqual(
    buildSubmissionExecutorRunSpec({
      runId: "submission_cpp",
      workspaceId: "workspace_cpp",
      executableId: "artifacts/cpp",
      args: [],
      environment: {},
      timeLimitMs: 1_000,
      memoryBytes: 256 * MiB,
    }),
    {
      runId: "submission_cpp",
      role: "submission",
      workspaceId: "workspace_cpp",
      executableId: "artifacts/cpp",
      args: [],
      stdinFile: undefined,
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
