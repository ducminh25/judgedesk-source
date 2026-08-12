export type TestVerdict = "AC" | "WA" | "PE" | "TLE" | "RE" | "CE" | "MLE" | "OLE" | "JE" | "FAIL" | "PARTIAL";
export type ProblemVerdict = TestVerdict | "PENDING";
export type CompileStatus = "OK" | "CE" | "SKIPPED";
export type SubmissionLanguage =
  | "cpp"
  | "c"
  | "python"
  | "pascal"
  | "go"
  | "java"
  | "rust"
  | "javascript"
  | "csharp";

export interface TestExecutionDiagnostics {
  reason:
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
  exitCode: number | null;
  signalOrStatus?: string;
  securitySetupTimeUs: number;
  wallTimeUs: number;
  resultCollectionTimeUs: number;
  userCpuTimeUs?: number;
  kernelCpuTimeUs?: number;
  peakMemoryBytes?: number;
  configuredMemoryLimitBytes?: number;
  effectiveMemoryLimitBytes?: number;
  stdoutBytes: number;
  stderrBytes: number;
  createdFiles?: number;
  diagnostic?: string;
}

export interface TestCaseRun {
  name: string;
  status: TestVerdict;
  executionTime: number;
  peakMemory?: number;
  score: number;
  checkerMessage?: string;
  inputPreview?: string;
  expectedOutputPreview?: string;
  actualOutputPreview?: string;
  errorDetail?: string;
  execution?: TestExecutionDiagnostics;
}

export interface ProblemResult {
  problemName: string;
  language: string;
  compileStatus: CompileStatus;
  compileError?: string;
  compileTime?: number;
  testCases: TestCaseRun[];
  summary: {
    total: number;
    passed: number;
    score: number;
    maxScore: number;
    status: ProblemVerdict;
  };
}

export interface ContestantResult {
  contestantName: string;
  problems: ProblemResult[];
}

export interface BuildMetadata {
  appVersion: string;
  gitCommit: string;
  buildNumber: string;
  builtAt: string;
}

export interface RunMetadata {
  startedAt: string;
  platform: string;
  arch: string;
  build: BuildMetadata;
  executor: {
    mode: string;
    version: string;
    ready: boolean;
  };
  toolchains: {
    cpp: {
      source: string;
      version: string;
      submissionReady: boolean;
      checkerReady?: boolean;
      provenance?: string;
      certificateId?: string;
      candidateFingerprint?: string;
      snapshotDigest?: string;
    };
    python: {
      source: string;
      version: string;
      submissionReady: boolean;
      checkerReady: boolean;
    };
  };
}

export interface BatchJudgeResult {
  success: boolean;
  message?: string;
  metadata?: RunMetadata;
  contestants: ContestantResult[];
}

export interface PolygonTestConfig {
  points: number;
  group?: string;
  timeLimit?: number;
}

export interface PolygonGroupConfig {
  policy: "EACH_TEST" | "COMPLETE_GROUP";
  dependencies: string[];
}

export interface PolygonConfig {
  enableGroups: boolean;
  tests: Record<string, PolygonTestConfig>;
  groups: Record<string, PolygonGroupConfig>;
}

export type CompileLanguage = "cpp" | "c";

export type CompileProfile =
  | "themis"
  | "modern_ioi_icpc_2025"
  | "icpc_world_finals"
  | "custom";

export interface CompileFlags {
  cpp: string[];
  c: string[];
}

export interface ProblemCompileConfig {
  schemaVersion: 1;
  profile: CompileProfile;
  flags: CompileFlags;
}

export interface ProblemConfig {
  useStdIO: boolean;
  useStdIn?: boolean;
  useStdOut?: boolean;
  inputFile?: string;
  outputFile?: string;
  totalScore: number | null;
  defaultScore: number;
  testScores: Record<string, number>;
  memoryLimit?: number;
  polygonConfig?: PolygonConfig;
  checkerType?: string;
  compile?: ProblemCompileConfig;
}

export interface NormalizedProblemConfig extends ProblemConfig {
  useStdIn: boolean;
  useStdOut: boolean;
  inputFile: string;
  outputFile: string;
  memoryLimit: number;
  checkerType: string;
  polygonConfig: PolygonConfig;
  compile: ProblemCompileConfig;
}

export interface HostStatus {
  gpp: {
    installed: boolean;
    version: string;
    source?: string;
    managedInstalled?: boolean;
    submissionReady?: boolean;
    checkerReady?: boolean;
    diagnostic?: string;
  };
  python: {
    installed: boolean;
    version: string;
    source?: string;
    managedInstalled?: boolean;
    submissionReady?: boolean;
    checkerReady?: boolean;
    diagnostic?: string;
  };
  isolate?: { installed: boolean };
  tempDir: string;
  platform: string;
  isServerMode: boolean;
  build?: BuildMetadata;
  sandbox?: {
    mode: "wsl" | "docker" | "none";
    ready: boolean;
    wsl: { installed: boolean; ready: boolean };
    docker: { installed: boolean; ready: boolean };
  };
  secureRunner: {
    mode: "windows-lpac-job" | "macos-seatbelt-native" | "unavailable";
    ready: boolean;
    executorVersion: string;
    selfTestAt?: string;
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
  };
}

export interface JudgeProgress {
  contestant: string;
  problem: string;
  action: string;
  percent: number;
}

export interface BatchJudgeRequest {
  thisinhPath: string;
  testPath: string;
  jobId: string;
  problemConfigs: Record<string, ProblemConfig>;
  targetContestants: string[];
  targetProblems: string[];
}

export type JudgeStreamEvent =
  | { type: "metadata"; data: RunMetadata }
  | { type: "progress"; data: JudgeProgress }
  | { type: "problem_completed"; data: { contestant: string; problemResult: ProblemResult } }
  | { type: "done"; data: { success: boolean } }
  | { type: "error"; data: { message: string } };
