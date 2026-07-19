import fs from "fs";
import os from "os";
import path from "path";
import { spawn, type ChildProcess } from "child_process";
import treeKill from "tree-kill";
import { sandbox } from "../sandbox.js";
import { activeJobs } from "../jobs.js";
import type { ProblemResult } from "../types.js";
import { isBuiltInChecker } from "./standard-checkers.js";
import {
  buildToolchainEnvironment,
  resolveToolchain,
} from "../toolchains/resolver.js";

declare const __JUDGEDESK_TESTLIB__: string;

export const COMPILE_TIMEOUT_MS = 15_000;
export const MAX_GENERATED_FILE_BYTES = 32 * 1024 * 1024;
const MAX_COMPILER_DIAGNOSTIC_BYTES = 256 * 1024;

export interface CompileLimits {
  timeoutMs: number;
  maxGeneratedFileBytes: number;
}

const DEFAULT_COMPILE_LIMITS: CompileLimits = {
  timeoutMs: COMPILE_TIMEOUT_MS,
  maxGeneratedFileBytes: MAX_GENERATED_FILE_BYTES,
};

function canonicalTestlibSource(): string {
  if (
    typeof __JUDGEDESK_TESTLIB__ !== "undefined" &&
    __JUDGEDESK_TESTLIB__.length > 0
  ) {
    return __JUDGEDESK_TESTLIB__;
  }
  const developmentPath = path.join(process.cwd(), "judgers", "testlib.h");
  if (fs.existsSync(developmentPath)) {
    return fs.readFileSync(developmentPath, "utf8");
  }
  throw new Error("Bundled testlib.h was not found.");
}

export interface CompiledChecker {
  path: string | null;
  error?: string;
}

interface ResolveCheckerOptions {
  checkerType: string;
  problemName: string;
  problemDirectory: string;
  tempDirectory: string;
  jobId?: string;
}

interface CompileSubmissionOptions {
  language: string;
  contestantName: string;
  problemName: string;
  submissionPath: string;
  tempDirectory: string;
  jobId?: string;
}

export interface CompilationResult {
  executablePath: string;
  compileStatus: ProblemResult["compileStatus"];
  compileError: string;
  compileTime: number;
}

export async function resolveChecker({
  checkerType,
  problemName,
  problemDirectory,
  tempDirectory,
  jobId,
}: ResolveCheckerOptions): Promise<CompiledChecker> {
  if (isBuiltInChecker(checkerType)) {
    return { path: null };
  }

  if (checkerType.toLowerCase().endsWith(".cpp")) {
    return compileCustomChecker(
      checkerType,
      problemName,
      problemDirectory,
      tempDirectory,
      jobId,
    );
  }

  if (checkerType.toLowerCase().endsWith(".exe")) {
    if (os.platform() !== "win32") {
      return {
        path: null,
        error: "Precompiled Windows checker executables cannot run on macOS.",
      };
    }
    const checkerPath = path.join(problemDirectory, checkerType);
    return fs.existsSync(checkerPath)
      ? { path: checkerPath }
      : { path: null, error: `Custom checker ${checkerType} not found.` };
  }

  return {
    path: null,
    error: `Unsupported checker type '${checkerType}'.`,
  };
}

