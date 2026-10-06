import crypto from "node:crypto";
import type { Express } from "express";
import { executorClient } from "./executor/client.js";
import { logJudgeDiagnostic } from "./diagnostics.js";
import type {
  ExecutorInteractiveRunResult,
  ExecutorInteractiveRunSpec,
  ExecutorRunResult,
  ExecutorRunSpec,
} from "./executor/protocol.js";
import {
  serverLifecycle,
  type JudgeSessionLease,
  type ServerLifecycle,
} from "./platform/server-lifecycle.js";

export interface ActiveJudgeJob {
  cancel: boolean;
  runIds: Set<string>;
  startedRunIds: Set<string>;
}

export type JudgeJobRegistration =
  | {
      accepted: true;
      jobId: string;
      job: ActiveJudgeJob;
      finish(): void;
    }
  | {
      accepted: false;
      reason: "draining" | "duplicate" | "invalid" | "cancelled";
    };

export interface JudgeJobCancellation {
  found: boolean;
  pending: boolean;
  accepted: boolean;
  failedRunCancellations: number;
}

type CancelExecutorRun = (runId: string) => Promise<boolean>;
type CreateJobId = () => string;
type Clock = () => number;

export interface JudgeJobRegistryOptions {
  pendingCancelTtlMs?: number;
  maxPendingCancels?: number;
  now?: Clock;
}

const DEFAULT_PENDING_CANCEL_TTL_MS = 60_000;
const DEFAULT_MAX_PENDING_CANCELS = 1_024;

export class JudgeJobCancelledError extends Error {
  constructor() {
    super("JUDGE_CANCELLED: the judging session is shutting down");
    this.name = "JudgeJobCancelledError";
  }
}

export class JudgeJobRegistry {
  readonly activeJobs = new Map<string, ActiveJudgeJob>();
  private readonly cancellationRequests =
    new WeakMap<ActiveJudgeJob, Map<string, Promise<boolean>>>();
  private readonly pendingCancellations = new Map<string, number>();
  private readonly pendingCancelTtlMs: number;
  private readonly maxPendingCancels: number;
  private readonly now: Clock;

  constructor(
    private readonly lifecycle: ServerLifecycle,
    private readonly cancelExecutorRun: CancelExecutorRun,
    private readonly createJobId: CreateJobId = () =>
      `server_${crypto.randomUUID().replaceAll("-", "_")}`,
    options: JudgeJobRegistryOptions = {},
  ) {
    this.pendingCancelTtlMs =
      options.pendingCancelTtlMs ?? DEFAULT_PENDING_CANCEL_TTL_MS;
    this.maxPendingCancels =
      options.maxPendingCancels ?? DEFAULT_MAX_PENDING_CANCELS;
    this.now = options.now ?? Date.now;
  }

  tryRegister(requestedJobId: unknown): JudgeJobRegistration {
    const normalized = normalizeRequestedJobId(requestedJobId);
    if (normalized.kind === "invalid") {
      return { accepted: false, reason: "invalid" };
    }

    let jobId = normalized.jobId;
    if (!jobId) {
      do {
        jobId = this.createJobId();
      } while (
        this.activeJobs.has(jobId) ||
        this.hasPendingCancellation(jobId)
      );
    } else {
      if (this.hasPendingCancellation(jobId)) {
        return { accepted: false, reason: "cancelled" };
      }
      if (this.activeJobs.has(jobId)) {
        return { accepted: false, reason: "duplicate" };
      }
    }

    const admission = this.lifecycle.tryStartJudgeSession(jobId);
    if (admission.accepted === false) {
      return { accepted: false, reason: admission.reason };
    }

    const job: ActiveJudgeJob = {
      cancel: false,
      runIds: new Set(),
      startedRunIds: new Set(),
    };
    this.activeJobs.set(jobId, job);
    this.cancellationRequests.set(job, new Map());
    return this.createRegistration(jobId, job, admission.lease);
  }

