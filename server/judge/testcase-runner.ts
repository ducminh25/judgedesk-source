import fs from "fs";
import os from "os";
import path from "path";
import { execSync, spawn } from "child_process";
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
import { isStandardChecker, runStandardChecker } from "./standard-checkers.js";

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
        const profile = `(version 1)
(deny default)
(allow process*)
(allow file-read* (subpath "/System/Library"))
(allow file-read* (subpath "/usr/lib"))
(allow file-read* (subpath "/lib"))
(allow file-read* (subpath "/etc"))
(allow file-read* (subpath "${testRoot}"))
(allow file-read* (subpath "${contestantsRoot}"))
(allow file-read* (subpath "${tempDirectory}"))
(allow file-read* (subpath "${TEMP_ROOT}"))
(allow file-write* (subpath "${tempDirectory}"))
(deny network*)`;
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
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      killProcess(childProcess);
    }, timeLimitMs);

    if (!useIsolate && memoryLimitKb > 0) {
      memoryMonitorInterval = setInterval(() => {
        if (!childProcess.pid) return;
        try {
          if (os.platform() === "win32") {
            const result = spawnSync(
              "tasklist",
              ["/FI", `PID eq ${childProcess.pid}`, "/FO", "CSV", "/NH"],
              {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
                timeout: 1000,
              }
            );
            if (result.status === 0 && result.stdout) {
              const match = result.stdout.match(
                /"[^"]*","\d+","[^"]*","\d+","([\d,]+)\s*K"/
              );
              if (match) {
                const memKb = parseInt(match[1].replace(/,/g, ""), 10);
                if (memKb > peakMemoryKb) {
                  peakMemoryKb = memKb;
                  if (peakMemoryKb > memoryLimitKb) {
                    mleTriggered = true;
                    killProcess(childProcess);
                  }
                }
              }
            }
          } else {
            const result = spawnSync(
              "ps",
              ["-p", String(childProcess.pid), "-o", "rss="],
              {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
                timeout: 1000,
              }
            );
            if (result.status === 0 && result.stdout) {
              const memKb = parseInt(result.stdout.trim(), 10);
              if (!isNaN(memKb) && memKb > peakMemoryKb) {
                peakMemoryKb = memKb;
                if (peakMemoryKb > memoryLimitKb) {
                  mleTriggered = true;
                  killProcess(childProcess);
                }
              }
            }
          }
        } catch {
          // Ignore
        }
      }, 100);
    }
    childProcess.stdout.on("data", (chunk) => {
      if (stdout.length >= MAX_OUTPUT_SIZE) return;
      stdout += chunk.toString();
      if (stdout.length >= MAX_OUTPUT_SIZE) {
        stdout = stdout.substring(0, MAX_OUTPUT_SIZE);
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
      if (memoryMonitorInterval) clearInterval(memoryMonitorInterval);
      const duration = Number(process.hrtime.bigint() - startTime) / 1_000_000;
      let status: TestCaseRun["status"] = "AC";
      let errorDetail = "";

      if (useIsolate) {
        let output = "";
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
              output = fs.readFileSync(hostOutputPath, "utf8");
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
              output = fs.readFileSync(hostOutputPath, "utf8");
          } catch (error) {
            console.error(
              `[Runner FileIO Error] for ${outputFilename}:`,
              error,
            );
          }
        }
        stdout = output;
      } else if (!config.useStdOut) {
        const outputPath = path.join(tempDirectory, outputFilename);
        const output = fs.existsSync(outputPath)
          ? fs.readFileSync(outputPath, "utf8")
          : "";
        stdout = output || stdout;
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
        fs.writeFileSync(actualOutputPath, stdout, "utf8");
        if (isStandardChecker(config.checkerType)) {
          const result = runStandardChecker(
            config.checkerType,
            expectedOutput,
            stdout,
          );
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