export async function compileSubmission({
  language,
  contestantName,
  problemName,
  submissionPath,
  tempDirectory,
  jobId,
}: CompileSubmissionOptions): Promise<CompilationResult> {
  if (language !== "cpp") {
    const resolvedPy = resolveToolchain("python");
    if (!resolvedPy.ready) {
      return {
        executablePath: "",
        compileStatus: "CE",
        compileError: "TOOLCHAIN_PYTHON_MISSING",
        compileTime: 0,
      };
    }
    return {
      executablePath: resolvedPy.executablePath,
      compileStatus: "OK",
      compileError: "",
      compileTime: 0,
    };
  }

  const executablePath = path.join(
    tempDirectory,
    `${contestantName}_${problemName}.out`,
  );
  const compileStart = process.hrtime.bigint();
  try {
    if (sandbox.mode !== "none") {
      try {
        sandbox.runCommand([
          "cp",
          sandbox.toPath(submissionPath),
          "/tmp/compile.cpp",
        ]);
        await runCompilerWithLimits(
          "g++",
          [
          "-std=c++14",
          "-pipe",
          "-O2",
          "-s",
          "-static",
          "-lm",
          "-x",
          "c++",
          "/tmp/compile.cpp",
          "-o",
          "/tmp/compile.out",
          ],
          tempDirectory,
          "/tmp/compile.out",
          jobId,
        );
        sandbox.runCommand([
          "cp",
          "/tmp/compile.out",
          sandbox.toPath(executablePath),
        ]);
        if (fileExceedsLimit(executablePath))
          throw new Error("GENERATED_FILE_TOO_LARGE");
      } finally {
        sandbox.runCommand(["rm", "-f", "/tmp/compile.cpp", "/tmp/compile.out"]);
      }
    } else {
      const resolvedCpp = resolveToolchain("cpp");
      if (!resolvedCpp.ready) {
        throw new Error("TOOLCHAIN_CPP_MISSING");
      }
      await runCompilerWithLimits(
        resolvedCpp.executablePath,
        buildSubmissionCompilerArgs(
          os.platform(),
          submissionPath,
          executablePath,
        ),
        tempDirectory,
        executablePath,
        jobId,
      );
    }

    return {
      executablePath,
      compileStatus: "OK",
      compileError: "",
      compileTime: Number(process.hrtime.bigint() - compileStart) / 1_000_000,
    };
  } catch (error: any) {
    return {
      executablePath,
      compileStatus: "CE",
      compileError: normalizeCompilerError(error),
      compileTime: Number(process.hrtime.bigint() - compileStart) / 1_000_000,
    };
  }
}

async function compileCustomChecker(
  checkerType: string,
  problemName: string,
  problemDirectory: string,
  tempDirectory: string,
  jobId?: string,
): Promise<CompiledChecker> {
  const checkerSourcePath = path.join(problemDirectory, checkerType);
  if (!fs.existsSync(checkerSourcePath)) {
    return { path: null, error: `Custom checker ${checkerType} not found.` };
  }

  const checkerBinaryPath = path.join(
    tempDirectory,
    `checker_${problemName}_${checkerType.replace(/\./g, "_")}.out`,
  );
  try {
    const checkerSupportDirectory = path.join(tempDirectory, "checker-support");
    const bundledTestlibPath = path.join(checkerSupportDirectory, "testlib.h");
    fs.mkdirSync(checkerSupportDirectory, { recursive: true });
    // Always restore the canonical embedded copy. Preview files opened by the
    // user are intentionally unrelated to the copy used for compilation.
    fs.writeFileSync(bundledTestlibPath, canonicalTestlibSource(), "utf8");

    if (sandbox.mode !== "none") {
      try {
        sandbox.runCommand([
          "cp",
          sandbox.toPath(checkerSourcePath),
          "/tmp/checker.cpp",
        ]);
        sandbox.runCommand([
          "cp",
          sandbox.toPath(bundledTestlibPath),
          "/tmp/testlib.h",
        ]);
        await runCompilerWithLimits(
          "g++",
          [
          "-std=c++14",
          "-O2",
          "/tmp/checker.cpp",
          "-o",
          "/tmp/checker.out",
          ],
          tempDirectory,
          "/tmp/checker.out",
          jobId,
        );
        sandbox.runCommand([
          "cp",
          "/tmp/checker.out",
          sandbox.toPath(checkerBinaryPath),
        ]);
        if (fileExceedsLimit(checkerBinaryPath))
          throw new Error("GENERATED_FILE_TOO_LARGE");
      } finally {
        sandbox.runCommand([
          "rm",
          "-f",
          "/tmp/checker.cpp",
          "/tmp/checker.out",
          "/tmp/testlib.h",
        ]);
      }
    } else {
      const resolvedCpp = resolveToolchain("cpp");
      if (!resolvedCpp.ready) {
        return { path: null, error: "TOOLCHAIN_CPP_MISSING" };
      }
      await runCompilerWithLimits(resolvedCpp.executablePath, [
        "-std=c++14",
        "-O2",
        "-I",
        path.dirname(bundledTestlibPath),
        checkerSourcePath,
        "-o",
        checkerBinaryPath,
      ], tempDirectory, checkerBinaryPath, jobId);
    }
    return { path: checkerBinaryPath };
  } catch (error: any) {
    return { path: null, error: normalizeCompilerError(error) };
  }
}

