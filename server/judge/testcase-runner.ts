import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { executorClient } from "../executor/client.js";
import { DEFAULT_EXECUTOR_LIMITS } from "../executor/protocol.js";
import {
  createExecutorWorkspace,
  importExecutorArtifact,
} from "../executor/workspace.js";
import {
  executorDiagnostic,
  executorDisplayTimeMs,
  executorResultToVerdict,
} from "../executor/verdict-mapper.js";
import { activeJobs, attachExecutorRun, detachExecutorRun } from "../jobs.js";
import type { NormalizedProblemConfig, SubmissionLanguage, TestCaseRun } from "../types.js";
import type { CompiledChecker } from "./compiler.js";
import { runCustomChecker } from "./custom-checker-runner.js";
import { prepareIsolatedPythonScript } from "./python-runtime.js";
import { isBuiltInChecker, runStandardChecker } from "./standard-checkers.js";

interface TestCaseRunnerOptions {
  contestant: string;
  problemName: string;
  testName: string;
  language: SubmissionLanguage;
  submissionPath: string;
  executablePath: string;
  inputPath: string;
  expectedOutputPath: string;
  expectedOutput: string;
  testRoot: string;
  contestantsRoot: string;
  tempDirectory: string;
  pythonCommand: string;
  timeLimitMs: number;
  score: number;
  config: NormalizedProblemConfig;
  checker: CompiledChecker | undefined;
  jobId?: string;
}

const MAX_OUTPUT_SIZE = 16 * 1024 * 1024;
const MAX_STDERR_PREVIEW = 256 * 1024;

