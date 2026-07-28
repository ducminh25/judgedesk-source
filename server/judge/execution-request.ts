import {
  DEFAULT_EXECUTOR_LIMITS,
  type ExecutorRunSpec,
} from "../executor/protocol.js";

const COMPILER_WRITE_OVERHEAD_BYTES = 4 * 1024 * 1024;

interface CompilerExecutorRunSpecOptions {
  runId: string;
  workspaceId: string;
  executableId: string;
  args: string[];
  environment: Record<string, string>;
  timeoutMs: number;
  memoryBytes: number;
  maxGeneratedFileBytes: number;
}

export function buildCompilerExecutorRunSpec(
  options: CompilerExecutorRunSpecOptions,
): ExecutorRunSpec {
  return {
    runId: options.runId,
    role: "compiler",
    workspaceId: options.workspaceId,
    executableId: options.executableId,
    args: options.args,
    stdoutFile: "compiler.stdout",
    stderrFile: "compiler.stderr",
    environment: options.environment,
    limits: {
      ...DEFAULT_EXECUTOR_LIMITS.compiler,
      wallTimeMs: options.timeoutMs,
      memoryBytes: options.memoryBytes,
      totalWriteBytes:
        options.maxGeneratedFileBytes + COMPILER_WRITE_OVERHEAD_BYTES,
    },
  };
}

interface SubmissionExecutorRunSpecOptions {
  runId: string;
  workspaceId: string;
  executableId: string;
  args: string[];
  stdinFile?: string;
  environment: Record<string, string>;
  timeLimitMs: number;
  memoryBytes: number;
}

export function buildSubmissionExecutorRunSpec(
  options: SubmissionExecutorRunSpecOptions,
): ExecutorRunSpec {
  return {
    runId: options.runId,
    role: "submission",
    workspaceId: options.workspaceId,
    executableId: options.executableId,
    args: options.args,
    stdinFile: options.stdinFile,
    stdoutFile: "stdout.txt",
    stderrFile: "stderr.txt",
    environment: options.environment,
    limits: {
      ...DEFAULT_EXECUTOR_LIMITS.submission,
      wallTimeMs: Math.max(1, options.timeLimitMs),
      memoryBytes: options.memoryBytes,
    },
  };
}