export function buildSubmissionCompilerArgs(
  platform: NodeJS.Platform,
  sourcePath: string,
  outputPath: string,
): string[] {
  const args = ["-std=c++14", "-pipe", "-O2", "-s"];
  if (platform !== "darwin") args.push("-static");
  args.push("-lm", "-x", "c++");
  if (platform === "win32") args.push("-Wl,--stack,66060288");
  args.push(sourcePath, "-o", outputPath);
  return args;
}

export async function runCompilerWithLimits(
  gppPath: string,
  args: string[],
  cwd: string | undefined,
  outputPath: string,
  jobId?: string,
  limits: CompileLimits = DEFAULT_COMPILE_LIMITS,
): Promise<void> {
  const scratchDirectory = fs.mkdtempSync(
    path.join(cwd || os.tmpdir(), "compile-scratch-"),
  );
  let child: ChildProcess | undefined;
  let timedOut = false;
  let generatedFileTooLarge = false;
  let settled = false;
  let stderr = "";

  try {
    const command = buildLimitedCompilerCommand(gppPath, args, limits);
    const spawnOptions = {
      cwd,
      stdio: ["ignore", "ignore", "pipe"] as ["ignore", "ignore", "pipe"],
      env: {
        ...buildToolchainEnvironment(gppPath),
        TMP: scratchDirectory,
        TEMP: scratchDirectory,
        TMPDIR: scratchDirectory,
      },
    };
    child = sandbox.mode === "none"
      ? spawn(command[0], command.slice(1), spawnOptions)
      : sandbox.spawnCommand(command, {
          cwd,
          stdio: spawnOptions.stdio,
          paths: cwd ? [cwd] : undefined,
        });

    if (jobId) {
      const job = activeJobs.get(jobId);
      if (job) job.childProcess = child;
    }

    child.stderr?.on("data", (chunk: Buffer | string) => {
      const remaining =
        MAX_COMPILER_DIAGNOSTIC_BYTES - Buffer.byteLength(stderr, "utf8");
      if (remaining <= 0) return;
      stderr += Buffer.from(chunk).subarray(0, remaining).toString();
      if (stderr.includes("__THEMIS_GENERATED_FILE_TOO_LARGE__")) {
        generatedFileTooLarge = true;
      }
      if (/file (?:size limit exceeded|too large)/i.test(stderr)) {
        generatedFileTooLarge = true;
      }
      if (stderr.includes("__THEMIS_COMPILE_TIMEOUT__")) timedOut = true;
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        timedOut = true;
        if (child) killCompilerProcess(child);
      }, limits.timeoutMs);
      const sizeMonitor = setInterval(() => {
        if (
          fileExceedsLimit(outputPath, limits.maxGeneratedFileBytes) ||
          directoryContainsOversizedFile(
            scratchDirectory,
            limits.maxGeneratedFileBytes,
          )
        ) {
          generatedFileTooLarge = true;
          if (child) killCompilerProcess(child);
        }
      }, 25);

      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearInterval(sizeMonitor);
        callback();
      };

      child?.once("error", (error) => finish(() => reject(error)));
      child?.once("close", (code, signal) => {
        finish(() => {
          generatedFileTooLarge =
            generatedFileTooLarge ||
            fileExceedsLimit(outputPath, limits.maxGeneratedFileBytes) ||
            directoryContainsOversizedFile(
              scratchDirectory,
              limits.maxGeneratedFileBytes,
            );
          if (generatedFileTooLarge) {
            reject(new Error("GENERATED_FILE_TOO_LARGE"));
          } else if (timedOut) {
            reject(new Error("COMPILER_TIMEOUT"));
          } else if (code !== 0) {
            reject(
              new Error(
                stripCompilerSentinels(stderr).trim() ||
                  `Compilation failed (exit code ${code ?? signal ?? "unknown"})`,
              ),
            );
          } else {
            resolve();
          }
        });
      });
    });
  } finally {
    if (jobId) {
      const job = activeJobs.get(jobId);
      if (job?.childProcess === child) delete job.childProcess;
    }
    fs.rmSync(scratchDirectory, { recursive: true, force: true });
    if (timedOut || generatedFileTooLarge) {
      fs.rmSync(outputPath, { force: true });
    }
  }
}

