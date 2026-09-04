import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ExecutorRunResult } from "../executor/protocol.js";
import {
  createExecutorWorkspace,
  importExecutorArtifact,
} from "../executor/workspace.js";
import {
  executorDiagnostic,
  executorDisplayTimeMs,
  executorResultToVerdict,
} from "../executor/verdict-mapper.js";
import {
  activeJobs,
  attachExecutorRun,
  detachExecutorRun,
  runReservedExecutor,
  runReservedInteractiveExecutor,
} from "../jobs.js";
import type { NormalizedProblemConfig, SubmissionLanguage, TestCaseRun } from "../types.js";
import type { CompiledChecker, CompiledInteractor } from "./compiler.js";
import { parsePartialScore, prepareNativeChecker, runCustomChecker } from "./custom-checker-runner.js";
import { prepareIsolatedPythonScript } from "./python-runtime.js";
import {
  buildCheckerExecutorRunSpec,
  buildSubmissionExecutorRunSpec,
} from "./execution-request.js";
import {
  resolveConfiguredSubmissionMemoryLimitBytes,
  resolveSubmissionMemoryLimitBytes,
} from "./resource-policy.js";
import type { PreparedSubmissionProgram } from "./prepared-program.js";
import { prepareIsolatedNodeScript } from "./node-runtime.js";
import { prepareIsolatedScratchScript } from "./scratch-runtime.js";
import { prepareDirectoryRuntimeProgram } from "./managed-runtime.js";
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
  expectedOutputPreview: string;
  testRoot: string;
  contestantsRoot: string;
  tempDirectory: string;
  pythonCommand: string;
  timeLimitMs: number;
  score: number;
  config: NormalizedProblemConfig;
  checker: CompiledChecker | undefined;
  interactor?: CompiledInteractor;
  program?: PreparedSubmissionProgram;
  jobId?: string;
}

const MAX_OUTPUT_SIZE = 16 * 1024 * 1024;
const MAX_STDERR_PREVIEW = 256 * 1024;

