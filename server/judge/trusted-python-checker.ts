import path from "node:path";
import {
  execFileSync,
  spawn,
  type ChildProcess,
} from "node:child_process";
import { activeJobs } from "../jobs.js";
import { buildToolchainEnvironment } from "../toolchains/resolver.js";
import type {
  CustomCheckerResult,
  RunCustomCheckerOptions,
} from "./custom-checker-runner.js";

const CHECKER_TIMEOUT_MS = 5_000;
const CHECKER_OUTPUT_LIMIT_BYTES = 256 * 1024;

type CheckerExitMapper = (
  exitCode: number,
  message: string,
  stdout: string,
  maxScore: number,
) => CustomCheckerResult;

export function validatePythonCheckerSource(
  pythonExecutablePath: string,
  checkerPath: string,
): void {
  const syntaxCheck = [
    "import pathlib,sys",
    "source=pathlib.Path(sys.argv[1]).read_bytes()",
    "compile(source,sys.argv[1],'exec')",
  ].join(";");
  execFileSync(
    pythonExecutablePath,
    ["-I", "-B", "-c", syntaxCheck, checkerPath],
    {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      env: buildToolchainEnvironment(pythonExecutablePath),
    },
  );
}

export async function runTrustedHostPythonChecker(
  options: RunCustomCheckerOptions,
  mapExit: CheckerExitMapper,
): Promise<CustomCheckerResult> {
  if (!options.pythonExecutablePath) {
    return {
      status: "JE",
      score: 0,
      message: "CHECKER_TOOLCHAIN_UNAVAILABLE: cannot compile Python checker; Python is missing",
    };
  }

  // Python checkers are trusted problem-author code. System/custom runtimes cannot
  // be safely relocated into the submission sandbox, so run this trusted tool on
  // the host with a minimal environment, bounded output, a watchdog, and process-
  // tree cleanup. Untrusted Python submissions never use this path.
  const child = spawn(
    options.pythonExecutablePath,
    [
      "-I",
      "-B",
      options.checkerPath,
      options.inputPath,
      options.actualOutputPath,
      options.expectedOutputPath,
    ],
    {
      cwd: options.tempDirectory,
      detached: process.platform !== "win32",
      env: trustedCheckerEnvironment(options.pythonExecutablePath, options.tempDirectory),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );

  return new Promise<CustomCheckerResult>((resolve) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let finished = false;
    let forcedReason = "";

    const append = (current: Buffer, chunk: Buffer): Buffer => {
      const remaining = CHECKER_OUTPUT_LIMIT_BYTES - current.length;
      if (remaining <= 0) return current;
      return Buffer.concat([current, chunk.subarray(0, remaining)]);
    };
    const stop = (reason: string) => {
      if (finished || forcedReason) return;
      forcedReason = reason;
      terminateProcessTree(child);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
      if (stdout.length + stderr.length >= CHECKER_OUTPUT_LIMIT_BYTES) {
        stop("output_limit");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
      if (stdout.length + stderr.length >= CHECKER_OUTPUT_LIMIT_BYTES) {
        stop("output_limit");
      }
    });
    child.once("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearInterval(cancelPoll);
      resolve({ status: "JE", score: 0, message: `launch_error: ${error.message}` });
    });
    child.once("exit", (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearInterval(cancelPoll);
      const message = Buffer.concat([stdout, stderr]).toString("utf8").trim();
      if (forcedReason) {
        resolve({
          status: "JE",
          score: 0,
          message: [forcedReason, signal, message].filter(Boolean).join(": "),
        });
        return;
      }
      if (signal || code === null) {
        resolve({
          status: "JE",
          score: 0,
          message: [signal || "checker terminated", message].filter(Boolean).join(": "),
        });
        return;
      }
      resolve(mapExit(code, message, stdout.toString("utf8"), options.maxScore));
    });

    const timeout = setTimeout(() => stop("wall_time_limit"), CHECKER_TIMEOUT_MS);
    const cancelPoll = setInterval(() => {
      if (options.jobId && activeJobs.get(options.jobId)?.cancel) stop("cancelled");
    }, 50);
    timeout.unref();
    cancelPoll.unref();
  });
}

export function trustedCheckerEnvironment(
  pythonExecutablePath: string,
  tempDirectory: string,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (platform === "win32") {
    const executableDirectory = path.win32.dirname(pythonExecutablePath);
    const windowsDirectory = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
    return {
      SystemRoot: windowsDirectory,
      WINDIR: windowsDirectory,
      TEMP: tempDirectory,
      TMP: tempDirectory,
      Path: [
        executableDirectory,
        path.win32.join(windowsDirectory, "System32"),
      ].join(";"),
      PYTHONNOUSERSITE: "1",
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONUTF8: "1",
    };
  }
  const executableDirectory = path.posix.dirname(pythonExecutablePath);
  return {
    HOME: tempDirectory,
    TMPDIR: tempDirectory,
    PATH: [executableDirectory, "/usr/bin", "/bin"].join(":"),
    LANG: "C.UTF-8",
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONUTF8: "1",
  };
}

function terminateProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn(
      path.join(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows", "System32", "taskkill.exe"),
      ["/pid", String(child.pid), "/t", "/f"],
      { stdio: "ignore", windowsHide: true },
    );
    killer.unref();
    child.kill();
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}