function buildLimitedCompilerCommand(
  compilerPath: string,
  args: string[],
  limits: CompileLimits,
): string[] {
  if (os.platform() === "win32" && sandbox.mode === "none") {
    return [compilerPath, ...args];
  }

  // Leave one extra filesystem block so the host-side monitor can observe a
  // value greater than the configured limit before the OS hard-stop fires.
  const fileLimitBlocks = Math.floor(limits.maxGeneratedFileBytes / 512) + 1;
  const timeoutSeconds = Math.ceil(limits.timeoutMs / 1000);
  const useInnerTimeout = sandbox.mode !== "none" || os.platform() === "linux";
  const run = useInnerTimeout
    ? `timeout --signal=KILL ${timeoutSeconds}s "$@"`
    : `"$@"`;
  const script = [
    `ulimit -f ${fileLimitBlocks}`,
    run,
    "code=$?",
    'if [ "$code" -eq 153 ]; then echo __THEMIS_GENERATED_FILE_TOO_LARGE__ >&2; fi',
    'if [ "$code" -eq 124 ] || [ "$code" -eq 137 ]; then echo __THEMIS_COMPILE_TIMEOUT__ >&2; fi',
    'exit "$code"',
  ].join("; ");
  return ["sh", "-c", script, "themis-compiler", compilerPath, ...args];
}

function killCompilerProcess(child: ChildProcess): void {
  if (!child.pid) {
    child.kill("SIGKILL");
    return;
  }
  try {
    treeKill(child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function fileExceedsLimit(
  filePath: string,
  maxGeneratedFileBytes = MAX_GENERATED_FILE_BYTES,
): boolean {
  try {
    return fs.statSync(filePath).size > maxGeneratedFileBytes;
  } catch {
    return false;
  }
}

function directoryContainsOversizedFile(
  directory: string,
  maxGeneratedFileBytes: number,
): boolean {
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop()!;
    try {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const entryPath = path.join(current, entry.name);
        if (entry.isDirectory()) pending.push(entryPath);
        else if (
          entry.isFile() &&
          fs.statSync(entryPath).size > maxGeneratedFileBytes
        )
          return true;
      }
    } catch {
      // The compiler can remove temporary files while they are being scanned.
    }
  }
  return false;
}

function stripCompilerSentinels(value: string): string {
  return value
    .replaceAll("__THEMIS_GENERATED_FILE_TOO_LARGE__", "")
    .replaceAll("__THEMIS_COMPILE_TIMEOUT__", "");
}

function normalizeCompilerError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("GENERATED_FILE_TOO_LARGE"))
    return "GENERATED_FILE_TOO_LARGE";
  if (message.includes("COMPILER_TIMEOUT")) return "COMPILER_TIMEOUT";
  return stripCompilerSentinels(message).trim() || "Compilation failed";
}
