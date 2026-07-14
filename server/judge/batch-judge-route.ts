import fs from "fs";
import path from "path";
import type { Express } from "express";
import { activeJobs } from "../jobs.js";
import { sandbox } from "../sandbox.js";
import { createJudgeEventWriter } from "./judge-event-writer.js";
import { runJudgeSession } from "./judge-session.js";
import { createRunWorkspace } from "./run-workspace.js";
import { assertCppCompilerAvailable } from "./toolchain.js";

export function registerBatchJudgeRoute(app: Express): void {
  // Batch Judge Endpoint
  app.post("/api/batch-judge", async (req, res) => {
    const events = createJudgeEventWriter(res);
    const { thisinhPath, testPath, jobId } = req.body;
    const sendEvent = events.send;
    if (jobId) activeJobs.set(jobId, { cancel: false });

    if (!thisinhPath || !testPath) {
      if (jobId) activeJobs.delete(jobId);
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

    // Prepare temp space for compiling contestant solutions
    const workspace = createRunWorkspace();
    const tempDir = workspace.path;

    try {
      assertCppCompilerAvailable(tempDir);
    } catch {
      workspace.dispose();
      const location = sandbox.mode === "none" ? "" : " inside the sandbox";
      res.status(400).json({ success: false, message: `g++ compiler is not available${location}.` });
      return;
    }

    try {
      await runJudgeSession({
        request: req.body,
        contestantsDirectory: resolvedThisinh,
        testDirectory: resolvedTest,
        tempDirectory: tempDir,
        events
      });
      sendEvent("done", { success: true });
    } catch (error) {
      sendEvent("error", { message: error instanceof Error ? error.message : String(error) });
    } finally {
      workspace.dispose();
      if (jobId) activeJobs.delete(jobId);
      events.end();
    }
  });

}
