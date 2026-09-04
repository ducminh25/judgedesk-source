import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  createExecutorWorkspace,
  importExecutorArtifact,
} from "../executor/workspace.js";
import {
  attachExecutorRun,
  detachExecutorRun,
  runReservedExecutor,
} from "../jobs.js";
import type { TestVerdict } from "../types.js";
import type { ResolvedToolchain } from "../toolchains/types.js";
import { buildCheckerExecutorRunSpec } from "./execution-request.js";
import { prepareIsolatedPythonScript } from "./python-runtime.js";

export interface CustomCheckerResult {
  status: TestVerdict;
  score: number;
  message: string;
}

export interface RunCustomCheckerOptions {
  checkerPath: string;
  checkerRuntime: "native" | "python";
  pythonExecutablePath?: string;
  pythonToolchain?: Readonly<ResolvedToolchain>;
  inputPath: string;
  actualOutputPath: string;
  expectedOutputPath: string;
  maxScore: number;
  jobId?: string;
  problemName?: string;
  inputFileName?: string;
  outputFileName?: string;
}

const CHECKER_TIMEOUT_MS = 5_000;
const CHECKER_MEMORY_BYTES = 256 * 1024 * 1024;

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
  const workspace = await createExecutorWorkspace();
  const runId = `checker_${crypto.randomUUID().replaceAll("-", "_")}`;
  try {
    attachExecutorRun(options.jobId, runId);
    const launch = options.checkerRuntime === "python"
      ? await prepareIsolatedPythonScript(
          workspace,
          options.checkerPath,
          "checker.py",
          options.pythonExecutablePath,
          options.pythonToolchain,
        )
      : await prepareNativeChecker(options.checkerPath);

    // 1. Stage standard Testlib files in workspace root
    workspace.stage(options.inputPath, "input.txt");
    workspace.stage(options.actualOutputPath, "actual.txt");
    workspace.stage(options.expectedOutputPath, "expected.txt");

    // 2. Stage Themis folder hierarchy and filenames inside workspace
    const problemBaseName = options.problemName || "problem";
    const defaultInpName = `${problemBaseName}.INP`;
    const defaultOutName = `${problemBaseName}.OUT`;
    const customInpName = options.inputFileName ? path.basename(options.inputFileName) : defaultInpName;
    const customOutName = options.outputFileName ? path.basename(options.outputFileName) : defaultOutName;
    const actualInpName = path.basename(options.inputPath);
    const actualOutName = path.basename(options.expectedOutputPath);

    const testDir = path.join(workspace.path, "test");
    const workDir = path.join(workspace.path, "work");
    fs.mkdirSync(testDir, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });

    const stageAliases = (source: string, dir: string, names: string[]) => {
      const uniqueNames = new Set(names.filter(Boolean));
      for (const name of uniqueNames) {
        try {
          fs.copyFileSync(source, path.join(dir, name));
        } catch {}
      }
    };

    stageAliases(options.inputPath, testDir, [
      defaultInpName,
      defaultInpName.toLowerCase(),
      customInpName,
      actualInpName,
    ]);
    stageAliases(options.expectedOutputPath, testDir, [
      defaultOutName,
      defaultOutName.toLowerCase(),
      customOutName,
      actualOutName,
    ]);
    stageAliases(options.actualOutputPath, workDir, [
      defaultOutName,
      defaultOutName.toLowerCase(),
      customOutName,
      actualOutName,
    ]);
    stageAliases(options.actualOutputPath, workspace.path, [
      defaultOutName,
      defaultOutName.toLowerCase(),
      customOutName,
      actualOutName,
    ]);

    fs.writeFileSync(
      path.join(workspace.path, "themis.stdin"),
      `${testDir}\n${workDir}\n`,
      "utf8",
    );

    const result = await runReservedExecutor(options.jobId, buildCheckerExecutorRunSpec({
      runId,
      workspaceId: workspace.id,
      executableId: launch.executableId,
      args: [...launch.args,
        path.join(workspace.path, "input.txt"),
        path.join(workspace.path, "actual.txt"),
        path.join(workspace.path, "expected.txt"),
      ],
      stdinFile: "themis.stdin",
      environment: launch.environment,
      toolchain: launch.toolchain,
      localToolchain: launch.localToolchain,
      runtimeBacked: options.checkerRuntime === "python",
      timeoutMs: CHECKER_TIMEOUT_MS,
      memoryBytes: CHECKER_MEMORY_BYTES,
    }));
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
    return checkerResultFromExit(
      result.exitCode ?? -1,
      message,
      stdout,
      options.maxScore,
    );
  } finally {
    detachExecutorRun(options.jobId, runId);
    workspace.dispose();
  }
}

export function checkerResultFromExit(
  exitCode: number,
  message: string,
  stdout: string,
  maxScore: number,
): CustomCheckerResult {
  if (exitCode === 0) {
    const stdoutLines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (stdoutLines.length > 0) {
      const lastLine = stdoutLines[stdoutLines.length - 1];
      if (/^[+-]?\d+(?:\.\d+)?$/.test(lastLine)) {
        const rawScore = parseFloat(lastLine);
        if (!Number.isNaN(rawScore) && rawScore >= 0) {
          const multiplier = rawScore <= 1.0 ? rawScore : (maxScore > 0 ? rawScore / maxScore : 0);
          const clampedMultiplier = Math.max(0, Math.min(1, multiplier));
          const actualScore = Math.round(clampedMultiplier * maxScore * 10_000) / 10_000;
          const status = clampedMultiplier === 1 ? "AC" : clampedMultiplier === 0 ? "WA" : "PARTIAL";
          const feedbackMessage = stdoutLines.length > 1 ? stdoutLines.slice(0, -1).join("\n") : message;
          return {
            status,
            score: actualScore,
            message: feedbackMessage || (status === "AC" ? "OK" : "Checker returned score"),
          };
        }
      }
    }
    return { status: "AC", score: maxScore, message };
  }
  if (exitCode === 1) return { status: "WA", score: 0, message };
  if (exitCode === 2) return { status: "PE", score: 0, message };
  if (exitCode !== 7) {
    return {
      status: "JE",
      score: 0,
      message: message || `Checker exited with code ${exitCode}.`,
    };
  }
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

export async function prepareNativeChecker(
  checkerPath: string,
): Promise<{
  executableId: string;
  args: string[];
  environment: Record<string, string>;
  toolchain?: never;
  localToolchain?: never;
}> {
  const artifact = await importExecutorArtifact(checkerPath);
  return { executableId: artifact.executableId, args: [], environment: {} };
}

function readBounded(filePath: string): string {
  if (!fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath).subarray(0, 256 * 1024).toString("utf8");
}
