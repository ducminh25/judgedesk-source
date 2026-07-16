import fs from "fs";
import os from "os";
import path from "path";
import { execFile, spawn } from "child_process";
import treeKill from "tree-kill";
import { activeJobs } from "../jobs.js";
import { TEMP_ROOT } from "../runtime.js";
import { sandbox } from "../sandbox.js";
import type {
  NormalizedProblemConfig,
  SubmissionLanguage,
  TestCaseRun,
} from "../types.js";
import type { CompiledChecker } from "./compiler.js";
import { runCustomChecker } from "./custom-checker-runner.js";
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

export function runTestCase(
  options: TestCaseRunnerOptions,
): Promise<TestCaseRun> {
  const {
    contestant,
    problemName,
    testName,
    language,
    submissionPath,
    executablePath,
    inputPath,
    expectedOutputPath,
    expectedOutput,
    testRoot,
    contestantsRoot,
    tempDirectory,
    pythonCommand,
    timeLimitMs,
    score,
    config,
    checker,
    jobId,
  } = options;
  const outputFilename = config.useStdOut ? "stdout" : config.outputFile;

  return new Promise<TestCaseRun>((resolve) => {
    const startTime = process.hrtime.bigint();
    let childProcess: ReturnType<typeof spawn>;
    let isolateBox = -1;
    let isolateBoxDirectory = "";
    const memoryLimitKb = config.memoryLimit ? config.memoryLimit * 1024 : 0;
    let useIsolate = sandbox.mode !== "none";
    let peakMemoryKb = 0;
    let mleTriggered = false;
    let memoryMonitorInterval: NodeJS.Timeout | null = null;
    let memoryMonitorStopped = false;
    let memorySampleInFlight = false;

    if (useIsolate) {
      isolateBox = sandbox.nextIsolateBox();
      try {
        const init = sandbox.runCommand(
          ["isolate", "-b", `${isolateBox}`, "--init"],
          { encoding: "utf8", paths: [tempDirectory] },
        );
        if (init.status !== 0) throw new Error("isolate init failed");
        isolateBoxDirectory = `${init.stdout.toString().trim()}/box`;
        if (language === "cpp") {
          sandbox.runCommand(
            [
              "cp",
              sandbox.toPath(executablePath),
              `${isolateBoxDirectory}/exec`,
            ],
            { paths: [tempDirectory] },
          );
        } else {
          sandbox.runCommand(
            [
              "cp",
              sandbox.toPath(submissionPath),
              `${isolateBoxDirectory}/script.py`,
            ],
            { paths: [contestantsRoot] },
          );
        }
      } catch (error) {
        console.error(`[Runner Isolate Init Error] Box: ${isolateBox}:`, error);
        useIsolate = false;
      }
    }

    const inputFilename = config.inputFile || `${problemName}.inp`;
    if (!config.useStdIO) {
      if (useIsolate) {
        try {
          sandbox.runCommand(
            [
              "cp",
              sandbox.toPath(inputPath),
              `${isolateBoxDirectory}/${inputFilename}`,
            ],
            { paths: [testRoot] },
          );
        } catch {
          /* The process will report missing input through its verdict. */
        }
      } else {
        try {
          fs.copyFileSync(inputPath, path.join(tempDirectory, inputFilename));
        } catch {
          /* Preserve runner fallback behavior. */
        }
      }
    }

    if (useIsolate) {
      const metaPath = sandbox.toPath(
        path.join(tempDirectory, `meta_${isolateBox}.txt`),
      );
      const isolateArgs = [
        "-b",
        `${isolateBox}`,
        `--meta=${metaPath}`,
        `--time=${(timeLimitMs / 1000).toFixed(3)}`,
        `--wall-time=${(timeLimitMs / 1000 + 1).toFixed(3)}`,
        "--processes=128",
      ];
      if (config.useStdIn) {
        isolateArgs.push("--stdin=input.txt");
        try {
          sandbox.runCommand(
            [
              "cp",
              sandbox.toPath(inputPath),
              `${isolateBoxDirectory}/input.txt`,
            ],
            { paths: [testRoot] },
          );
        } catch {
          /* The process will report missing input through its verdict. */
        }
      }
      isolateArgs.push("--stdout=output.txt");
      if (memoryLimitKb > 0)
        isolateArgs.push("--cg", `--cg-mem=${memoryLimitKb}`);
      isolateArgs.push("--run", "--");
      if (language === "cpp") isolateArgs.push("./exec");
      else isolateArgs.push("/usr/bin/python3", "./script.py");
      childProcess = sandbox.spawnCommand(["isolate", ...isolateArgs], {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: timeLimitMs,
        paths: [contestantsRoot, testRoot, tempDirectory],
      });
    } else if (os.platform() === "linux" && memoryLimitKb > 0) {
      let command = "";
      if (language === "cpp") {
        command = `ulimit -v ${memoryLimitKb} && exec ./exec_target`;
        fs.copyFileSync(
          executablePath,
          path.join(tempDirectory, "exec_target"),
        );
        fs.chmodSync(path.join(tempDirectory, "exec_target"), 0o755);
      } else {
        command = `ulimit -v ${memoryLimitKb} && exec python3 ./script.py`;
        fs.copyFileSync(submissionPath, path.join(tempDirectory, "script.py"));
      }
      childProcess = spawn("bash", ["-c", command], {
        cwd: tempDirectory,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: timeLimitMs,
      });
    } else {
      fs.mkdirSync(TEMP_ROOT, { recursive: true });
      if (os.platform() === "win32") {
        const sandboxExecutable = path.join(TEMP_ROOT, "student_bin.exe");
        try {
          fs.rmSync(sandboxExecutable, { force: true });
        } catch {
          /* Ignore stale executable cleanup errors. */
        }
        if (language === "cpp") {
          fs.copyFileSync(executablePath, sandboxExecutable);
          childProcess = spawn(sandboxExecutable, [], {
            cwd: tempDirectory,
            stdio: ["pipe", "pipe", "pipe"],
            timeout: timeLimitMs,
          });
        } else {
          childProcess = spawn(pythonCommand, [submissionPath], {
            cwd: tempDirectory,
            stdio: ["pipe", "pipe", "pipe"],
            timeout: timeLimitMs,
          });
        }
      } else if (os.platform() === "darwin") {
        const sandboxBinary = path.join(TEMP_ROOT, "student_bin");
        try {
          fs.rmSync(sandboxBinary, { force: true });
        } catch {
          /* Ignore stale binary cleanup errors. */
        }
        let resolvedBinary = "";
        let runArgs: string[] = [];
        if (language === "cpp") {
          fs.copyFileSync(executablePath, sandboxBinary);
          fs.chmodSync(sandboxBinary, 0o755);
          resolvedBinary = sandboxBinary;
        } else {
          resolvedBinary = pythonCommand;
          runArgs = [submissionPath];
        }
        const profilePath = path.join(tempDirectory, "sandbox.sb");
        const pythonReadRoots = language === "python"
          ? getPythonRuntimeReadRoots(resolvedBinary)
          : [];
        const profile = buildMacSandboxProfile({
          readPaths: [
            "/System/Library",
            "/Library/Apple",
            "/usr/bin",
            "/usr/lib",
            "/bin",
            "/lib",
            "/etc",
            testRoot,
            contestantsRoot,
            tempDirectory,
            TEMP_ROOT,
            ...pythonReadRoots,
          ],
          writePaths: [tempDirectory],
        });
        fs.writeFileSync(profilePath, profile, "utf8");
        childProcess = spawn(
          "sandbox-exec",
          ["-f", profilePath, resolvedBinary, ...runArgs],
          {
            cwd: tempDirectory,
            stdio: ["pipe", "pipe", "pipe"],
            timeout: timeLimitMs,
          },
        );
      } else if (language === "cpp") {
        if (os.platform() !== "win32" && memoryLimitKb > 0) {
          childProcess = spawn("sh", ["-c", `ulimit -v ${memoryLimitKb} && exec "${executablePath}"`], {
            cwd: tempDirectory,
            stdio: ["pipe", "pipe", "pipe"],
            timeout: timeLimitMs,
          });
        } else {
          childProcess = spawn(executablePath, [], {
            cwd: tempDirectory,
            stdio: ["pipe", "pipe", "pipe"],
            timeout: timeLimitMs,
          });
        }
      } else {
        if (os.platform() !== "win32" && memoryLimitKb > 0) {
          childProcess = spawn("sh", ["-c", `ulimit -v ${memoryLimitKb} && exec "${executablePath}" "${submissionPath}"`], {
            cwd: tempDirectory,
            stdio: ["pipe", "pipe", "pipe"],
            timeout: timeLimitMs,
          });
        } else {
          childProcess = spawn(executablePath, [submissionPath], {
            cwd: tempDirectory,
            stdio: ["pipe", "pipe", "pipe"],
            timeout: timeLimitMs,
          });
        }
      }
    }

    if (jobId) {
      const job = activeJobs.get(jobId);
      if (job) job.childProcess = childProcess;
    }
    let stdout = "";
    let stdoutBuffer = Buffer.alloc(0);
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      killProcess(childProcess);
    }, timeLimitMs);

    if (!useIsolate && memoryLimitKb > 0) {
      const sampleMemory = async () => {
        if (memoryMonitorStopped || memorySampleInFlight || !childProcess.pid)
          return;
        memorySampleInFlight = true;
        try {
          const memoryKb = await readProcessMemoryKb(childProcess.pid);
          if (
            !memoryMonitorStopped &&
            memoryKb !== null &&
            memoryKb > peakMemoryKb
          ) {
            peakMemoryKb = memoryKb;
            if (peakMemoryKb > memoryLimitKb) {
              mleTriggered = true;
              killProcess(childProcess);
            }
          }
        } finally {
          memorySampleInFlight = false;
        }
      };
      void sampleMemory();
      memoryMonitorInterval = setInterval(() => void sampleMemory(), 100);
    }
    childProcess.stdout.on("data", (chunk) => {
      if (stdoutBuffer.length >= MAX_OUTPUT_SIZE) return;
      const nextChunk = Buffer.from(chunk);
      const remaining = MAX_OUTPUT_SIZE - stdoutBuffer.length;
      stdoutBuffer = Buffer.concat([
        stdoutBuffer,
        nextChunk.subarray(0, remaining),
      ]);
      stdout = stdoutBuffer.toString("utf8");
      if (nextChunk.length > remaining || stdoutBuffer.length >= MAX_OUTPUT_SIZE) {
        killProcess(childProcess);
      }
    });
    childProcess.stderr.on("data", (chunk) => {
      if (stderr.length >= MAX_OUTPUT_SIZE) return;
      stderr += chunk.toString();
      if (stderr.length >= MAX_OUTPUT_SIZE)
        stderr = stderr.substring(0, MAX_OUTPUT_SIZE);
    });
    childProcess.stdin.on("error", () => {
      /* Ignore EPIPE when a solution exits before stdin is written. */
    });
    if (config.useStdIn) {
      const input = fs.createReadStream(inputPath);
      input.on("error", () => {
        /* Child process verdict handles unreadable input. */
      });
      input.pipe(childProcess.stdin);
    } else {
      childProcess.stdin.end();
    }

    childProcess.on("close", async (code, signal) => {
      clearTimeout(timeout);
      memoryMonitorStopped = true;
      if (memoryMonitorInterval) clearInterval(memoryMonitorInterval);
      const duration = Number(process.hrtime.bigint() - startTime) / 1_000_000;
      let status: TestCaseRun["status"] = "AC";
      let errorDetail = "";
      let actualOutputBuffer = stdoutBuffer;

      if (useIsolate) {
        let output = Buffer.alloc(0);
        if (config.useStdOut) {
          try {
            const hostOutputPath = path.join(
              tempDirectory,
              `stdout_${isolateBox}.txt`,
            );
            const copy = sandbox.runCommand(
              [
                "cp",
                `${isolateBoxDirectory}/output.txt`,
                sandbox.toPath(hostOutputPath),
              ],
              { paths: [tempDirectory] },
            );
            if (copy.status !== 0)
              console.error(
                `[Runner StdIO copy failed] exit code: ${copy.status}, stderr: ${copy.stderr ? copy.stderr.toString() : "N/A"}`,
              );
            if (fs.existsSync(hostOutputPath)) {
              output = fs.readFileSync(hostOutputPath);
              fs.rmSync(hostOutputPath, { force: true });
            } else {
              console.error(
                `[Runner StdIO winOutPath not found] winOutPath: ${hostOutputPath}`,
              );
            }
          } catch (error) {
            console.error("[Runner StdIO Error]:", error);
          }
        } else {
          try {
            const hostOutputPath = path.join(tempDirectory, outputFilename);
            const copy = sandbox.runCommand(
              [
                "cp",
                `${isolateBoxDirectory}/${outputFilename}`,
                sandbox.toPath(hostOutputPath),
              ],
              { paths: [tempDirectory] },
            );
            if (copy.status === 0 && fs.existsSync(hostOutputPath))
              output = fs.readFileSync(hostOutputPath);
          } catch (error) {
            console.error(
              `[Runner FileIO Error] for ${outputFilename}:`,
              error,
            );
          }
        }
        actualOutputBuffer = output;
        stdout = output.toString("utf8");
      } else if (!config.useStdOut) {
        const outputPath = path.join(tempDirectory, outputFilename);
        if (fs.existsSync(outputPath)) {
          const output = fs.readFileSync(outputPath);
          actualOutputBuffer = output;
          stdout = output.toString("utf8");
        }
      }

      if (useIsolate) {
        try {
          const metaFile = path.join(tempDirectory, `meta_${isolateBox}.txt`);
          if (fs.existsSync(metaFile)) {
            const metadata = fs.readFileSync(metaFile, "utf8");
            const memory =
              metadata.match(/^max-rss:(\d+)/m) ||
              metadata.match(/^cg-mem:(\d+)/m);
            if (memory) peakMemoryKb = parseInt(memory[1]);
            if (metadata.match(/^status:TO/m)) status = "TLE";
            else if (
              metadata.match(/^status:SG/m) ||
              metadata.match(/^status:RE/m)
            )
              status = "RE";
          }
          sandbox.runCommand(["isolate", "-b", `${isolateBox}`, "--cleanup"], {
            paths: [tempDirectory],
          });
        } catch {
          /* Preserve the process-derived verdict when metadata cannot be read. */
        }
      }

      if (mleTriggered || (memoryLimitKb > 0 && peakMemoryKb > memoryLimitKb)) {
        status = "MLE";
      } else if (timedOut || signal === "SIGKILL" || status === "TLE") {
        status = "TLE";
      } else if (signal) {
        status = "RE";
        errorDetail = formatProcessDiagnostic(code, signal, stderr);
      } else if (code !== 0 && code !== null) {
        const isMleCode =
          code === 139 ||
          code === 134 ||
          code === 3221225773 ||
          code === -1073741523 ||
          code === 3221225566 ||
          code === -1073741730 ||
          stderr.includes("MemoryError") ||
          stderr.includes("std::bad_alloc");
        status = isMleCode ? "MLE" : "RE";
        errorDetail = `Exit code ${code}. ${stderr}`;
      } else {
        const actualOutputPath = path.join(
          tempDirectory,
          `${contestant}_${problemName}_${testName}.out`,
        );
        fs.writeFileSync(actualOutputPath, actualOutputBuffer);
        if (isBuiltInChecker(config.checkerType)) {
          const result = runStandardChecker(
            config.checkerType,
            fs.readFileSync(expectedOutputPath),
            actualOutputBuffer,
          );
          if (result.status !== "AC") {
            errorDetail = formatProcessDiagnostic(code, signal, stderr);
          }
          resolve(
            createResult(
              testName,
              result.status,
              duration,
              timeLimitMs,
              peakMemoryKb,
              result.status === "AC" ? score : 0,
              errorDetail,
              expectedOutput,
              stdout,
              result.message,
            ),
          );
          return;
        }
        if (checker?.error) {
          status = "FAIL";
          errorDetail = checker.error;
        } else if (checker?.path && fs.existsSync(checker.path)) {
          try {
            const result = await runCustomChecker({
              checkerPath: checker.path,
              inputPath,
              actualOutputPath,
              expectedOutputPath,
              testDirectory: testRoot,
              tempDirectory,
              maxScore: score,
            });
            resolve(
              createResult(
                testName,
                result.status,
                duration,
                timeLimitMs,
                peakMemoryKb,
                result.score,
                errorDetail,
                expectedOutput,
                stdout,
                result.message,
              ),
            );
            return;
          } catch (error) {
            status = "FAIL";
            errorDetail = `Checker launch failed: ${error instanceof Error ? error.message : String(error)}`;
          }
        } else {
          status = "FAIL";
          errorDetail = "Checker is unavailable.";
        }
      }
      resolve(
        createResult(
          testName,
          status,
          duration,
          timeLimitMs,
          peakMemoryKb,
          0,
          errorDetail,
          expectedOutput,
          stdout,
        ),
      );
    });
    childProcess.on("error", (error) => {
      clearTimeout(timeout);
      memoryMonitorStopped = true;
      if (memoryMonitorInterval) clearInterval(memoryMonitorInterval);
      resolve({
        name: testName,
        status: "RE",
        executionTime: 0,
        score: 0,
        errorDetail: error.message,
      });
    });
  });
}

