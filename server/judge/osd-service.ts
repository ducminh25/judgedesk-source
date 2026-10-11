import fs from "node:fs";
import path from "node:path";
import type { Response } from "express";
import { OsdWatcher } from "./osd-watcher.js";
import { ensureOsdDirectory } from "./osd-files.js";
import type { OsdSource } from "./osd-source.js";
import { writeOsdLog } from "./osd-log-writer.js";
import { sharedJudgeSessionGate } from "./resource-policy.js";
import { resolveProblemConfig } from "../problems/problem-config-repository.js";
import { validateProblemTestInputs } from "../problems/test-wellformed.js";
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
  NormalizedProblemConfig,
} from "../types.js";
import type { PinnedJudgeToolchains } from "./toolchain-preflight.js";

interface OsdJobContext {
  source: OsdSource;
  config: Readonly<OsdConfig>;
  problemConfig: NormalizedProblemConfig;
}

interface OsdJudgeDependencies {
  compileSubmission: typeof compileSubmission;
  resolveCompilationToolchain: typeof resolveCompilationToolchain;
  resolveChecker: typeof resolveChecker;
  runTestCase: typeof runTestCase;
}

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
  private contexts = new Map<string, OsdJobContext>();
  private latestJobs = new Map<string, string>();
  private retryTimer: NodeJS.Timeout | null = null;
  private readonly judge: OsdJudgeDependencies;

  constructor(dependencies: Partial<OsdJudgeDependencies> = {}) {
    this.judge = { compileSubmission, resolveCompilationToolchain, resolveChecker, runTestCase, ...dependencies };
  }

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
    if (this.isJudging || this.queue.length > 0 || this.watcher?.hasPendingSubmissions) {
      return { success: false, message: "Đang nhận/chấm bài hoặc còn bài trong hàng đợi; hãy đợi xử lí xong trước khi đổi phiên OSD." };
    }
    // Terminal jobs whose cleanup failed retain their ownership capability.
    // Retry only those owned leaves, never a recursive sweep of the inbox.
    for (const [jobId, context] of this.contexts) {
      try {
        context.source.dispose();
        this.contexts.delete(jobId);
      } catch (error) {
        return { success: false, message: `Không thể dọn nguồn OSD ${jobId}; kiểm tra quyền truy cập/file đang bị khóa rồi thử lại: ${String(error)}` };
      }
    }
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
      } catch (err) {
        return { success: false, message: `Không thể tạo thư mục OSD: ${String(err)}` };
      }
    }

    let session: Readonly<OsdConfig>;
    try {
      session = Object.freeze({
        osdPath: ensureOsdDirectory(resolvedOsd),
        contestantsPath: ensureOsdDirectory(resolvedContestants),
        testPath: ensureOsdDirectory(resolvedTest),
        enableLog: config.enableLog !== false,
        pollIntervalMs: config.pollIntervalMs ?? 2000,
      });
    } catch (error) {
      return { success: false, message: `Thư mục OSD không an toàn: ${String(error)}` };
    }
    this.config = session;

    this.problemConfigs = structuredClone(problemConfigs ?? {});
    this.latestJobs.clear();

    this.watcher = new OsdWatcher({
      osdPath: this.config.osdPath,
      contestantsPath: this.config.contestantsPath,
      getValidProblems: () => this.getValidProblemList(),
      onSubmissionIngested: (job, isNewContestant, source) => {
        const problemDirectory = ensureOsdDirectory(session.testPath, job.problem);
        const problemConfig = structuredClone(resolveProblemConfig(job.problem, problemDirectory, this.problemConfigs[job.problem]));
        this.contexts.set(job.id, { source, config: session, problemConfig });
        this.latestJobs.set(this.resultKey(job), job.id);
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

    try {
      this.watcher.start();
    } catch (error) {
      this.watcher.stop();
      this.watcher = null;
      return { success: false, message: `Không thể bắt đầu OSD: ${String(error)}` };
    }

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
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.isPaused = false;
    // Stop intake only. Already accepted jobs keep their source and session.
    void this.processNextInQueue();
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
          return fs.lstatSync(path.join(this.config!.testPath, name)).isDirectory();
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
      if (!this.retryTimer) this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        void this.processNextInQueue();
      }, 300);
      return;
    }

    const job = this.queue.shift()!;
    const context = this.contexts.get(job.id);
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
      if (!context) throw new Error("OSD_JOB_CONTEXT_MISSING");
      await this.judgeSingleSubmission(job, context);
    } catch (err) {
      job.status = "failed";
      job.error = err instanceof Error ? err.message : String(err);
      if (context && context.config.enableLog !== false && this.isLatestJob(job)) {
        try {
          writeOsdLog({ osdPath: context.config.osdPath, originalFileName: job.originalFileName,
            contestant: job.contestant, problem: job.problem, errorKind: "judge", errorReason: job.error });
        } catch (error) {
          this.broadcastEvent({ type: "osd_error", data: { message: `Không thể ghi log lỗi OSD: ${String(error)}` } });
        }
      }
      this.broadcastEvent({
        type: "osd_job_failed",
        data: { job, message: job.error },
      });
    } finally {
      sharedJudgeSessionGate.release();
      try {
        context?.source.dispose();
        this.contexts.delete(job.id);
      } catch (error) {
        this.broadcastEvent({ type: "osd_error", data: { message: `Không thể dọn nguồn OSD ${job.id}: ${String(error)}` } });
      }
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

  private resultKey(job: OsdJob): string { return JSON.stringify([job.contestant, job.problem]); }

  private isLatestJob(job: OsdJob): boolean { return this.latestJobs.get(this.resultKey(job)) === job.id; }

  private async judgeSingleSubmission(job: OsdJob, context: OsdJobContext): Promise<void> {
    context.source.assertIntegrity();
    const session = context.config;
    const problemDir = ensureOsdDirectory(session.testPath, job.problem);
    if (!fs.existsSync(problemDir)) {
      throw new Error(`Problem directory not found: ${problemDir}`);
    }

    const config = context.problemConfig;
    if (config.isInteractive) throw new Error("OSD_INTERACTIVE_NOT_SUPPORTED: dùng phiên chấm thủ công cho bài interactive.");
    if (config.testWellFormed) {
      const validation = await validateProblemTestInputs(problemDir, config.isInteractive);
      if (validation.issues.length > 0) {
        const first = validation.issues[0];
        throw new Error(`Test input is not well-formed: ${first.testName}/${first.fileName}:${first.line}:${first.column} (${first.code}); ${validation.issues.length} issue(s)`);
      }
    }
    const plannedTests = planProblemTestCases(problemDir, config);
    if (plannedTests.length === 0) throw new Error("OSD_PROBLEM_HAS_NO_TESTS");
    if (plannedTests.some(test => !test.inputIsText)) throw new Error("OSD_UNREADABLE_TEST_INPUT");

    // Resolve pinned toolchains
    const pinnedEntries = await Promise.all(
      listRegisteredLanguageProfiles().map(async (entry) => [
        entry.toolchainKind,
        Object.freeze(await this.judge.resolveCompilationToolchain(entry.toolchainKind)),
      ] as const),
    );
    const pinnedToolchains = Object.freeze(
      Object.fromEntries(pinnedEntries),
    ) as PinnedJudgeToolchains;

    const submissionToolchain = pinnedToolchains[job.language as SubmissionLanguage];
    if (!submissionToolchain || !submissionToolchain.ready) {
      throw new Error(`Trình biên dịch/runtime '${job.language}' chưa được thiết lập trên máy chủ.`);
    }

    const workspace = createRunWorkspace();
    let checker: CompiledChecker | undefined;

    try {
      const compilation = await this.judge.compileSubmission({
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
      if (compilation.compileStatus !== "OK" && compilation.failureKind !== "submission") {
        throw new Error(compilation.compileError || "OSD_COMPILER_INFRASTRUCTURE_FAILURE");
      }

      const tcRuns: TestCaseRun[] = [];
      const checkerType = config.checkerType;

      if (compilation.compileStatus === "OK") {
        checker = await this.judge.resolveChecker({
          checkerType,
          problemName: job.problem,
          problemDirectory: problemDir,
          tempDirectory: workspace.path,
          cppToolchain: pinnedToolchains.cpp,
          pythonToolchain: pinnedToolchains.python,
        });

        for (const plannedTest of plannedTests) {
          const testFiles = plannedTest.files;

          const tcRes = await this.judge.runTestCase({
            contestant: job.contestant,
            problemName: job.problem,
            testName: testFiles.name,
            language: job.language,
            submissionPath: job.filePath,
            executablePath: compilation.executablePath,
            inputPath: testFiles.inputPath,
            expectedOutputPath: testFiles.outputPath,
            expectedOutputPreview: plannedTest.expectedOutputPreview,
            testRoot: session.testPath,
            contestantsRoot: session.contestantsPath,
            tempDirectory: workspace.path,
            pythonCommand: job.language === "python" ? compilation.executablePath : "",
            timeLimitMs: plannedTest.timeLimitMs,
            score: plannedTest.score,
            scoreExact: plannedTest.scoreExact,
            config,
            checker,
            program: compilation.program,
          });
          if (tcRes.status === "JE" || tcRes.status === "FAIL") {
            throw new Error(tcRes.errorDetail || tcRes.checkerMessage || `OSD_TEST_INFRASTRUCTURE_FAILURE: ${tcRes.name}`);
          }

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

      if (session.enableLog !== false && this.isLatestJob(job)) {
        writeOsdLog({
          osdPath: session.osdPath,
          originalFileName: job.originalFileName,
          contestant: job.contestant,
          problem: job.problem,
          language: job.language,
          result: problemResult,
        });
      }
      job.status = "completed";
      job.result = problemResult;
      if (!this.isLatestJob(job)) return;
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
