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
import { compareRational as compareScore, createRational, divideRational, multiplyRational, parseRational, rationalToNumber, rationalToRoundedNumber, type Rational } from "../../shared/rational.js";

export interface CustomCheckerResult {
  status: TestVerdict;
  score: number;
  scoreExact?: Rational;
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
  maxScoreExact?: Rational;
  jobId?: string;
  problemName?: string;
  inputFileName?: string;
  outputFileName?: string;
}

const CHECKER_TIMEOUT_MS = 5_000;
const CHECKER_MEMORY_BYTES = 256 * 1024 * 1024;

export function parsePartialScore(message: string, stdout: string, maxScore: number): number | null {
  const maximum = parseRational(maxScore);
  const multiplier = parsePartialMultiplier(message, stdout, maximum);
  return multiplier === null ? null : rationalToNumber(multiplier);
}

export function parsePartialAward(message: string, stdout: string, maximum: Rational): Rational | null {
  const multiplier = parsePartialMultiplier(message, stdout, maximum);
  return multiplier === null ? null : multiplyRational(multiplier, maximum);
}

function parsePartialMultiplier(message: string, stdout: string, maximum: Rational): Rational | null {
  const toMultiplier = (value: Rational): Rational | null => compareScore(value, createRational(1)) <= 0
    ? value : BigInt(maximum.n) === 0n ? null : divideRational(value, maximum);
  const match = message.match(/result\s*=\s*([0-9.]+)/i)
    || message.match(/points\s*([0-9.]+)/i)
    || message.match(/score\s*:\s*([0-9.]+)/i);
  if (match) {
    if (/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(match[1])) {
      const value = parseRational(match[1]);
      return toMultiplier(value);
    }
  }
  const lines = stdout.trim().split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const text = lines[lines.length - 1];
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return null;
  const value = parseRational(text);
  return toMultiplier(value);
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
      options.maxScoreExact,
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
  maxScoreExact?: Rational,
): CustomCheckerResult {
  const maximum = maxScoreExact ?? parseRational(maxScore);
  const exactField = (award: Rational) => maxScoreExact === undefined ? {} : { scoreExact: award };
  if (exitCode === 0) {
    const stdoutLines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (stdoutLines.length > 0) {
      const lastLine = stdoutLines[stdoutLines.length - 1];
      if (/^[+-]?\d+(?:\.\d+)?$/.test(lastLine)) {
        const rawScore = parseRational(lastLine);
        if (compareScore(rawScore, createRational(0)) >= 0) {
          const rawMultiplier = compareScore(rawScore, createRational(1)) <= 0 ? rawScore
            : BigInt(maximum.n) === 0n ? createRational(0) : divideRational(rawScore, maximum);
          const multiplier = compareScore(rawMultiplier, createRational(1)) > 0 ? createRational(1) : rawMultiplier;
          const award = multiplyRational(multiplier, maximum);
          const actualScore = rationalToRoundedNumber(award, 4);
          const status = compareScore(multiplier, createRational(1)) === 0 ? "AC" : BigInt(multiplier.n) === 0n ? "WA" : "PARTIAL";
          const feedbackMessage = stdoutLines.length > 1 ? stdoutLines.slice(0, -1).join("\n") : message;
          return {
            status,
            score: actualScore,
            ...exactField(award),
            message: feedbackMessage || (status === "AC" ? "OK" : "Checker returned score"),
          };
        }
      }
    }
    return { status: "AC", score: maxScore, message, ...exactField(maximum) };
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
  const multiplier = parsePartialMultiplier(message, stdout, maximum);
  if (multiplier === null || compareScore(multiplier, createRational(0)) < 0 || compareScore(multiplier, createRational(1)) > 0) {
    return { status: "JE", score: 0, message: message || "Checker returned an invalid partial score." };
  }
  const award = multiplyRational(multiplier, maximum);
  return {
    status: compareScore(multiplier, createRational(1)) === 0 ? "AC" : BigInt(multiplier.n) === 0n ? "WA" : "PARTIAL",
    score: rationalToRoundedNumber(award, 4),
    ...exactField(award),
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
