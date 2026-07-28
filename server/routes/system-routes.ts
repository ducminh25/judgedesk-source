import type { Express } from "express";
import { selectDirectory } from "../platform/directory-picker.js";
import { getHostStatus } from "../platform/host-status.js";
import { cancelAllActiveJudgeJobs } from "../jobs.js";
import { serverLifecycle } from "../platform/server-lifecycle.js";
import { executorClient } from "../executor/client.js";

export const ACTIVE_JUDGE_DRAIN_TIMEOUT_MS = 4_000;

export interface ServerShutdownDependencies {
  beginDrain(): void;
  cancelActiveJudgeJobs(): number;
  waitForJudgeSessionsToFinish(timeoutMs: number): Promise<boolean>;
  activeJudgeSessionCount(): number;
  shutdownExecutor(): Promise<void>;
  scheduleProcessExit(): void;
  drainTimeoutMs: number;
}

export type ServerShutdownResult =
  | { ok: true }
  | {
      ok: false;
      code: "JUDGE_DRAIN_TIMEOUT" | "SERVER_SHUTDOWN_FAILED";
      message: string;
    };

function defaultShutdownDependencies(): ServerShutdownDependencies {
  return {
    beginDrain: () => serverLifecycle.beginDrain(),
    cancelActiveJudgeJobs: () => cancelAllActiveJudgeJobs(),
    waitForJudgeSessionsToFinish: (timeoutMs) =>
      serverLifecycle.waitForJudgeSessionsToFinish(timeoutMs),
    activeJudgeSessionCount: () => serverLifecycle.activeJudgeSessionCount,
    shutdownExecutor: () => executorClient.shutdown(),
    scheduleProcessExit: () => {
      setTimeout(() => process.exit(0), 50);
    },
    drainTimeoutMs: ACTIVE_JUDGE_DRAIN_TIMEOUT_MS,
  };
}

export async function prepareServerShutdown(
  dependencies: ServerShutdownDependencies,
): Promise<ServerShutdownResult> {
  try {
    dependencies.beginDrain();
    dependencies.cancelActiveJudgeJobs();
    const drained = await dependencies.waitForJudgeSessionsToFinish(
      dependencies.drainTimeoutMs,
    );
    if (!drained) {
      return {
        ok: false,
        code: "JUDGE_DRAIN_TIMEOUT",
        message:
          `Timed out waiting for ${dependencies.activeJudgeSessionCount()} active judging session(s) to stop.`,
      };
    }
    await dependencies.shutdownExecutor();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      code: "SERVER_SHUTDOWN_FAILED",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function registerSystemRoutes(
  app: Express,
  shutdownDependencies: ServerShutdownDependencies =
    defaultShutdownDependencies(),
): void {
  app.get("/api/status", (_req, res) => {
    res.json(getHostStatus());
  });

  app.post("/api/shutdown", async (_req, res) => {
    const result = await prepareServerShutdown(shutdownDependencies);
    if (result.ok === false) {
      return res.status(503).json({
        success: false,
        code: result.code,
        message: result.message,
      });
    }
    res.json({ success: true });
    shutdownDependencies.scheduleProcessExit();
  });

  app.post("/api/select-directory", (req, res) => {
    try {
      const { defaultPath } = req.body;
      const selectedPath = selectDirectory(defaultPath);
      console.log("[SelectDirectory] Path selected:", selectedPath);
      if (selectedPath === null) {
        res.json({ success: false, error: "Canceled" });
      } else {
        res.json({ success: true, path: selectedPath });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[SelectDirectory] Picker error:", message);
      res.json({ success: false, error: message });
    }
  });
}
