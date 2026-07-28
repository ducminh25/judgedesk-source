import fs from "fs";
import path from "path";
import type { Express } from "express";
import { tryRegisterJudgeJob } from "../jobs.js";
import { createJudgeEventWriter } from "./judge-event-writer.js";
import { runJudgeSession } from "./judge-session.js";
import { createRunWorkspace } from "./run-workspace.js";
import { executorClient } from "../executor/client.js";
import { createRunMetadata } from "../platform/run-metadata.js";
import { serverLifecycle } from "../platform/server-lifecycle.js";
import { SingleJudgeSessionGate } from "./resource-policy.js";

export function registerBatchJudgeRoute(app: Express): void {
  const sessionGate = new SingleJudgeSessionGate();
  // Batch Judge Endpoint
  app.post("/api/batch-judge", async (req, res) => {
    const events = createJudgeEventWriter(res);
    if (!serverLifecycle.acceptsNewJudgeSessions) {
      events.send("error", {
        message: "SERVER_DRAINING: JudgeDesk is preparing to shut down.",
      });
      events.end();
      return;
    }
    const { thisinhPath, testPath, jobId } = req.body;
    const sendEvent = events.send;
    if (!executorClient.health.ready) {
      sendEvent("error", {
        message: `SECURE_RUNNER_UNAVAILABLE: ${executorClient.health.diagnostics.join("; ")}`,
      });
      events.end();
      return;
    }
    if (!thisinhPath || !testPath) {
      res.status(400).json({ success: false, message: "Missing thisinhPath or testPath." });
      return;
    }

    let resolvedThisinh, resolvedTest;
    try {
      resolvedThisinh = path.resolve(thisinhPath);
      resolvedTest = path.resolve(testPath);
      if (!fs.existsSync(resolvedThisinh) || !fs.statSync(resolvedThisinh).isDirectory()) {
        throw new Error(`Contestants directory not found: ${resolvedThisinh}`);
      }
      if (!fs.existsSync(resolvedTest) || !fs.statSync(resolvedTest).isDirectory()) {
        throw new Error(`Testcases directory not found: ${resolvedTest}`);
      }
    } catch (err: any) {
      sendEvent("error", { message: err.message });
      events.end();
      return;
    }

    if (!sessionGate.tryAcquire()) {
      sendEvent("error", { message: "JUDGE_BUSY: another judging session is already running." });
      events.end();
      return;
    }
    const registration = tryRegisterJudgeJob(jobId);
    if (registration.accepted === false) {
      sessionGate.release();
      const messages = {
        draining: "SERVER_DRAINING: JudgeDesk is preparing to shut down.",
        duplicate: "JUDGE_JOB_ID_CONFLICT: this judging job is already active.",
        cancelled: "JUDGE_CANCELLED: cancellation arrived before this judging request.",
        invalid: "JUDGE_JOB_ID_INVALID: jobId must be a string no longer than 256 characters.",
      } as const;
      const message = messages[registration.reason];
      sendEvent("error", { message });
      events.end();
      return;
    }

    let workspace: ReturnType<typeof createRunWorkspace> | undefined;
    try {
      res.setHeader("X-JudgeDesk-Job-Id", registration.jobId);
      sendEvent("metadata", createRunMetadata());
      workspace = createRunWorkspace();
      await runJudgeSession({
        request: {
          ...req.body,
          jobId: registration.jobId,
        },
        contestantsDirectory: resolvedThisinh,
        testDirectory: resolvedTest,
        tempDirectory: workspace.path,
        events
      });
      sendEvent("done", { success: true });
    } catch (error) {
      sendEvent("error", { message: error instanceof Error ? error.message : String(error) });
    } finally {
      workspace?.dispose();
      registration.finish();
      sessionGate.release();
      events.end();
    }
  });

}
