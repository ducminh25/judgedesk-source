export type TestVerdict = "AC" | "WA" | "PE" | "TLE" | "RE" | "CE" | "MLE" | "FAIL" | "PARTIAL";
export type ProblemVerdict = TestVerdict | "PENDING";
export type CompileStatus = "OK" | "CE" | "SKIPPED";
export type SubmissionLanguage = "cpp" | "python";

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

export interface BatchJudgeResult {
  success: boolean;
  message?: string;
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
}

export interface NormalizedProblemConfig extends ProblemConfig {
  useStdIn: boolean;
  useStdOut: boolean;
  inputFile: string;
  outputFile: string;
  memoryLimit: number;
  checkerType: string;
  polygonConfig: PolygonConfig;
}

export interface HostStatus {
  gpp: { installed: boolean; version: string };
  python: { installed: boolean; version: string };
  isolate?: { installed: boolean };
  tempDir: string;
  platform: string;
  isServerMode: boolean;
  sandbox?: {
    mode: "wsl" | "docker" | "none";
    ready: boolean;
    wsl: { installed: boolean; ready: boolean };
    docker: { installed: boolean; ready: boolean };
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
  timeLimit: number;
  jobId: string;
  problemConfigs: Record<string, ProblemConfig>;
  targetContestants: string[];
  targetProblems: string[];
}

export type JudgeStreamEvent =
  | { type: "progress"; data: JudgeProgress }
  | { type: "problem_completed"; data: { contestant: string; problemResult: ProblemResult } }
  | { type: "done"; data: { success: boolean } }
  | { type: "error"; data: { message: string } };