function formatProcessDiagnostic(
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): string {
  const details = [
    `Exit code: ${code === null ? "null" : code}.`,
    signal ? `Signal: ${signal}.` : "",
    stderr.trim() ? `stderr: ${stderr.trim()}` : "",
  ].filter(Boolean);
  return details.join(" ");
}

export function buildMacSandboxProfile({
  readPaths,
  writePaths,
}: {
  readPaths: string[];
  writePaths: string[];
}): string {
  const readRules = uniqueSandboxPaths(readPaths)
    .map((value) => `(allow file-read* (subpath "${sandboxProfileLiteral(value)}"))`);
  const writeRules = uniqueSandboxPaths(writePaths)
    .map((value) => `(allow file-write* (subpath "${sandboxProfileLiteral(value)}"))`);
  return [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow user-preference-read)",
    "(allow sysctl-read)",
    "(allow ipc-posix-shm)",
    "(allow ipc-posix-sem)",
    // macOS runtimes resolve executables, frameworks, source files and
    // firmlink-backed temporary paths through locations that vary by install.
    // Keep reads available while network and writes remain tightly restricted.
    "(allow file-read*)",
    // dyld must traverse the root and parent directories before it can load
    // an otherwise explicitly allowed executable and its libraries.
    '(allow file-read* (literal "/"))',
    "(allow file-read-metadata (vnode-type DIRECTORY))",
    // Native runtimes use these character devices during startup.
    '(allow file-read* file-ioctl (literal "/dev/null"))',
    '(allow file-read* file-ioctl (literal "/dev/zero"))',
    '(allow file-read* file-ioctl (literal "/dev/random"))',
    '(allow file-read* file-ioctl (literal "/dev/urandom"))',
    ...readRules,
    ...writeRules,
    "(deny network*)",
  ].join("\n");
}

