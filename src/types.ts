export interface TestCaseRun {
  name: string;
  status: "AC" | "WA" | "PE" | "TLE" | "RE" | "CE" | "MLE" | "FAIL" | "PARTIAL";
  executionTime: number; // in ms
  peakMemory?: number; // in KB
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
  compileStatus: "OK" | "CE" | "SKIPPED";
  compileError?: string;
  compileTime?: number;
  testCases: TestCaseRun[];
  summary: {
    total: number;
    passed: number;
    score: number;
    maxScore: number;
    status: "AC" | "WA" | "PE" | "TLE" | "RE" | "CE" | "MLE" | "FAIL" | "PENDING" | "PARTIAL";
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

export interface JudgeResult {
  success: boolean;
  language: "cpp" | "python";
  compileTime?: number;
  compileError?: string;
  testCases: TestCaseRun[];
  summary: {
    total: number;
    passed: number;
    status: "AC" | "WA" | "PE" | "TLE" | "RE" | "CE" | "MLE" | "FAIL";
  };
}

export interface PolygonConfig {
  enableGroups: boolean;
  tests: Record<string, { points: number; group?: string; timeLimit?: number }>;
  groups: Record<string, { policy: "EACH_TEST" | "COMPLETE_GROUP"; dependencies: string[] }>;
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
  memoryLimit?: number; // in MB
  polygonConfig?: PolygonConfig;
  checkerType?: string;
}

export interface HostStatus {
  gpp: {
    installed: boolean;
    version: string;
  };
  python: {
    installed: boolean;
    version: string;
  };
  isolate?: {
    installed: boolean;
  };
  tempDir: string;
  platform: string;
  isServerMode: boolean;
}

