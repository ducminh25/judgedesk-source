import type { Express } from "express";
import { executorClient } from "./executor/client.js";

export interface ActiveJudgeJob {
  cancel: boolean;
  runIds: Set<string>;
}

export const activeJobs = new Map<string, ActiveJudgeJob>();

export function attachExecutorRun(jobId: string | undefined, runId: string): void {
  if (!jobId) return;
  activeJobs.get(jobId)?.runIds.add(runId);
}

export function detachExecutorRun(jobId: string | undefined, runId: string): void {
  if (!jobId) return;
  activeJobs.get(jobId)?.runIds.delete(runId);
}

export function registerJobRoutes(app: Express): void {
  app.post("/api/batch-judge/cancel", async (req, res) => {
    const { jobId } = req.body;
    const job = activeJobs.get(jobId);
    if (!job) return res.json({ success: false, message: "Job not found" });

    job.cancel = true;
    const runIds = [...job.runIds];
    const acknowledgements = await Promise.allSettled(runIds.map((runId) => executorClient.cancel(runId)));
    const failed = acknowledgements.filter((result) => result.status === "rejected");
    if (failed.length > 0) {
      return res.status(500).json({ success: false, message: "EXECUTOR_CANCEL_TIMEOUT" });
    }
    return res.json({ success: true });
  });
}