function getPythonRuntimeReadRoots(pythonCommand: string): string[] {
  const roots = [
    pythonCommand,
    path.dirname(pythonCommand),
    path.dirname(path.dirname(pythonCommand)),
  ];
  try {
    const realPython = fs.realpathSync(pythonCommand);
    roots.push(
      realPython,
      path.dirname(realPython),
      path.dirname(path.dirname(realPython)),
    );
  } catch {
    // The runner will return a launch error if the configured path is stale.
  }
  return roots;
}

function uniqueSandboxPaths(values: string[]): string[] {
  const result = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    result.add(path.resolve(value));
    try {
      result.add(fs.realpathSync(value));
    } catch {
      // Paths such as an output directory may not exist before the run starts.
    }
  }
  return [...result];
}

function sandboxProfileLiteral(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function readProcessMemoryKb(pid: number): Promise<number | null> {
  const windows = os.platform() === "win32";
  const command = windows ? "tasklist" : "ps";
  const args = windows
    ? ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]
    : ["-p", String(pid), "-o", "rss="];
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { encoding: "utf8", timeout: 1_000, windowsHide: true },
      (error, stdout) => {
        if (error || !stdout) {
          resolve(null);
          return;
        }
        if (!windows) {
          const value = Number.parseInt(stdout.trim(), 10);
          resolve(Number.isFinite(value) ? value : null);
          return;
        }
        const match = stdout.match(
          /"[^"]*","\d+","[^"]*","\d+","([\d,]+)\s*K"/,
        );
        resolve(match ? Number.parseInt(match[1].replace(/,/g, ""), 10) : null);
      },
    );
  });
}

function killProcess(childProcess: ReturnType<typeof spawn>): void {
  if (childProcess.pid) {
    try {
      treeKill(childProcess.pid, "SIGKILL");
    } catch {
      /* Process already exited. */
    }
  } else {
    try {
      childProcess.kill("SIGKILL");
    } catch {
      /* Process already exited. */
    }
  }
}

function createResult(
  name: string,
  status: TestCaseRun["status"],
  duration: number,
  timeLimitMs: number,
  peakMemoryKb: number,
  score: number,
  errorDetail: string,
  expectedOutput: string,
  actualOutput: string,
  checkerMessage?: string,
): TestCaseRun {
  return {
    name,
    status,
    executionTime: Math.min(Math.round(duration), timeLimitMs),
    peakMemory: peakMemoryKb > 0 ? peakMemoryKb : undefined,
    score,
    checkerMessage,
    errorDetail,
    expectedOutputPreview: preview(expectedOutput),
    actualOutputPreview: preview(actualOutput),
  };
}

function preview(output: string): string {
  return output.substring(0, 500) + (output.length > 500 ? "..." : "");
}
