import fs from "node:fs";
import path from "node:path";
import type { Response } from "express";
import { OsdWatcher } from "./osd-watcher.js";
import { writeOsdLog } from "./osd-log-writer.js";
import { sharedJudgeSessionGate } from "./resource-policy.js";
import { resolveProblemConfig } from "../problems/problem-config-repository.js";
import { planProblemTestCases } from "./judge-session.js";
import {
  compileSubmission,
  resolveChecker,
  resolveCompilationToolchain,
  type CompiledChecker,
} from "./compiler.js";
import { createRunWorkspace } from "./run-workspace.js";
import { runTestCase } from "./testcase-runner.js";
import { calculateProblemSummary } from "./scoring.js";
import { listRegisteredLanguageProfiles } from "../languages/registry.js";
import type {
  OsdConfig,
  OsdJob,
  OsdStatus,
  OsdStreamEvent,
} from "./osd-types.js";
import type {
  ProblemResult,
  ProblemConfig,
  TestCaseRun,
  SubmissionLanguage,
} from "../types.js";
import type { PinnedJudgeToolchains } from "./toolchain-preflight.js";

export class OsdService {
  private config: OsdConfig | null = null;
  private watcher: OsdWatcher | null = null;
  private queue: OsdJob[] = [];
  private isJudging = false;
  private isPaused = false;
  private currentJob: OsdJob | null = null;
  private lastProcessedJob: OsdJob | null = null;
  private totalProcessed = 0;
  private sseClients = new Set<Response>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private problemConfigs: Record<string, ProblemConfig> = {};

  public get isActive(): boolean {
    return this.watcher !== null && this.watcher.isActive;
  }

  public getStatus(): OsdStatus {
    return {
      active: this.isActive,
      paused: this.isPaused,
      osdPath: this.config?.osdPath ?? null,
      contestantsPath: this.config?.contestantsPath ?? null,
      testPath: this.config?.testPath ?? null,
      enableLog: this.config?.enableLog !== false,
      queueLength: this.queue.length,
      currentJob: this.currentJob,
      totalProcessed: this.totalProcessed,
      lastProcessedJob: this.lastProcessedJob,
    };
  }

  public updateProblemConfigs(configs: Record<string, ProblemConfig>): void {
    this.problemConfigs = { ...this.problemConfigs, ...configs };
  }

  public start(config: OsdConfig, problemConfigs?: Record<string, ProblemConfig>): { success: boolean; message?: string } {
    if (this.isActive) {
      this.stop();
    }

    const resolvedOsd = path.resolve(config.osdPath);
    const resolvedContestants = path.resolve(config.contestantsPath);
    const resolvedTest = path.resolve(config.testPath);

    if (!fs.existsSync(resolvedContestants) || !fs.statSync(resolvedContestants).isDirectory()) {
      return { success: false, message: `Thư mục thí sinh không tồn tại: ${resolvedContestants}` };
    }
    if (!fs.existsSync(resolvedTest) || !fs.statSync(resolvedTest).isDirectory()) {
      return { success: false, message: `Thư mục đề thi không tồn tại: ${resolvedTest}` };
    }
    if (!fs.existsSync(resolvedOsd)) {
      try {
        fs.mkdirSync(resolvedOsd, { recursive: true });
      } catch (err: any) {
        return { success: false, message: `Không thể tạo thư mục OSD: ${err.message}` };
      }
    }

    this.config = {
      osdPath: resolvedOsd,
      contestantsPath: resolvedContestants,
      testPath: resolvedTest,
      enableLog: config.enableLog !== false,
      pollIntervalMs: config.pollIntervalMs ?? 2000,
    };

    if (problemConfigs) {
      this.problemConfigs = problemConfigs;
    }

    this.watcher = new OsdWatcher({
      osdPath: this.config.osdPath,
      contestantsPath: this.config.contestantsPath,
      getValidProblems: () => this.getValidProblemList(),
      onSubmissionIngested: (job, isNewContestant) => {
        if (isNewContestant) {
          this.broadcastEvent({
            type: "osd_contestant_added",
            data: { contestant: job.contestant },
          });
        }
        this.queue.push(job);
        this.broadcastEvent({
          type: "osd_job_queued",
          data: { job, queueLength: this.queue.length },
        });
        this.broadcastEvent({
          type: "osd_status",
          data: this.getStatus(),
        });
        void this.processNextInQueue();
      },
      onError: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.broadcastEvent({
          type: "osd_error",
          data: { message },
        });
      },
      enableLog: this.config.enableLog,
      pollIntervalMs: this.config.pollIntervalMs,
    });