  attachExecutorRun(jobId: string | undefined, runId: string): void {
    if (!jobId) return;
    const job = this.activeJobs.get(jobId);
    if (!job) throw new JudgeJobCancelledError();
    if (job.cancel) throw new JudgeJobCancelledError();
    job.runIds.add(runId);
  }

  startExecutorRun(jobId: string | undefined, runId: string): void {
    if (!jobId) return;
    const job = this.activeJobs.get(jobId);
    if (!job || job.cancel || !job.runIds.has(runId)) {
      throw new JudgeJobCancelledError();
    }
    job.startedRunIds.add(runId);
  }

  completeExecutorRun(jobId: string | undefined, runId: string): void {
    if (!jobId) return;
    const job = this.activeJobs.get(jobId);
    if (!job) return;
    job.startedRunIds.delete(runId);
    this.cancellationRequests.get(job)?.delete(runId);
  }

  detachExecutorRun(jobId: string | undefined, runId: string): void {
    if (!jobId) return;
    const job = this.activeJobs.get(jobId);
    if (!job) return;
    job.runIds.delete(runId);
    job.startedRunIds.delete(runId);
    this.cancellationRequests.get(job)?.delete(runId);
  }

  async cancelJob(jobId: unknown): Promise<JudgeJobCancellation> {
    const normalized = normalizeRequestedJobId(jobId);
    if (normalized.kind !== "valid") {
      return {
        found: false,
        pending: false,
        accepted: false,
        failedRunCancellations: 0,
      };
    }
    const job = this.activeJobs.get(normalized.jobId);
    if (!job) {
      const pending = this.recordPendingCancellation(normalized.jobId);
      return {
        found: false,
        pending,
        accepted: pending,
        failedRunCancellations: 0,
      };
    }

    job.cancel = true;
    const requests = [...job.startedRunIds].map((runId) =>
      this.requestExecutorCancellation(job, runId),
    );
    const settled = await Promise.allSettled(requests);
    return {
      found: true,
      pending: false,
      accepted: true,
      failedRunCancellations: settled.filter(
        (result) => result.status === "rejected" || !result.value,
      ).length,
    };
  }

  cancelAllActiveJobs(): number {
    const jobs = [...this.activeJobs.values()];
    // Mark every handler first. No await or promise callback can observe a
    // partially draining registry in this event-loop turn.
    for (const job of jobs) job.cancel = true;
    for (const job of jobs) {
      for (const runId of job.startedRunIds) {
        void this.requestExecutorCancellation(job, runId).catch(() => {
          // The bounded lifecycle wait decides whether shutdown can continue.
        });
      }
    }
    return jobs.length;
  }

  private createRegistration(
    jobId: string,
    job: ActiveJudgeJob,
    sessionLease: JudgeSessionLease,
  ): Extract<JudgeJobRegistration, { accepted: true }> {
    let finished = false;
    return {
      accepted: true,
      jobId,
      job,
      finish: () => {
        if (finished) return;
        finished = true;
        if (this.activeJobs.get(jobId) === job) {
          this.activeJobs.delete(jobId);
        }
        sessionLease.finish();
      },
    };
  }

  private requestExecutorCancellation(
    job: ActiveJudgeJob,
    runId: string,
  ): Promise<boolean> {
    const requests = this.cancellationRequests.get(job);
    const existing = requests?.get(runId);
    if (existing) return existing;

    let request: Promise<boolean>;
    try {
      request = this.cancelExecutorRun(runId);
    } catch (error) {
      request = Promise.reject(error);
    }
    requests?.set(runId, request);
    return request;
  }

  private hasPendingCancellation(jobId: string): boolean {
    this.prunePendingCancellations();
    return this.pendingCancellations.has(jobId);
  }

