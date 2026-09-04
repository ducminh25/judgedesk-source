import fs from "fs";
import path from "path";
import crypto from "node:crypto";
import type { Express } from "express";
import { tryRegisterJudgeJob } from "../jobs.js";
import { createJudgeEventWriter } from "./judge-event-writer.js";
import { runJudgeSession } from "./judge-session.js";
import { resolveCompilationToolchain } from "./compiler.js";
import { createRunWorkspace } from "./run-workspace.js";
import { executorClient } from "../executor/client.js";
import { createRunMetadata } from "../platform/run-metadata.js";
import { serverLifecycle } from "../platform/server-lifecycle.js";
import { SingleJudgeSessionGate, sharedJudgeSessionGate } from "./resource-policy.js";
import { toolchainMaintenanceGate } from "../toolchains/maintenance-gate.js";
import { listRegisteredLanguageProfiles } from "../languages/registry.js";
import type { PinnedJudgeToolchains } from "./toolchain-preflight.js";

export function registerBatchJudgeRoute(app: Express): void {
  const sessionGate = sharedJudgeSessionGate;
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
    if (toolchainMaintenanceGate.active) {
      events.send("error", {
        message: "TOOLCHAIN_MAINTENANCE_ACTIVE: wait for compiler/runtime verification to finish.",
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
    const toolchainJudgeLease = toolchainMaintenanceGate.tryAcquireJudge(
      `judge-${crypto.randomUUID()}`,
    );
    if (!toolchainJudgeLease) {
      sessionGate.release();
      sendEvent("error", {
        message: "TOOLCHAIN_MAINTENANCE_ACTIVE: wait for compiler/runtime verification to finish.",
      });
      events.end();
      return;
    }
    const registration = tryRegisterJudgeJob(jobId);
    if (registration.accepted === false) {
      toolchainJudgeLease.finish();
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
      sendEvent("progress", {
        contestant: "",
        problem: "",
        action: "progress.initializing",
        percent: 0,
      });
      workspace = createRunWorkspace();
      const pinnedEntries = await Promise.all(
        listRegisteredLanguageProfiles().map(async (entry) => [
          entry.toolchainKind,
          Object.freeze(
            await resolveCompilationToolchain(entry.toolchainKind),
          ),
        ] as const),
      );
      const pinnedToolchains = Object.freeze(
        Object.fromEntries(pinnedEntries),
      ) as PinnedJudgeToolchains;
      sendEvent("metadata", createRunMetadata(pinnedToolchains));
      await runJudgeSession({
        request: {
          ...req.body,
          jobId: registration.jobId,
        },
        contestantsDirectory: resolvedThisinh,
        testDirectory: resolvedTest,
        tempDirectory: workspace.path,
        events,
        pinnedToolchains,
      });
      sendEvent("done", { success: true });
    } catch (error) {
      sendEvent("error", { message: error instanceof Error ? error.message : String(error) });
    } finally {
      workspace?.dispose();
      registration.finish();
      toolchainJudgeLease.finish();
      sessionGate.release();
      events.end();
    }
  });

}