export async function runTestCase(options: TestCaseRunnerOptions): Promise<TestCaseRun> {
  if (options.config.isInteractive) {
    return executeInteractiveTestCase(options);
  }
  const workspace = await createExecutorWorkspace();
  const runId = `submission_${crypto.randomUUID().replaceAll("-", "_")}`;
  try {
    attachExecutorRun(options.jobId, runId);
    const memoryBytes = resolveSubmissionMemoryLimitBytes(
      options.config.memoryLimit,
    );
    const launch = await prepareSubmission(workspace, options, memoryBytes);
    const inputFilename = safeWorkspacePath(options.config.inputFile || `${options.problemName}.inp`);
    let stdinFile: string | undefined;
    if (options.config.useStdIn) {
      workspace.stage(options.inputPath, "stdin.txt");
      stdinFile = "stdin.txt";
    } else {
      workspace.stage(options.inputPath, inputFilename);
    }

    const result = await runReservedExecutor(options.jobId, buildSubmissionExecutorRunSpec({
      runId,
      workspaceId: workspace.id,
      executableId: launch.executableId,
      args: launch.args,
      stdinFile,
      environment: launch.environment,
      toolchain: launch.toolchain,
      localToolchain: launch.localToolchain,
      timeLimitMs: options.timeLimitMs,
      memoryBytes,
    }));
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
      return createResult(options, "FAIL", executionTime, peakMemoryKb, 0, "cancelled", stdout, undefined, result);
    }
    if (status) {
      return createResult(options, status, executionTime, peakMemoryKb, 0, diagnostic, stdout, undefined, result);
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
          result,
        );
      }
      if (options.checker?.error) {
        return createResult(
          options,
          "JE",
          executionTime,
          peakMemoryKb,
          0,
          options.checker.error,
          stdout,
          undefined,
          result,
        );
      }
      if (!options.checker?.path || !fs.existsSync(options.checker.path)) {
        return createResult(
          options,
          "JE",
          executionTime,
          peakMemoryKb,
          0,
          "Custom checker is unavailable.",
          stdout,
          undefined,
          result,
        );
      }
      const checked = await runCustomChecker({
        checkerPath: options.checker.path,
        checkerRuntime: options.checker.runtime || "native",
        pythonExecutablePath: options.checker.pythonExecutablePath,
        pythonToolchain: options.checker.pythonToolchain,
        inputPath: options.inputPath,
        actualOutputPath,
        expectedOutputPath: options.expectedOutputPath,
        maxScore: options.score,
        jobId: options.jobId,
        problemName: options.problemName,
        inputFileName: options.config.inputFile,
        outputFileName: options.config.outputFile,
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
        result,
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
  memoryBytes: number,
): Promise<{
  executableId: string;
  args: string[];
  environment: Record<string, string>;
  toolchain?: import("../executor/protocol.js").ExecutorToolchainIdentity;
  localToolchain?: import("../executor/protocol.js").ExecutorLocalToolchainIdentity;
}> {
  if (options.program?.kind === "native") {
    const artifact = await importExecutorArtifact(options.program.artifactPath);
    return { executableId: artifact.executableId, args: [], environment: {} };
  }
  if (
    options.program?.kind === "script-runtime"
    && options.program.language === "python"
  ) {
    return prepareIsolatedPythonScript(
      workspace,
      options.program.sourcePath,
      options.program.stagedFileName,
      options.program.runtimeToolchain.executionPath
        || options.program.runtimeToolchain.executablePath,
      options.program.runtimeToolchain,
    );
  }
  if (options.program?.kind === "directory-runtime") {
    return prepareDirectoryRuntimeProgram(
      workspace,
      options.program,
      memoryBytes,
    );
  }
  if (
    options.program?.kind === "script-runtime"
    && options.program.language === "javascript"
  ) {
    return prepareIsolatedNodeScript(
      workspace,
      options.program.sourcePath,
      options.program.stagedFileName,
      options.program.runtimeToolchain,
    );
  }
  if (
    options.program?.kind === "script-runtime"
    && options.program.language === "scratch"
  ) {
    return prepareIsolatedScratchScript(
      workspace,
      options.program.sourcePath,
      options.program.stagedFileName,
      options.program.runtimeToolchain,
    );
  }
  if (options.program) {
    throw new Error(
      `LANGUAGE_ADAPTER_UNAVAILABLE: ${options.program.language}`,
    );
  }
  if (options.language === "cpp" || options.language === "c") {
    const artifact = await importExecutorArtifact(options.executablePath);
    return { executableId: artifact.executableId, args: [], environment: {} };
  }

  if (options.language === "python") {
    return prepareIsolatedPythonScript(
      workspace,
      options.submissionPath,
      "submission.py",
      options.pythonCommand,
    );
  }
  throw new Error(`LANGUAGE_ADAPTER_UNAVAILABLE: ${options.language}`);
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
  executorResult?: ExecutorRunResult,
): TestCaseRun {
  return {
    name: options.testName,
    status,
    executionTime: Math.round(executionTime),
    peakMemory,
    score,
    checkerMessage,
    errorDetail,
    expectedOutputPreview: options.expectedOutputPreview,
    actualOutputPreview: preview(actualOutput),
    execution: executorResult ? {
      reason: executorResult.reason,
      exitCode: executorResult.exitCode,
      signalOrStatus: executorResult.signalOrStatus,
      securitySetupTimeUs: executorResult.securitySetupTimeUs,
      wallTimeUs: executorResult.wallTimeUs,
      resultCollectionTimeUs: executorResult.resultCollectionTimeUs,
      userCpuTimeUs: executorResult.userCpuTimeUs,
      kernelCpuTimeUs: executorResult.kernelCpuTimeUs,
      peakMemoryBytes: executorResult.peakMemoryBytes,
      configuredMemoryLimitBytes: resolveConfiguredSubmissionMemoryLimitBytes(options.config.memoryLimit),
      effectiveMemoryLimitBytes: resolveSubmissionMemoryLimitBytes(options.config.memoryLimit),
      stdoutBytes: executorResult.stdoutBytes,
      stderrBytes: executorResult.stderrBytes,
      createdFiles: executorResult.createdFiles,
      diagnostic: executorResult.diagnostic,
    } : undefined,
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

async function executeInteractiveTestCase(
  options: TestCaseRunnerOptions,
): Promise<TestCaseRun> {
  if (!options.interactor || !options.interactor.path) {
    return createResult(
      options,
      "JE",
      0,
      undefined,
      0,
      options.interactor?.error || "Interactor executable not found or compilation failed.",
      "",
      options.interactor?.error || "Interactor missing",
    );
  }

  const workspace = await createExecutorWorkspace();
  const interactorWorkspace = await createExecutorWorkspace();
  const runId = `interactive_${crypto.randomUUID().replaceAll("-", "_")}`;

  try {
    attachExecutorRun(options.jobId, runId);
    const memoryBytes = resolveSubmissionMemoryLimitBytes(options.config.memoryLimit);
    const launch = await prepareSubmission(workspace, options, memoryBytes);

    const interactorLaunch = options.interactor.runtime === "python"
      ? await prepareIsolatedPythonScript(
          interactorWorkspace,
          options.interactor.path,
          "interactor.py",
          options.interactor.pythonExecutablePath,
          options.interactor.pythonToolchain,
        )
      : await prepareNativeChecker(options.interactor.path);

    interactorWorkspace.stage(options.inputPath, "input.txt");
    const interactorArgs = [...interactorLaunch.args, "input.txt", "output.txt"];
    if (options.expectedOutputPath && fs.existsSync(options.expectedOutputPath)) {
      interactorWorkspace.stage(options.expectedOutputPath, "answer.txt");
      interactorArgs.push("answer.txt");
    }

    const submissionSpec = buildSubmissionExecutorRunSpec({
      runId: `sub_${crypto.randomUUID().replaceAll("-", "_")}`,
      workspaceId: workspace.id,
      executableId: launch.executableId,
      args: launch.args,
      environment: launch.environment,
      toolchain: launch.toolchain,
      localToolchain: launch.localToolchain,
      timeLimitMs: options.timeLimitMs,
      memoryBytes,
    });

    const interactorSpec = buildCheckerExecutorRunSpec({
      runId: `inter_${crypto.randomUUID().replaceAll("-", "_")}`,
      workspaceId: interactorWorkspace.id,
      executableId: interactorLaunch.executableId,
      args: interactorArgs,
      stdoutFile: "stdout.txt",
      stderrFile: "stderr.txt",
      environment: interactorLaunch.environment,
      toolchain: interactorLaunch.toolchain,
      localToolchain: interactorLaunch.localToolchain,
      runtimeBacked: options.interactor.runtime === "python",
      timeoutMs: Math.max(options.timeLimitMs * 2, options.timeLimitMs + 2000),
      memoryBytes: 512 * 1024 * 1024,
    });

    const result = await runReservedInteractiveExecutor(options.jobId, {
      runId,
      submission: submissionSpec,
      interactor: interactorSpec,
    });

    const transcript = readBounded(path.join(interactorWorkspace.path, "output.txt"), MAX_OUTPUT_SIZE).toString("utf8");
    const interactorStderr = readBounded(path.join(interactorWorkspace.path, "stderr.txt"), MAX_STDERR_PREVIEW).toString("utf8");

    let status: TestCaseRun["status"] = "JE";
    let score = 0;
    const executionTime = result.executionTimeMs;
    const peakMemoryKb = result.peakMemoryBytes ? Math.ceil(result.peakMemoryBytes / 1024) : undefined;
    const checkerMessage = interactorStderr || result.message;

    if (result.verdict === "AC") {
      status = "AC";
      score = options.score;
    } else if (result.verdict === "WA") {
      status = "WA";
      score = 0;
    } else if (result.verdict === "PE") {
      status = "PE";
      score = 0;
    } else if (result.verdict === "TLE") {
      status = "TLE";
      score = 0;
    } else if (result.verdict === "MLE") {
      status = "MLE";
      score = 0;
    } else if (result.verdict === "RTE" || result.verdict === "RE") {
      status = "RE";
      score = 0;
    } else if (result.verdict === "PARTIAL") {
      status = "PARTIAL";
      if (result.scoreMultiplier !== undefined) {
        score = Math.round(options.score * result.scoreMultiplier * 100) / 100;
      } else {
        const parsed = parsePartialScore(interactorStderr, transcript, options.score);
        score = parsed !== null ? Math.round(options.score * parsed * 100) / 100 : 0;
      }
    } else {
      status = "JE";
      score = 0;
    }

    return createResult(
      options,
      status,
      executionTime,
      peakMemoryKb,
      score,
      result.message || "",
      transcript || interactorStderr || "",
      checkerMessage,
      result.submissionResult,
    );
  } finally {
    detachExecutorRun(options.jobId, runId);
    workspace.dispose();
    interactorWorkspace.dispose();
  }
}