  private recordPendingCancellation(jobId: string): boolean {
    this.prunePendingCancellations();
    if (this.pendingCancellations.has(jobId)) {
      this.pendingCancellations.set(
        jobId,
        this.now() + this.pendingCancelTtlMs,
      );
      return true;
    }
    if (this.pendingCancellations.size >= this.maxPendingCancels) return false;
    this.pendingCancellations.set(
      jobId,
      this.now() + this.pendingCancelTtlMs,
    );
    return true;
  }

  private prunePendingCancellations(): void {
    const now = this.now();
    for (const [jobId, expiresAt] of this.pendingCancellations) {
      if (expiresAt <= now) this.pendingCancellations.delete(jobId);
    }
  }
}

function normalizeRequestedJobId(
  requestedJobId: unknown,
): { kind: "missing"; jobId: null } | { kind: "valid"; jobId: string } | {
  kind: "invalid";
  jobId: null;
} {
  if (requestedJobId === undefined || requestedJobId === null || requestedJobId === "") {
    return { kind: "missing", jobId: null };
  }
  if (typeof requestedJobId !== "string") {
    return { kind: "invalid", jobId: null };
  }
  const jobId = requestedJobId.trim();
  if (jobId.length === 0) return { kind: "missing", jobId: null };
  if (jobId.length > 256) return { kind: "invalid", jobId: null };
  return { kind: "valid", jobId };
}

const judgeJobRegistry = new JudgeJobRegistry(
  serverLifecycle,
  (runId) => executorClient.cancel(runId),
);

export const activeJobs = judgeJobRegistry.activeJobs;

export function tryRegisterJudgeJob(jobId: unknown): JudgeJobRegistration {
  return judgeJobRegistry.tryRegister(jobId);
}

export function attachExecutorRun(
  jobId: string | undefined,
  runId: string,
): void {
  judgeJobRegistry.attachExecutorRun(jobId, runId);
}

export function detachExecutorRun(
  jobId: string | undefined,
  runId: string,
): void {
  judgeJobRegistry.detachExecutorRun(jobId, runId);
}

export function runReservedExecutor(
  jobId: string | undefined,
  spec: ExecutorRunSpec,
): Promise<ExecutorRunResult> {
  logJudgeDiagnostic({ phase: "job-native-run", jobId, runId: spec.runId, role: spec.role });
  return executorClient.run(
    spec,
    () => judgeJobRegistry.startExecutorRun(jobId, spec.runId),
  ).finally(() => {
    judgeJobRegistry.completeExecutorRun(jobId, spec.runId);
  });
}

export function runReservedInteractiveExecutor(
  jobId: string | undefined,
  spec: ExecutorInteractiveRunSpec,
): Promise<ExecutorInteractiveRunResult> {
  logJudgeDiagnostic({ phase: "job-interactive-run", jobId, runId: spec.runId,
    submissionRunId: spec.submission.runId, interactorRunId: spec.interactor.runId });
  return executorClient.runInteractive(
    spec,
    () => judgeJobRegistry.startExecutorRun(jobId, spec.runId),
  ).finally(() => {
    judgeJobRegistry.completeExecutorRun(jobId, spec.runId);
  });
}

export function cancelAllActiveJudgeJobs(): number {
  return judgeJobRegistry.cancelAllActiveJobs();
}

export function registerJobRoutes(app: Express): void {
  app.post("/api/batch-judge/cancel", async (req, res) => {
    const result = await judgeJobRegistry.cancelJob(req.body?.jobId);
    if (!result.accepted) {
      return res.status(503).json({
        success: false,
        message: "JUDGE_CANCEL_REGISTRY_FULL_OR_INVALID",
      });
    }
    if (result.pending) {
      return res.json({
        success: true,
        pending: true,
        message: "Cancellation registered before judging job admission.",
      });
    }
    if (result.failedRunCancellations > 0) {
      return res.status(500).json({
        success: false,
        message: "EXECUTOR_CANCEL_NOT_CONFIRMED",
      });
    }
    return res.json({ success: true });
  });
}
