import type { ChildProcess } from "child_process";
import type { Express } from "express";
import treeKill from "tree-kill";

export interface ActiveJudgeJob {
  cancel: boolean;
  childProcess?: ChildProcess;
}

export const activeJobs = new Map<string, ActiveJudgeJob>();

export function registerJobRoutes(app: Express): void {
  app.post("/api/batch-judge/cancel", (req, res) => {
    const { jobId } = req.body;
    const job = activeJobs.get(jobId);
    if (!job) {
      return res.json({ success: false, message: "Job not found" });
    }

    job.cancel = true;
    if (job.childProcess) {
      try {
        if (job.childProcess.pid) {
          treeKill(job.childProcess.pid, "SIGKILL");
        } else {
          job.childProcess.kill("SIGKILL");
        }
      } catch {}
    }
    return res.json({ success: true });
  });
}
