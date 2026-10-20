import type { Express } from "express";
import { selectDirectory } from "../platform/directory-picker.js";
import { getHostStatus } from "../platform/host-status.js";
import { cancelAllActiveJudgeJobs } from "../jobs.js";
import { serverLifecycle } from "../platform/server-lifecycle.js";
import { executorClient } from "../executor/client.js";
import { getJudgeDeskDistribution } from "../distribution.js";

export const ACTIVE_JUDGE_DRAIN_TIMEOUT_MS = 4_000;

export interface ServerShutdownDependencies {
  beginDrain(): void;
  cancelActiveJudgeJobs(): number;
  waitForJudgeSessionsToFinish(timeoutMs: number): Promise<boolean>;
  activeJudgeSessionCount(): number;
  shutdownExecutor(): Promise<void>;
  drainLifecycle?: (timeoutMs: number) => Promise<void>;
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
    drainLifecycle: (timeoutMs) => serverLifecycle.drain(timeoutMs),
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
    if (dependencies.drainLifecycle) {
      await dependencies.drainLifecycle(dependencies.drainTimeoutMs);
      return { ok: true };
    }
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
    const message = error instanceof Error ? error.message : String(error);
    const subMessages =
      error instanceof AggregateError
        ? error.errors.map((e: unknown) => (e instanceof Error ? e.message : String(e)))
        : [message];
    const onlySessionDrainTimeout =
      subMessages.length > 0
      && subMessages.every((msg) => msg.includes("active judging session(s)"));
    const activeCount = dependencies.activeJudgeSessionCount();
    if (activeCount > 0 && onlySessionDrainTimeout) {
      return {
        ok: false,
        code: "JUDGE_DRAIN_TIMEOUT",
        message:
          `Timed out waiting for ${activeCount} active judging session(s) to stop.`,
      };
    }
    return {
      ok: false,
      code: "SERVER_SHUTDOWN_FAILED",
      message,
    };
  }
}

export async function drainServerForProcessExit(
  dependencies: ServerShutdownDependencies = defaultShutdownDependencies(),
): Promise<void> {
  const result = await prepareServerShutdown(dependencies);
  if (result.ok === false) {
    throw new Error(`${result.code}: ${result.message}`);
  }
}

export type DirectoryPickerFn = (defaultPath?: string) => string | null;

export function registerSystemRoutes(
  app: Express,
  shutdownDependencies: ServerShutdownDependencies =
    defaultShutdownDependencies(),
  directoryPicker: DirectoryPickerFn = selectDirectory,
): void {
  app.get("/api/status", (_req, res) => {
    res.json(getHostStatus());
  });

  app.get("/api/distribution", (_req, res) => {
    const rawBundleType = process.env.JUDGEDESK_BUNDLE_TYPE?.trim().toLowerCase();
    const bundleType =
      rawBundleType === "deb" || rawBundleType === "rpm" || rawBundleType === "appimage"
        ? rawBundleType
        : undefined;
    res.json({
      distribution: getJudgeDeskDistribution(),
      platform: process.platform,
      arch: process.arch,
      ...(bundleType ? { bundleType } : {}),
    });
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
      const selectedPath = directoryPicker(defaultPath);
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
