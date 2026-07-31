import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createExecutorWorkspace } from "../executor/workspace.js";
import {
  attachExecutorRun,
  detachExecutorRun,
  runReservedExecutor,
} from "../jobs.js";
import { buildCheckerExecutorRunSpec } from "./execution-request.js";
import { prepareIsolatedPythonRuntime } from "./python-runtime.js";

const CHECKER_TIMEOUT_MS = 5_000;
const CHECKER_MEMORY_BYTES = 256 * 1024 * 1024;
const CHECKER_DIAGNOSTIC_LIMIT_BYTES = 256 * 1024;

/**
 * Validate checker source through the exact receipt-verified managed runtime and sandbox role
 * used for execution. Quick local detection cannot establish a complete, sandbox-readable
 * interpreter support tree, so local/system runtimes are rejected before this point.
 */
export async function validatePythonCheckerSource(
  pythonExecutablePath: string,
  checkerPath: string,
  jobId?: string,
): Promise<void> {
  const workspace = await createExecutorWorkspace();
  const runId = `checker_syntax_${crypto.randomUUID().replaceAll("-", "_")}`;
  try {
    attachExecutorRun(jobId, runId);
    const stagedChecker = workspace.stage(checkerPath, "checker.py");
    const runtime = await prepareIsolatedPythonRuntime(pythonExecutablePath);
    const syntaxCheck = [
      "import pathlib,sys",
      "source=pathlib.Path(sys.argv[1]).read_bytes()",
      "compile(source,sys.argv[1],'exec')",
    ].join(";");
    const result = await runReservedExecutor(jobId, buildCheckerExecutorRunSpec({
      runId,
      workspaceId: workspace.id,
      executableId: runtime.executableId,
      args: ["-I", "-B", "-c", syntaxCheck, stagedChecker],
      environment: runtime.environment,
      toolchain: runtime.toolchain,
      runtimeBacked: true,
      timeoutMs: CHECKER_TIMEOUT_MS,
      memoryBytes: CHECKER_MEMORY_BYTES,
      stdoutFile: "checker-syntax.stdout",
      stderrFile: "checker-syntax.stderr",
    }));
    const stdout = readDiagnostic(path.join(workspace.path, "checker-syntax.stdout"));
    const stderr = readDiagnostic(path.join(workspace.path, "checker-syntax.stderr"));
    if (result.reason !== "exited" || result.exitCode !== 0) {
      throw new Error(
        [result.reason, result.diagnostic, stderr, stdout]
          .filter(Boolean)
          .join(": ") || "Python checker syntax validation failed.",
      );
    }
  } finally {
    detachExecutorRun(jobId, runId);
    workspace.dispose();
  }
}

function readDiagnostic(filePath: string): string {
  if (!fs.existsSync(filePath)) return "";
  return fs
    .readFileSync(filePath)
    .subarray(0, CHECKER_DIAGNOSTIC_LIMIT_BYTES)
    .toString("utf8")
    .trim();
}
