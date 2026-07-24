import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { executorClient } from "../executor/client.js";
import { DEFAULT_EXECUTOR_LIMITS } from "../executor/protocol.js";
import { createExecutorWorkspace } from "../executor/workspace.js";
import { attachExecutorRun, detachExecutorRun } from "../jobs.js";
import type { TestVerdict } from "../types.js";
import type { ToolchainSource } from "../toolchains/types.js";
import { prepareIsolatedPythonScript } from "./python-runtime.js";
import { runTrustedHostPythonChecker } from "./trusted-python-checker.js";
export { trustedCheckerEnvironment } from "./trusted-python-checker.js";

export interface CustomCheckerResult {
  status: TestVerdict;
  score: number;
  message: string;
}

export interface RunCustomCheckerOptions {
  checkerPath: string;
  checkerRuntime: "native" | "python";
  pythonExecutablePath?: string;
  pythonSource?: ToolchainSource;
  inputPath: string;
  actualOutputPath: string;
  expectedOutputPath: string;
  testDirectory: string;
  tempDirectory: string;
  maxScore: number;
  jobId?: string;
}

const CHECKER_TIMEOUT_MS = 5_000;
const CHECKER_OUTPUT_LIMIT_BYTES = 256 * 1024;

export function parsePartialScore(message: string, stdout: string, maxScore: number): number | null {
  const match = message.match(/result\s*=\s*([0-9.]+)/i)
    || message.match(/points\s*([0-9.]+)/i)
    || message.match(/score\s*:\s*([0-9.]+)/i);
  if (match) {
    const value = parseFloat(match[1]);
    if (!Number.isNaN(value) && value >= 0) return value <= 1 ? value : value / maxScore;
  }
  const lines = stdout.trim().split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const value = parseFloat(lines[lines.length - 1]);
  if (Number.isNaN(value) || value < 0) return null;
  return value <= 1 ? value : value / maxScore;
}

export async function runCustomChecker(options: RunCustomCheckerOptions): Promise<CustomCheckerResult> {
  if (options.checkerRuntime === "python" && options.pythonSource !== "managed") {
    return runTrustedHostPythonChecker(options, checkerResultFromExit);
  }

  const workspace = await createExecutorWorkspace();
  const runId = `checker_${crypto.randomUUID().replaceAll("-", "_")}`;
  attachExecutorRun(options.jobId, runId);
  try {
    const launch = options.checkerRuntime === "python"
      ? await prepareIsolatedPythonScript(workspace, options.checkerPath, "checker.py")
      : prepareNativeChecker(workspace, options.checkerPath);
    workspace.stage(options.inputPath, "input.txt");
    workspace.stage(options.actualOutputPath, "actual.txt");
    workspace.stage(options.expectedOutputPath, "expected.txt");
    const result = await executorClient.run({
      runId,
      role: "checker",
      workspaceId: workspace.id,
      executableId: launch.executableId,
      args: [...launch.args,
        path.join(workspace.path, "input.txt"),
        path.join(workspace.path, "actual.txt"),
        path.join(workspace.path, "expected.txt"),
      ],
      stdoutFile: "checker.stdout",
      stderrFile: "checker.stderr",
      environment: launch.environment,
      limits: {
        ...DEFAULT_EXECUTOR_LIMITS.checker,
        wallTimeMs: CHECKER_TIMEOUT_MS,
        memoryBytes: 256 * 1024 * 1024,
      },
    });
    const stdout = readBounded(path.join(workspace.path, "checker.stdout"));
    const stderr = readBounded(path.join(workspace.path, "checker.stderr"));
    const message = (stdout + stderr).trim();
    if (result.reason !== "exited") {
      return {
        status: "JE",
        score: 0,
        message: [result.reason, result.diagnostic, message].filter(Boolean).join(": "),
      };
    }
    if (result.exitCode === 0) return { status: "AC", score: options.maxScore, message };
    if (result.exitCode === 1) return { status: "WA", score: 0, message };
    if (result.exitCode === 2) return { status: "PE", score: 0, message };
    if (result.exitCode !== 7) return { status: "JE", score: 0, message };
    const multiplier = parsePartialScore(message, stdout, options.maxScore);
    if (multiplier === null || multiplier < 0 || multiplier > 1) {
      return { status: "JE", score: 0, message: message || "Checker returned an invalid partial score." };
    }
    const status = multiplier === 1 ? "AC" : multiplier === 0 ? "WA" : "PARTIAL";
    return {
      status,
      score: Math.round(multiplier * options.maxScore * 10_000) / 10_000,
      message,
    };
  } finally {
    detachExecutorRun(options.jobId, runId);
    workspace.dispose();
  }
}

function checkerResultFromExit(
  exitCode: number,
  message: string,
  stdout: string,
  maxScore: number,
): CustomCheckerResult {
  if (exitCode === 0) return { status: "AC", score: maxScore, message };
  if (exitCode === 1) return { status: "WA", score: 0, message };
  if (exitCode === 2) return { status: "PE", score: 0, message };
  if (exitCode !== 7) return { status: "JE", score: 0, message };
  const multiplier = parsePartialScore(message, stdout, maxScore);
  if (multiplier === null || multiplier < 0 || multiplier > 1) {
    return { status: "JE", score: 0, message: message || "Checker returned an invalid partial score." };
  }
  return {
    status: multiplier === 1 ? "AC" : multiplier === 0 ? "WA" : "PARTIAL",
    score: Math.round(multiplier * maxScore * 10_000) / 10_000,
    message,
  };
}

function prepareNativeChecker(
  workspace: Awaited<ReturnType<typeof createExecutorWorkspace>>,
  checkerPath: string,
): { executableId: string; args: string[]; environment: Record<string, string> } {
  const checkerName = process.platform === "win32" ? "checker.exe" : "checker";
  workspace.stage(checkerPath, checkerName, true);
  return { executableId: workspace.relative(checkerName), args: [], environment: {} };
}

function readBounded(filePath: string): string {
  if (!fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath).subarray(0, 256 * 1024).toString("utf8");
}
