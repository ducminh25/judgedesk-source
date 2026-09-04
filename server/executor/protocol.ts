export type ExecutorRole =
  | "submission"
  | "compiler"
  | "checker"
  | "checker-runtime"
  | "security-probe";

export interface ExecutorLimits {
  wallTimeMs: number;
  memoryBytes: number;
  processCount: number;
  threadCount: number;
  outputBytes: number;
  totalWriteBytes: number;
  openFiles: number;
  createdFiles: number;
}

export interface ExecutorToolchainIdentity {
  packageId: string;
  packageDigest: string;
  componentId: string;
}

export interface ExecutorToolchainGrant extends ExecutorToolchainIdentity {
  role: "compiler" | "submission-runtime" | "checker-runtime";
}

export type ExecutorLocalIsolation = "strict" | "resource-only";

/**
 * A user-installed toolchain that remains in place. Unlike a managed grant this
 * carries no package-integrity claim. The native executor canonicalizes the
 * root and executable and applies the requested isolation boundary.
 */
export interface ExecutorLocalToolchainIdentity {
  rootPath: string;
  executableRelativePath: string;
  isolation: ExecutorLocalIsolation;
}

export interface ExecutorLocalToolchainGrant
  extends ExecutorLocalToolchainIdentity {
  role: "compiler" | "submission-runtime" | "checker-runtime";
}

export interface ExecutorRunSpec {
  runId: string;
  role: ExecutorRole;
  workspaceId: string;
  executableId: string;
  args: string[];
  stdinFile?: string;
  stdoutFile: string;
  stderrFile: string;
  environment: Record<string, string>;
  toolchain?: ExecutorToolchainGrant;
  localToolchain?: ExecutorLocalToolchainGrant;
  limits: ExecutorLimits;
}

export type ExecutorRunReason =
  | "exited"
  | "wall_time_limit"
  | "memory_limit"
  | "process_limit"
  | "thread_limit"
  | "output_limit"
  | "write_limit"
  | "cancelled"
  | "sandbox_denied"
  | "launch_error"
  | "internal_error";

export interface ExecutorRunResult {
  runId: string;
  reason: ExecutorRunReason;
  exitCode: number | null;
  signalOrStatus?: string;
  securitySetupTimeUs: number;
  wallTimeUs: number;
  resultCollectionTimeUs: number;
  userCpuTimeUs?: number;
  kernelCpuTimeUs?: number;
  peakMemoryBytes?: number;
  stdoutBytes: number;
  stderrBytes: number;
  createdFiles?: number;
  diagnostic?: string;
}

export interface ExecutorInteractiveRunSpec {
  runId: string;
  submission: ExecutorRunSpec;
  interactor: ExecutorRunSpec;
}

export interface ExecutorInteractiveRunResult {
  runId: string;
  verdict: string;
  scoreMultiplier?: number;
  executionTimeMs: number;
  peakMemoryBytes?: number;
  message?: string;
  transcript?: string;
  submissionResult: ExecutorRunResult;
  interactorResult: ExecutorRunResult;
}

export interface ExecutorHealth {
  ready: boolean;
  mode: "windows-lpac-job" | "macos-seatbelt-native" | "unavailable";
  executorVersion: string;
  executorRoot: string;
  diagnostics: string[];
  networkBlocked: boolean;
  filesystemIsolated: boolean;
  processTreeControlled: boolean;
  memoryLimitSupported: boolean;
  startupTimings?: {
    totalTimeUs: number;
    phases: Record<string, number>;
  };
  clientStartupTimeMs?: number;
}

export type ExecutorRequest =
  | { type: "health"; id: string }
  | { type: "run"; id: string; spec: ExecutorRunSpec }
  | { type: "interactive_run"; id: string; spec: ExecutorInteractiveRunSpec }
  | { type: "cancel"; id: string; runId: string }
  | { type: "shutdown"; id: string };

export type ExecutorResponse =
  | { type: "health"; id: string; health: ExecutorHealth }
  | { type: "run_result"; id: string; result: ExecutorRunResult }
  | { type: "interactive_run_result"; id: string; result: ExecutorInteractiveRunResult }
  | { type: "cancel_result"; id: string; runId: string; cancelled: boolean }
  | { type: "shutdown_result"; id: string }
  | { type: "error"; id: string; code: string; message: string };

export const DEFAULT_EXECUTOR_LIMITS = {
  submission: {
    processCount: 1,
    threadCount: 64,
    outputBytes: 16 * 1024 * 1024,
    totalWriteBytes: 128 * 1024 * 1024,
    openFiles: 64,
    createdFiles: 256,
  },
  compiler: {
    processCount: 8,
    threadCount: 64,
    outputBytes: 4 * 1024 * 1024,
    totalWriteBytes: 128 * 1024 * 1024,
    openFiles: 128,
    createdFiles: 256,
  },
  checker: {
    processCount: 1,
    threadCount: 64,
    outputBytes: 4 * 1024 * 1024,
    totalWriteBytes: 32 * 1024 * 1024,
    openFiles: 64,
    createdFiles: 64,
  },
} as const;
