import type { ProblemResult, SubmissionLanguage } from "../types.js";

export interface OsdConfig {
  osdPath: string;
  contestantsPath: string;
  testPath: string;
  enableLog?: boolean;
  pollIntervalMs?: number;
}

export interface OsdParsedSubmission {
  originalFileName: string;
  contestant: string;
  problem: string;
  extension: string;
  language: SubmissionLanguage;
  valid: boolean;
  errorReason?: string;
}

export type OsdJobStatus = "queued" | "judging" | "completed" | "failed";

export interface OsdJob {
  id: string;
  filePath: string;
  originalFileName: string;
  contestant: string;
  problem: string;
  language: SubmissionLanguage;
  arrivedAt: number;
  status: OsdJobStatus;
  result?: ProblemResult;
  error?: string;
}

export interface OsdStatus {
  active: boolean;
  paused: boolean;
  osdPath: string | null;
  contestantsPath: string | null;
  testPath: string | null;
  enableLog: boolean;
  queueLength: number;
  currentJob: OsdJob | null;
  totalProcessed: number;
  lastProcessedJob: OsdJob | null;
}

export type OsdStreamEvent =
  | { type: "osd_status"; data: OsdStatus }
  | { type: "osd_contestant_added"; data: { contestant: string } }
  | { type: "osd_job_queued"; data: { job: OsdJob; queueLength: number } }
  | { type: "osd_job_started"; data: { job: OsdJob } }
  | {
      type: "osd_problem_completed";
      data: {
        contestant: string;
        problemResult: ProblemResult;
        originalFileName: string;
      };
    }
  | { type: "osd_job_failed"; data: { job: OsdJob; message: string } }
  | { type: "osd_error"; data: { message: string } }
  | { type: "osd_heartbeat"; data: { timestamp: number } };
