import {
  DEFAULT_EXECUTOR_LIMITS,
  type ExecutorToolchainIdentity,
  type ExecutorRunSpec,
} from "../executor/protocol.js";

const COMPILER_WRITE_OVERHEAD_BYTES = 4 * 1024 * 1024;
export const CHECKER_OUTPUT_LIMIT_BYTES = 256 * 1024;

interface CompilerExecutorRunSpecOptions {
  runId: string;
  workspaceId: string;
  executableId: string;
  args: string[];
  environment: Record<string, string>;
  timeoutMs: number;
  memoryBytes: number;
  maxGeneratedFileBytes: number;
  maxWorkspaceWriteBytes?: number;
  maxCreatedFiles?: number;
  toolchain?: ExecutorToolchainIdentity;
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
    ...(options.toolchain
      ? { toolchain: { ...options.toolchain, role: "compiler" as const } }
      : {}),
    limits: {
      ...DEFAULT_EXECUTOR_LIMITS.compiler,
      wallTimeMs: options.timeoutMs,
      memoryBytes: options.memoryBytes,
      totalWriteBytes:
        options.maxWorkspaceWriteBytes
        ?? options.maxGeneratedFileBytes + COMPILER_WRITE_OVERHEAD_BYTES,
      createdFiles:
        options.maxCreatedFiles
        ?? DEFAULT_EXECUTOR_LIMITS.compiler.createdFiles,
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
  toolchain?: ExecutorToolchainIdentity;
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
    ...(options.toolchain
      ? {
          toolchain: {
            ...options.toolchain,
            role: "submission-runtime" as const,
          },
        }
      : {}),
    limits: {
      ...DEFAULT_EXECUTOR_LIMITS.submission,
      wallTimeMs: Math.max(1, options.timeLimitMs),
      memoryBytes: options.memoryBytes,
    },
  };
}

interface CheckerExecutorRunSpecOptions {
  runId: string;
  workspaceId: string;
  executableId: string;
  args: string[];
  environment: Record<string, string>;
  runtimeBacked: boolean;
  timeoutMs: number;
  memoryBytes: number;
  stdoutFile?: string;
  stderrFile?: string;
  toolchain?: ExecutorToolchainIdentity;
}

/**
 * Runtime-backed checkers execute a receipt-verified managed interpreter/runtime from the protected
 * toolchain cache. Native checker artifacts retain the stricter checker role. Keeping
 * this distinction in the typed protocol prevents an environment marker from weakening
 * an arbitrary native checker launch.
 */
export function buildCheckerExecutorRunSpec(
  options: CheckerExecutorRunSpecOptions,
): ExecutorRunSpec {
  return {
    runId: options.runId,
    role: options.runtimeBacked ? "checker-runtime" : "checker",
    workspaceId: options.workspaceId,
    executableId: options.executableId,
    args: options.args,
    stdoutFile: options.stdoutFile ?? "checker.stdout",
    stderrFile: options.stderrFile ?? "checker.stderr",
    environment: options.environment,
    ...(options.toolchain
      ? {
          toolchain: {
            ...options.toolchain,
            role: "checker-runtime" as const,
          },
        }
      : {}),
    limits: {
      ...DEFAULT_EXECUTOR_LIMITS.checker,
      wallTimeMs: options.timeoutMs,
      memoryBytes: options.memoryBytes,
      outputBytes: CHECKER_OUTPUT_LIMIT_BYTES,
    },
  };
}