    this.watcher.start();

    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      this.broadcastEvent({
        type: "osd_heartbeat",
        data: { timestamp: Date.now() },
      });
    }, 15000);

    this.broadcastEvent({
      type: "osd_status",
      data: this.getStatus(),
    });

    return { success: true };
  }

  public stop(): void {
    if (this.watcher) {
      this.watcher.stop();
      this.watcher = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.isPaused = false;
    this.broadcastEvent({
      type: "osd_status",
      data: this.getStatus(),
    });
  }

  public pause(): void {
    this.isPaused = true;
    this.broadcastEvent({
      type: "osd_status",
      data: this.getStatus(),
    });
  }

  public resume(): void {
    this.isPaused = false;
    this.broadcastEvent({
      type: "osd_status",
      data: this.getStatus(),
    });
    void this.processNextInQueue();
  }

  public addSseClient(res: Response): () => void {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    this.sseClients.add(res);

    // Send initial status
    res.write(`data: ${JSON.stringify({ type: "osd_status", data: this.getStatus() })}\n\n`);

    const cleanup = () => {
      this.sseClients.delete(res);
    };

    res.on("close", cleanup);
    res.on("finish", cleanup);
    return cleanup;
  }

  private broadcastEvent(event: OsdStreamEvent): void {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(payload);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  private getValidProblemList(): string[] {
    if (!this.config || !fs.existsSync(this.config.testPath)) return [];
    try {
      return fs.readdirSync(this.config.testPath).filter((name) => {
        try {
          return fs.statSync(path.join(this.config!.testPath, name)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      return [];
    }
  }

  private async processNextInQueue(): Promise<void> {
    if (this.isJudging || this.isPaused || this.queue.length === 0 || !this.config) {
      return;
    }

    if (!sharedJudgeSessionGate.tryAcquire()) {
      // Manual judge or another session is busy; retry shortly
      setTimeout(() => {
        void this.processNextInQueue();
      }, 300);
      return;
    }

    const job = this.queue.shift()!;
    this.isJudging = true;
    this.currentJob = job;
    job.status = "judging";

    this.broadcastEvent({
      type: "osd_job_started",
      data: { job },
    });
    this.broadcastEvent({
      type: "osd_status",
      data: this.getStatus(),
    });

    try {
      await this.judgeSingleSubmission(job);
    } catch (err: any) {
      job.status = "failed";
      job.error = err instanceof Error ? err.message : String(err);
      this.broadcastEvent({
        type: "osd_job_failed",
        data: { job, message: job.error },
      });
    } finally {
      sharedJudgeSessionGate.release();
      this.isJudging = false;
      this.lastProcessedJob = job;
      this.currentJob = null;
      this.totalProcessed++;

      this.broadcastEvent({
        type: "osd_status",
        data: this.getStatus(),
      });

      // Schedule next item
      setImmediate(() => {
        void this.processNextInQueue();
      });
    }
  }

  private async judgeSingleSubmission(job: OsdJob): Promise<void> {
    if (!this.config) return;

    const problemDir = path.join(this.config.testPath, job.problem);
    if (!fs.existsSync(problemDir)) {
      throw new Error(`Problem directory not found: ${problemDir}`);
    }

    const config = resolveProblemConfig(
      job.problem,
      problemDir,
      this.problemConfigs[job.problem],
    );
    const plannedTests = planProblemTestCases(problemDir, config);

    // Resolve pinned toolchains
    const pinnedEntries = await Promise.all(
      listRegisteredLanguageProfiles().map(async (entry) => [
        entry.toolchainKind,
        Object.freeze(await resolveCompilationToolchain(entry.toolchainKind)),
      ] as const),
    );
    const pinnedToolchains = Object.freeze(
      Object.fromEntries(pinnedEntries),
    ) as PinnedJudgeToolchains;

    const submissionToolchain = pinnedToolchains[job.language as SubmissionLanguage];
    if (!submissionToolchain || !submissionToolchain.ready) {
      // Compiler/Runtime not available; produce CE problem result
      const ceResult: ProblemResult = {
        problemName: job.problem,
        language: job.language,
        compileStatus: "CE",
        compileError: `Trình biên dịch/runtime '${job.language}' chưa được thiết lập trên máy chủ.`,
        testCases: [],
        summary: {
          total: plannedTests.length,
          passed: 0,
          score: 0,
          maxScore: plannedTests.reduce((acc, t) => acc + t.score, 0),
          status: "CE",
        },
      };

      job.status = "completed";
      job.result = ceResult;

      if (this.config.enableLog !== false) {
        writeOsdLog({
          osdPath: this.config.osdPath,
          originalFileName: job.originalFileName,
          contestant: job.contestant,
          problem: job.problem,
          language: job.language,
          result: ceResult,
        });
      }

      this.broadcastEvent({
        type: "osd_problem_completed",
        data: {
          contestant: job.contestant,
          problemResult: ceResult,
          originalFileName: job.originalFileName,
        },
      });
      return;
    }

    const workspace = createRunWorkspace();
    let checker: CompiledChecker | undefined;

    try {
      const compilation = await compileSubmission({
        language: job.language,
        contestantName: job.contestant,
        problemName: job.problem,
        submissionPath: job.filePath,
        tempDirectory: workspace.path,
        compile: config.compile,
        cppToolchain: pinnedToolchains.cpp,
        cToolchain: pinnedToolchains.c,
        pythonToolchain: pinnedToolchains.python,
        toolchains: pinnedToolchains,
      });

      const tcRuns: TestCaseRun[] = [];
      const checkerType = config.checkerType;

      if (compilation.compileStatus === "OK") {
        checker = await resolveChecker({
          checkerType,
          problemName: job.problem,
          problemDirectory: problemDir,
          tempDirectory: workspace.path,
          cppToolchain: pinnedToolchains.cpp,
          pythonToolchain: pinnedToolchains.python,
        });

        for (const plannedTest of plannedTests) {
          if (!this.isActive) break;
          const testFiles = plannedTest.files;

          if (!plannedTest.inputIsText) {
            compilation.compileStatus = "CE";
            compilation.compileError = `Unreadable input file: ${testFiles.inputFileName}. Only text files are allowed.`;
            break;
          }

          const tcRes = await runTestCase({
            contestant: job.contestant,
            problemName: job.problem,
            testName: testFiles.name,
            language: job.language,
            submissionPath: job.filePath,
            executablePath: compilation.executablePath,
            inputPath: testFiles.inputPath,
            expectedOutputPath: testFiles.outputPath,
            expectedOutputPreview: plannedTest.expectedOutputPreview,
            testRoot: this.config.testPath,
            contestantsRoot: this.config.contestantsPath,
            tempDirectory: workspace.path,
            pythonCommand: job.language === "python" ? compilation.executablePath : "",
            timeLimitMs: plannedTest.timeLimitMs,
            score: plannedTest.score,
            config,
            checker,
            program: compilation.program,
          });

          tcRuns.push(tcRes);
        }
      }

      const summary = calculateProblemSummary({
        compileStatus: compilation.compileStatus,
        testCases: tcRuns,
        testDirectories: plannedTests.map((t) => t.files.name),
        config,
      });

      const problemResult: ProblemResult = {
        problemName: job.problem,
        language: job.language,
        compileStatus: compilation.compileStatus,
        compileError: compilation.compileError,
        compileTime: compilation.compileTime,
        testCases: tcRuns,
        summary,
      };

      job.status = "completed";
      job.result = problemResult;

      if (this.config.enableLog !== false) {
        writeOsdLog({
          osdPath: this.config.osdPath,
          originalFileName: job.originalFileName,
          contestant: job.contestant,
          problem: job.problem,
          language: job.language,
          result: problemResult,
        });
      }

      this.broadcastEvent({
        type: "osd_problem_completed",
        data: {
          contestant: job.contestant,
          problemResult,
          originalFileName: job.originalFileName,
        },
      });
    } finally {
      workspace.dispose();
    }
  }
}

export const osdService = new OsdService();