export async function runTestCase(options: TestCaseRunnerOptions): Promise<TestCaseRun> {
  const workspace = await createExecutorWorkspace();
  const runId = `submission_${crypto.randomUUID().replaceAll("-", "_")}`;
  attachExecutorRun(options.jobId, runId);
  try {
    const launch = await prepareSubmission(workspace, options);
    const inputFilename = safeWorkspacePath(options.config.inputFile || `${options.problemName}.inp`);
    let stdinFile: string | undefined;
    if (options.config.useStdIn) {
      workspace.stage(options.inputPath, "stdin.txt");
      stdinFile = "stdin.txt";
    } else {
      workspace.stage(options.inputPath, inputFilename);
    }

    const memoryBytes = Math.max(8 * 1024 * 1024, (options.config.memoryLimit || 256) * 1024 * 1024);
    const result = await executorClient.run({
      runId,
      role: "submission",
      workspaceId: workspace.id,
      executableId: launch.executableId,
      args: launch.args,
      stdinFile,
      stdoutFile: "stdout.txt",
      stderrFile: "stderr.txt",
      environment: launch.environment,
      limits: {
        ...DEFAULT_EXECUTOR_LIMITS.submission,
        wallTimeMs: Math.max(1, options.timeLimitMs),
        memoryBytes,
      },
    });
    const stdoutBuffer = readBounded(path.join(workspace.path, "stdout.txt"), MAX_OUTPUT_SIZE);
    const stderr = readBounded(path.join(workspace.path, "stderr.txt"), MAX_STDERR_PREVIEW).toString("utf8");
    let actualOutputBuffer = stdoutBuffer;
    if (!options.config.useStdOut) {
      const outputFilename = safeWorkspacePath(options.config.outputFile);
      actualOutputBuffer = readBounded(path.join(workspace.path, outputFilename), MAX_OUTPUT_SIZE);
    }
    const stdout = actualOutputBuffer.toString("utf8");
    const executionTime = executorDisplayTimeMs(result, options.timeLimitMs);
    const peakMemoryKb = result.peakMemoryBytes ? Math.ceil(result.peakMemoryBytes / 1024) : undefined;
    let status = executorResultToVerdict(result);
    const diagnostic = executorDiagnostic(result, stderr);

    if (result.reason === "cancelled" || (options.jobId && activeJobs.get(options.jobId)?.cancel)) {
      return createResult(options, "FAIL", executionTime, peakMemoryKb, 0, "cancelled", stdout);
    }
    if (status) {
      return createResult(options, status, executionTime, peakMemoryKb, 0, diagnostic, stdout);
    }

    const actualOutputPath = path.join(options.tempDirectory, `actual-${crypto.randomUUID()}.out`);
    fs.writeFileSync(actualOutputPath, actualOutputBuffer);
    try {
      if (isBuiltInChecker(options.config.checkerType)) {
        const checked = runStandardChecker(
          options.config.checkerType,
          fs.readFileSync(options.expectedOutputPath),
          actualOutputBuffer,
        );
        return createResult(
          options,
          checked.status,
          executionTime,
          peakMemoryKb,
          checked.status === "AC" ? options.score : 0,
          checked.status === "AC" ? "" : diagnostic,
          stdout,
          checked.message,
        );
      }
      if (options.checker?.error) {
        return createResult(options, "JE", executionTime, peakMemoryKb, 0, options.checker.error, stdout);
      }
      if (!options.checker?.path || !fs.existsSync(options.checker.path)) {
        return createResult(options, "JE", executionTime, peakMemoryKb, 0, "Custom checker is unavailable.", stdout);
      }
      const checked = await runCustomChecker({
        checkerPath: options.checker.path,
        checkerRuntime: options.checker.runtime || "native",
        inputPath: options.inputPath,
        actualOutputPath,
        expectedOutputPath: options.expectedOutputPath,
        testDirectory: options.testRoot,
        tempDirectory: options.tempDirectory,
        maxScore: options.score,
        jobId: options.jobId,
      });
      status = checked.status;
      return createResult(
        options,
        status,
        executionTime,
        peakMemoryKb,
        status === "AC" || status === "PARTIAL" ? checked.score : 0,
        status === "AC" ? "" : diagnostic,
        stdout,
        checked.message,
      );
    } finally {
      fs.rmSync(actualOutputPath, { force: true });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createResult(options, "JE", 0, undefined, 0, message, "");
  } finally {
    detachExecutorRun(options.jobId, runId);
    workspace.dispose();
  }
}

async function prepareSubmission(
  workspace: Awaited<ReturnType<typeof createExecutorWorkspace>>,
  options: TestCaseRunnerOptions,
): Promise<{ executableId: string; args: string[]; environment: Record<string, string> }> {
  if (options.language === "cpp") {
    const artifact = await importExecutorArtifact(options.executablePath);
    return { executableId: artifact.executableId, args: [], environment: {} };
  }

  return prepareIsolatedPythonScript(
    workspace,
    options.submissionPath,
    "submission.py",
    options.pythonCommand,
  );
}

function createResult(
  options: TestCaseRunnerOptions,
  status: TestCaseRun["status"],
  executionTime: number,
  peakMemory: number | undefined,
  score: number,
  errorDetail: string,
  actualOutput: string,
  checkerMessage?: string,
): TestCaseRun {
  return {
    name: options.testName,
    status,
    executionTime: Math.round(executionTime),
    peakMemory,
    score,
    checkerMessage,
    errorDetail,
    expectedOutputPreview: preview(options.expectedOutput),
    actualOutputPreview: preview(actualOutput),
  };
}

function readBounded(filePath: string, limit: number): Buffer {
  if (!fs.existsSync(filePath)) return Buffer.alloc(0);
  const handle = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(Math.min(limit, fs.fstatSync(handle).size));
    const bytes = fs.readSync(handle, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytes);
  } finally {
    fs.closeSync(handle);
  }
}

function safeWorkspacePath(value: string): string {
  if (!value || path.isAbsolute(value) || value.split(/[\\/]/).some((part) => !part || part === "." || part === "..")) {
    throw new Error("Problem file name is not a safe relative workspace path.");
  }
  return value;
}

function preview(output: string): string {
  return output.substring(0, 500) + (output.length > 500 ? "..." : "");
}
