import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  APP_ROOT,
  IS_PRODUCTION,
  normalizeWindowsVerbatimPath,
  RESOURCE_ROOT,
} from "../runtime.js";
import type {
  ExecutorHealth,
  ExecutorInteractiveRunResult,
  ExecutorInteractiveRunSpec,
  ExecutorRequest,
  ExecutorResponse,
  ExecutorRunResult,
  ExecutorRunSpec,
} from "./protocol.js";
import { isExecutorRunReason } from "./protocol.js";
import { logJudgeDiagnostic, measureDiagnosticPhase } from "../diagnostics.js";

const MAX_FRAME_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 45_000;
const CANCEL_REQUEST_TIMEOUT_MS = 30_000;
const STARTUP_SELF_TEST_ATTEMPTS = 3;
const SHUTDOWN_REQUEST_TIMEOUT_MS = 10_000;
const SHUTDOWN_EXIT_TIMEOUT_MS = 1_000;

type ExecutorLifecycleState = "idle" | "starting" | "running" | "draining" | "terminal";

export interface ExecutorClientOptions {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  shutdownRequestTimeoutMs?: number;
  shutdownExitTimeoutMs?: number;
}

export interface StandaloneTreeGuard {
  environment: NodeJS.ProcessEnv;
  cleanup(): void;
}

export function createStandaloneTreeGuard(): StandaloneTreeGuard {
  const guardDir = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-node-tree-guard-"));
  if (process.platform !== "win32") fs.chmodSync(guardDir, 0o700);
  const generation = crypto.randomBytes(32).toString("hex");
  const guardPath = path.join(guardDir, "process-tree.lock");
  try {
    fs.writeFileSync(
      guardPath,
      `JUDGEDESK_PROCESS_TREE/1\ngeneration=${generation}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    fs.rmSync(guardDir, { recursive: true, force: true });
    throw error;
  }
  return {
    environment: {
      JUDGEDESK_TREE_GUARD_REQUIRED: "1",
      JUDGEDESK_TREE_GUARD_PATH: guardPath,
      JUDGEDESK_TREE_GUARD_GENERATION: generation,
      JUDGEDESK_PARENT_PID: String(process.pid),
    },
    cleanup: () => {
      try {
        fs.rmSync(guardDir, { recursive: true, force: true });
      } catch (error) {
        console.error(`Failed to remove owned executor tree guard: ${String(error)}`);
      }
    },
  };
}

interface PendingRequest {
  resolve(response: ExecutorResponse): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  expectedResponseType: Exclude<ExecutorResponse["type"], "error">;
}

export class SecureRunnerError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "SecureRunnerError";
  }
}

function expectedResponseType(
  request: ExecutorRequest,
): Exclude<ExecutorResponse["type"], "error"> {
  switch (request.type) {
    case "health": return "health";
    case "run": return "run_result";
    case "interactive_run": return "interactive_run_result";
    case "cancel": return "cancel_result";
    case "shutdown": return "shutdown_result";
  }
}

function responseMatchesPending(
  response: ExecutorResponse,
  expected: Exclude<ExecutorResponse["type"], "error">,
): boolean {
  if (response.type === "error") return true;
  if (response.type !== expected) return false;
  switch (response.type) {
    case "health": return typeof response.health === "object" && response.health !== null;
    case "run_result": return typeof response.result === "object" && response.result !== null;
    case "interactive_run_result": return typeof response.result === "object" && response.result !== null;
    case "cancel_result": return typeof response.runId === "string" && typeof response.cancelled === "boolean";
    case "shutdown_result": return true;
  }
}

function isExecutorResponse(value: unknown): value is ExecutorResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  if (typeof response.id !== "string" || typeof response.type !== "string") return false;
  switch (response.type) {
    case "health":
      return typeof response.health === "object" && response.health !== null && !Array.isArray(response.health);
    case "run_result":
      return hasKnownRunReason(response.result);
    case "interactive_run_result":
      if (typeof response.result !== "object" || response.result === null || Array.isArray(response.result)) return false;
      return hasKnownRunReason((response.result as Record<string, unknown>).submissionResult)
        && hasKnownRunReason((response.result as Record<string, unknown>).interactorResult);
    case "cancel_result":
      return typeof response.runId === "string" && typeof response.cancelled === "boolean";
    case "shutdown_result":
      return true;
    case "error":
      return typeof response.code === "string" && typeof response.message === "string";
    default:
      return false;
  }
}

function hasKnownRunReason(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && isExecutorRunReason((value as Record<string, unknown>).reason);
}

export class ExecutorClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, PendingRequest>();
  private receiveBuffer = Buffer.alloc(0);
  private cachedHealth: ExecutorHealth = unavailableHealth("Executor has not started.");
  private startPromise: Promise<ExecutorHealth> | null = null;
  private stderrPreview = "";
  private lifecycleState: ExecutorLifecycleState = "idle";
  private readonly platform: NodeJS.Platform;
  private readonly explicitEnvironment?: NodeJS.ProcessEnv;
  private readonly shutdownRequestTimeoutMs: number;
  private readonly shutdownExitTimeoutMs: number;
  private readonly startupRetryChildren = new WeakSet<ChildProcessWithoutNullStreams>();
  private ownedTreeGuardCleanup: (() => void) | null = null;
  private guardedDrainChild: ChildProcessWithoutNullStreams | null = null;

  constructor(options: ExecutorClientOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.explicitEnvironment = options.environment ? { ...options.environment } : undefined;
    this.shutdownRequestTimeoutMs = options.shutdownRequestTimeoutMs ?? SHUTDOWN_REQUEST_TIMEOUT_MS;
    this.shutdownExitTimeoutMs = options.shutdownExitTimeoutMs ?? SHUTDOWN_EXIT_TIMEOUT_MS;
  }

  private getEnvironment(): NodeJS.ProcessEnv {
    const environment = this.explicitEnvironment ? { ...this.explicitEnvironment } : { ...process.env };
    // Native executor authenticates its direct kernel parent. When this legacy client runs
    // under the Tauri sidecar, that parent is Node rather than the Tauri process.
    environment.JUDGEDESK_PARENT_PID = String(process.pid);
    return environment;
  }

  get health(): ExecutorHealth {
    return this.cachedHealth;
  }

  async start(): Promise<ExecutorHealth> {
    if (this.cannotStart()) {
      return this.cachedHealth;
    }
    if (this.startPromise) return this.startPromise;
    this.lifecycleState = "starting";
    const startup = this.startWithTransientRetry();
    this.startPromise = startup;
    const health = await startup;
    // executorExited deliberately clears this exact startup slot for an unguarded child so the
    // next call can retry. Do not let this older continuation cache its failed result again.
    if (this.startPromise !== startup) return this.cachedHealth;
    if (this.cannotStart()) {
      this.startPromise = Promise.resolve(this.cachedHealth);
      return this.cachedHealth;
    }
    this.lifecycleState = this.child ? "running" : "idle";
    // executorExited clears this value. Otherwise retain the settled result so
    // repeated /api/status requests never launch duplicate executor processes.
    this.startPromise = Promise.resolve(health);
    return health;
  }

  async run(
    spec: ExecutorRunSpec,
    beforeSubmit?: () => void,
  ): Promise<ExecutorRunResult> {
    const health = await this.start();
    if (!health.ready) {
      throw new SecureRunnerError(
        "SECURE_RUNNER_UNAVAILABLE",
        health.diagnostics.join("; ") || "Native secure runner is unavailable.",
      );
    }
    // This hook and request()'s pipe write run in the same JavaScript turn.
    // Judge jobs use it to atomically cross the reserved -> started boundary:
    // cancellation either blocks this submit or observes a started run that it
    // can cancel through the same ordered executor pipe.
    beforeSubmit?.();
    const context = { phase: "native-run", runId: spec.runId, role: spec.role, executorPid: this.child?.pid };
    logJudgeDiagnostic({ ...context, status: "started", wallLimitMs: spec.limits.wallTimeMs });
    const response = await measureDiagnosticPhase(context, () => this.request({ type: "run", id: crypto.randomUUID(), spec },
      spec.limits.wallTimeMs + 30_000,
    ));
    if (response.type !== "run_result") {
      throw new SecureRunnerError("SECURE_RUNNER_PROTOCOL_ERROR", `Unexpected ${response.type} response to run request.`);
    }
    if (response.result.runId !== spec.runId) {
      throw new SecureRunnerError(
        "SECURE_RUNNER_PROTOCOL_ERROR",
        `Executor result runId mismatch: expected ${spec.runId}, received ${response.result.runId}.`,
      );
    }
    logJudgeDiagnostic({
      ...context, phase: "native-result", reason: response.result.reason,
      exitCode: response.result.exitCode ?? undefined,
      securitySetupMs: response.result.securitySetupTimeUs / 1_000,
      nativeWallMs: response.result.wallTimeUs / 1_000,
      collectionMs: response.result.resultCollectionTimeUs / 1_000,
      userCpuMs: response.result.userCpuTimeUs === undefined ? undefined : response.result.userCpuTimeUs / 1_000,
      kernelCpuMs: response.result.kernelCpuTimeUs === undefined ? undefined : response.result.kernelCpuTimeUs / 1_000,
    });
    return response.result;
  }

  async runInteractive(
    spec: ExecutorInteractiveRunSpec,
    beforeSubmit?: () => void,
  ): Promise<ExecutorInteractiveRunResult> {
    const health = await this.start();
    if (!health.ready) {
      throw new SecureRunnerError(
        "SECURE_RUNNER_UNAVAILABLE",
        health.diagnostics.join("; ") || "Native secure runner is unavailable.",
      );
    }
    beforeSubmit?.();
    const timeoutMs = (spec.submission.limits.wallTimeMs * 2) + 30_000;
    const context = { phase: "native-interactive-run", runId: spec.runId,
      submissionRunId: spec.submission.runId, interactorRunId: spec.interactor.runId,
      executorPid: this.child?.pid };
    logJudgeDiagnostic({ ...context, status: "started" });
    const response = await measureDiagnosticPhase(context, () => this.request(
      { type: "interactive_run", id: crypto.randomUUID(), spec },
      timeoutMs,
    ));
    if (response.type !== "interactive_run_result") {
      throw new SecureRunnerError(
        "SECURE_RUNNER_PROTOCOL_ERROR",
        `Unexpected ${response.type} response to interactive_run request.`,
      );
    }
    if (response.result.runId !== spec.runId) {
      throw new SecureRunnerError(
        "SECURE_RUNNER_PROTOCOL_ERROR",
        `Executor result runId mismatch: expected ${spec.runId}, received ${response.result.runId}.`,
      );
    }
    logJudgeDiagnostic({ ...context, phase: "native-interactive-result", verdict: response.result.verdict,
      submissionReason: response.result.submissionResult.reason, interactorReason: response.result.interactorResult.reason,
      submissionWallMs: response.result.submissionResult.wallTimeUs / 1_000,
      interactorWallMs: response.result.interactorResult.wallTimeUs / 1_000 });
    return response.result;
  }

  async cancel(runId: string): Promise<boolean> {
    if (!this.child) return false;
    // The native response is a process-container drain acknowledgement. Its timeout must exceed
    // the guardian's bounded preferred/forced cleanup windows rather than merely a signal send.
    const response = await this.request(
      { type: "cancel", id: crypto.randomUUID(), runId },
      CANCEL_REQUEST_TIMEOUT_MS,
    );
    if (response.type !== "cancel_result") return false;
    if (response.runId !== runId) {
      throw new SecureRunnerError(
        "SECURE_RUNNER_PROTOCOL_ERROR",
        `Executor cancellation runId mismatch: expected ${runId}, received ${response.runId}.`,
      );
    }
    return response.cancelled;
  }

  async shutdown(): Promise<void> {
    const child = this.child;
    if (!child) {
      this.lifecycleState = "terminal";
      if (this.cachedHealth.ready) {
        this.cachedHealth = unavailableHealth("Native executor is no longer running.");
      }
      this.startPromise = Promise.resolve(this.cachedHealth);
      return;
    }
    if (this.lifecycleState === "terminal") {
      await waitForChildExit(child, this.shutdownExitTimeoutMs);
      if (!childHasExited(child)) {
        if (this.requiresGuardedMacosDrain(child)) {
          throw new SecureRunnerError(
            "SECURE_RUNNER_UNAVAILABLE",
            this.cachedHealth.diagnostics[0]
              || "Native executor drain is still in progress; the macOS process-tree guard remains held.",
          );
        }
        child.kill();
        await waitForChildExit(child, this.shutdownExitTimeoutMs);
        if (!childHasExited(child)) {
          const detail = this.cachedHealth.diagnostics[0] || "Native executor terminal failure.";
          throw new SecureRunnerError(
            "SECURE_RUNNER_UNAVAILABLE",
            `Native executor did not exit after terminal failure: ${detail}`,
          );
        }
      }
      return;
    }
    this.lifecycleState = "draining";
    this.cachedHealth = unavailableHealth("Native executor shutdown is in progress.");
    this.startPromise = Promise.resolve(this.cachedHealth);
    try {
      const response = await this.request(
        { type: "shutdown", id: crypto.randomUUID() },
        this.shutdownRequestTimeoutMs,
      );
      if (response.type !== "shutdown_result") {
        throw new SecureRunnerError(
          "SECURE_RUNNER_PROTOCOL_ERROR",
          `Unexpected ${response.type} response to shutdown request.`,
        );
      }
    } catch (error) {
      if (this.requiresGuardedMacosDrain()) {
        if (this.child === child && !childHasExited(child)) {
          this.lifecycleState = "draining";
          this.cachedHealth = unavailableHealth(
            "Native executor drain is still in progress; the macOS process-tree guard remains held.",
          );
        } else {
          this.lifecycleState = "terminal";
          this.cachedHealth = unavailableHealth(error instanceof Error ? error.message : String(error));
        }
        this.startPromise = Promise.resolve(this.cachedHealth);
        // Killing the executor here would release the generation barrier before its active
        // process groups have proved empty. The backend/supervisor recovery path owns any
        // subsequent force-drain decision.
        throw error;
      }
      child.kill();
      await waitForChildExit(child, this.shutdownExitTimeoutMs);
      if (!childHasExited(child)) {
        const detail = error instanceof Error ? error.message : String(error);
        const message =
          `Native executor did not exit after its shutdown request failed: ${detail}`;
        this.finishShutdown(message);
        throw new SecureRunnerError("SECURE_RUNNER_UNAVAILABLE", message);
      }
      this.finishShutdown("Native executor was stopped after its shutdown request failed.");
      return;
    }

    // A valid acknowledgement is emitted only after every accepted run has produced its terminal
    // frame and every native process container is empty. Give the executor time to exit naturally;
    // after that barrier it is safe to terminate an executor that is itself stuck during teardown.
    await waitForChildExit(child, this.shutdownExitTimeoutMs);
    if (!childHasExited(child)) {
      child.kill();
      await waitForChildExit(child, this.shutdownExitTimeoutMs);
    }
    if (!childHasExited(child)) {
      const message = "Native executor acknowledged shutdown but did not exit.";
      this.finishShutdown(message);
      throw new SecureRunnerError("SECURE_RUNNER_UNAVAILABLE", message);
    }
    this.finishShutdown("Native executor shut down.");
  }

  async waitForStdioClose(timeoutMs = this.shutdownExitTimeoutMs): Promise<boolean> {
    const child = this.child;
    if (!child) return true;
    await waitForChildClose(child, timeoutMs);
    return this.child !== child;
  }

  private async startInternal(): Promise<ExecutorHealth> {
    if (this.cannotStart()) return this.cachedHealth;
    this.receiveBuffer = Buffer.alloc(0);
    this.stderrPreview = "";
    const executable = resolveExecutorPath();
    if (!executable) {
      this.cachedHealth = unavailableHealth("SECURE_RUNNER_BINARY_MISSING");
      return this.cachedHealth;
    }
    const env = { ...this.getEnvironment() };
    if (env.JUDGEDESK_TREE_GUARD_REQUIRED !== "1") {
      if (
        env.JUDGEDESK_TREE_GUARD_REQUIRED !== undefined
        || env.JUDGEDESK_TREE_GUARD_PATH !== undefined
        || env.JUDGEDESK_TREE_GUARD_GENERATION !== undefined
      ) {
        this.cachedHealth = unavailableHealth("Partial or invalid executor tree guard environment.");
        this.lifecycleState = "terminal";
        return this.cachedHealth;
      }
      const guard = createStandaloneTreeGuard();
      Object.assign(env, guard.environment);
      this.ownedTreeGuardCleanup = guard.cleanup;
    } else if (!env.JUDGEDESK_TREE_GUARD_PATH || !env.JUDGEDESK_TREE_GUARD_GENERATION) {
      this.cachedHealth = unavailableHealth("Required executor tree guard environment is incomplete.");
      this.lifecycleState = "terminal";
      return this.cachedHealth;
    }
    try {
      const startupStarted = performance.now();
      const child = spawn(executable, [], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: minimalExecutorEnvironment(env),
      });
      this.child = child;
      this.guardedDrainChild = env.JUDGEDESK_TREE_GUARD_REQUIRED === "1" ? child : null;
      child.stdout.on("data", (chunk: Buffer) => this.receive(child, chunk));
      child.stderr.on("data", (chunk: Buffer) => {
        if (this.child !== child) return;
        const remaining = 16 * 1024 - Buffer.byteLength(this.stderrPreview);
        if (remaining > 0) this.stderrPreview += chunk.subarray(0, remaining).toString("utf8");
      });
      child.once("error", (error) => this.executorErrored(child, error));
      child.once("close", (code, signal) => {
        this.executorExited(
          child,
          new Error(`Native executor exited (code=${code}, signal=${signal}). ${this.stderrPreview}`),
        );
      });
      // IPC must not keep one-shot unit-test/CLI processes alive. Long-running server
      // processes remain alive through their HTTP listener; when they exit, pipe EOF makes
      // the executor kill active jobs and terminate.
      child.unref();
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        (stream as unknown as { unref?: () => void }).unref?.();
      }
      const response = await this.request({ type: "health", id: crypto.randomUUID() }, REQUEST_TIMEOUT_MS);
      if (response.type !== "health") {
        throw new SecureRunnerError("SECURE_RUNNER_PROTOCOL_ERROR", `Unexpected ${response.type} health response.`);
      }
      this.cachedHealth = {
        ...response.health,
        clientStartupTimeMs: performance.now() - startupStarted,
      };
    } catch (error) {
      const child = this.child;
      if (child && !childHasExited(child)) {
        child.stdin.end();
        await waitForChildExit(child, this.shutdownExitTimeoutMs);
      }
      if (child && !childHasExited(child)) {
        this.lifecycleState = "terminal";
        this.cachedHealth = unavailableHealth(
          `Native executor startup failed and its guarded drain is still in progress: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        this.startPromise = Promise.resolve(this.cachedHealth);
        return this.cachedHealth;
      }
      if (this.ownedTreeGuardCleanup) {
        this.ownedTreeGuardCleanup();
        this.ownedTreeGuardCleanup = null;
      }
      this.cachedHealth = unavailableHealth(error instanceof Error ? error.message : String(error));
    }
    return this.cachedHealth;
  }

  private async startWithTransientRetry(): Promise<ExecutorHealth> {
    let health = unavailableHealth("Native executor startup did not run.");
    for (let attempt = 1; attempt <= STARTUP_SELF_TEST_ATTEMPTS; attempt += 1) {
      if (this.cannotStart()) return this.cachedHealth;
      health = await this.startInternal();
      if (this.cannotStart()) return this.cachedHealth;
      if (!isTransientExecutorStartupFailure(health) || attempt === STARTUP_SELF_TEST_ATTEMPTS) {
        return health;
      }
      await this.stopChildForStartupRetry();
      await delay(500 * attempt);
    }
    return health;
  }

  private async stopChildForStartupRetry(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.startupRetryChildren.add(child);
    try {
      let shutdownAcknowledged = false;
      try {
        const response = await this.request(
          { type: "shutdown", id: crypto.randomUUID() },
          Math.min(this.shutdownRequestTimeoutMs, 2_000),
        );
        if (response.type !== "shutdown_result") {
          throw new SecureRunnerError(
            "SECURE_RUNNER_PROTOCOL_ERROR",
            `Unexpected ${response.type} response to startup-retry shutdown request.`,
          );
        }
        shutdownAcknowledged = true;
      } catch (error) {
        if (this.requiresGuardedMacosDrain(child)) {
          this.cachedHealth = unavailableHealth(
            `Native executor startup retry could not prove guarded drain: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          this.lifecycleState = "terminal";
          this.startPromise = Promise.resolve(this.cachedHealth);
          return;
        }
        child.kill();
      }
      await waitForChildExit(child, this.shutdownExitTimeoutMs);
      if (!childHasExited(child) && shutdownAcknowledged) {
        child.kill();
        await waitForChildExit(child, this.shutdownExitTimeoutMs);
      }
      if (!childHasExited(child)) {
        if (this.child === child) {
          this.cachedHealth = unavailableHealth(
            "Native executor did not exit before a startup retry; restart JudgeDesk before retrying.",
          );
          this.lifecycleState = "terminal";
          this.startPromise = Promise.resolve(this.cachedHealth);
        }
        return;
      }
      if (this.child === child) {
        await waitForChildClose(child, this.shutdownExitTimeoutMs);
      }
      if (this.child === child) {
        this.cachedHealth = unavailableHealth(
          "Native executor stdio did not close before a startup retry; restart JudgeDesk before retrying.",
        );
        this.lifecycleState = "terminal";
        this.startPromise = Promise.resolve(this.cachedHealth);
      }
    } finally {
      this.startupRetryChildren.delete(child);
    }
  }

  private request(request: ExecutorRequest, timeoutMs = REQUEST_TIMEOUT_MS): Promise<ExecutorResponse> {
    const child = this.child;
    if (!child || !child.stdin.writable || this.lifecycleState === "terminal") {
      return Promise.reject(new SecureRunnerError("SECURE_RUNNER_UNAVAILABLE", "Native executor is not running."));
    }
    const payload = Buffer.from(JSON.stringify(request), "utf8");
    if (payload.length === 0 || payload.length > MAX_FRAME_BYTES) {
      return Promise.reject(new SecureRunnerError("SECURE_RUNNER_PROTOCOL_ERROR", "Executor request is too large."));
    }
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32LE(payload.length);
    return new Promise<ExecutorResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        const stderr = this.stderrPreview.trim();
        this.terminalizeLiveChild(
          child,
          new SecureRunnerError(
            "SECURE_RUNNER_PROTOCOL_ERROR",
            `Executor request ${request.id} timed out.` +
              (stderr ? ` Executor stderr: ${stderr}` : ""),
          ),
        );
      }, timeoutMs);
      this.pending.set(request.id, {
        resolve,
        reject,
        timer,
        expectedResponseType: expectedResponseType(request),
      });
      child.stdin.write(Buffer.concat([header, payload]), (error) => {
        if (!error) return;
        this.terminalizeLiveChild(child, error);
      });
    }).then((response) => {
      if (response.type === "error") throw new SecureRunnerError(response.code, response.message);
      return response;
    });
  }

  private receive(child: ChildProcessWithoutNullStreams, chunk: Buffer): void {
    if (this.child !== child || this.lifecycleState === "terminal") return;
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);
    while (this.receiveBuffer.length >= 4) {
      const length = this.receiveBuffer.readUInt32LE(0);
      if (length === 0 || length > MAX_FRAME_BYTES) {
        this.terminalizeProtocol(
          child,
          new SecureRunnerError("SECURE_RUNNER_PROTOCOL_ERROR", "Executor sent an invalid frame length."),
        );
        return;
      }
      if (this.receiveBuffer.length < length + 4) return;
      const payload = this.receiveBuffer.subarray(4, 4 + length);
      this.receiveBuffer = this.receiveBuffer.subarray(4 + length);
      let decoded: unknown;
      try {
        decoded = JSON.parse(payload.toString("utf8")) as unknown;
      } catch (error) {
        this.terminalizeProtocol(
          child,
          new SecureRunnerError("SECURE_RUNNER_PROTOCOL_ERROR", String(error)),
        );
        return;
      }
      if (!isExecutorResponse(decoded)) {
        this.terminalizeProtocol(
          child,
          new SecureRunnerError(
            "SECURE_RUNNER_PROTOCOL_ERROR",
            "Executor sent an invalid response envelope.",
          ),
        );
        return;
      }
      const response = decoded;
      const pending = this.pending.get(response.id);
      if (!pending) {
        this.terminalizeProtocol(
          child,
          new SecureRunnerError(
            "SECURE_RUNNER_PROTOCOL_ERROR",
            `Executor sent an unknown correlation ID: ${response.id}.`,
          ),
        );
        return;
      }
      if (!responseMatchesPending(response, pending.expectedResponseType)) {
        this.terminalizeProtocol(
          child,
          new SecureRunnerError(
            "SECURE_RUNNER_PROTOCOL_ERROR",
            `Executor sent ${response.type} for a ${pending.expectedResponseType} request.`,
          ),
        );
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      pending.resolve(response);
    }
  }

  private terminalizeProtocol(child: ChildProcessWithoutNullStreams, error: Error): void {
    this.terminalizeLiveChild(child, error);
  }

  private executorErrored(child: ChildProcessWithoutNullStreams, error: Error): void {
    this.terminalizeLiveChild(child, error);
  }

  private terminalizeLiveChild(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child || this.lifecycleState === "terminal") return;
    if (!this.startupRetryChildren.has(child)) {
      this.cachedHealth = unavailableHealth(error.message);
      this.lifecycleState = "terminal";
      this.startPromise = Promise.resolve(this.cachedHealth);
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    // Native executor treats EOF as the ordered cancellation/drain boundary. Keep the
    // child and its guard attached until its close event proves that drain completed.
    child.stdin.end();
  }

  private executorExited(child: ChildProcessWithoutNullStreams, error: Error): void {
    // An earlier executor may finish after a replacement has already started. Its delayed close
    // event must never clear the replacement or reject the replacement's requests.
    if (this.child !== child) return;
    const guardedMacosDrain = this.requiresGuardedMacosDrain(child);
    if (this.ownedTreeGuardCleanup) {
      this.ownedTreeGuardCleanup();
      this.ownedTreeGuardCleanup = null;
    }
    const startupRetry = this.startupRetryChildren.has(child);
    const preserveTerminalDiagnostic =
      this.lifecycleState === "draining" || this.lifecycleState === "terminal";
    if (!preserveTerminalDiagnostic) {
      this.cachedHealth = unavailableHealth(error.message);
    }
    this.child = null;
    if (this.guardedDrainChild === child) this.guardedDrainChild = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (startupRetry) {
      this.lifecycleState = "starting";
      return;
    }
    if (
      guardedMacosDrain
      || this.lifecycleState === "draining"
      || this.lifecycleState === "terminal"
    ) {
      this.lifecycleState = "terminal";
      this.startPromise = Promise.resolve(this.cachedHealth);
    } else {
      this.lifecycleState = "idle";
      this.startPromise = null;
    }
  }

  private finishShutdown(diagnostic: string): void {
    // `exit` only proves that the process has stopped. Retain both references until `close`
    // confirms that stdio has drained, because executorExited owns the guard cleanup.
    this.cachedHealth = unavailableHealth(diagnostic);
    this.lifecycleState = "terminal";
    this.startPromise = Promise.resolve(this.cachedHealth);
  }

  private requiresGuardedMacosDrain(child = this.child): boolean {
    return this.platform === "darwin" && child !== null && this.guardedDrainChild === child;
  }

  private cannotStart(): boolean {
    return this.lifecycleState === "draining" || this.lifecycleState === "terminal";
  }
}

export interface ExecutorPathContext {
  platform?: NodeJS.Platform;
  arch?: string;
  execPath?: string;
  appRoot?: string;
  cwd?: string;
  override?: string;
  production?: boolean;
}

export function executorPathCandidates(context: ExecutorPathContext = {}): string[] {
  const platform = context.platform ?? os.platform();
  const arch = context.arch ?? os.arch();
  const execPath = context.execPath ?? process.execPath;
  const appRoot = context.appRoot ?? APP_ROOT;
  const cwd = context.cwd ?? process.cwd();
  const production = context.production ?? IS_PRODUCTION;
  const override = context.override ?? process.env.JUDGEDESK_EXECUTOR_PATH;
  const extension = platform === "win32" ? ".exe" : "";
  const runtimeName = `judgedesk-executor${extension}`;
  const bundledName = `judgedesk-executor-${targetTriple(platform, arch)}${extension}`;

  return [
    override,
    // Tauri copies external binaries beside the application/sidecar and removes
    // the target-triple suffix from the runtime filename.
    path.join(path.dirname(execPath), runtimeName),
    path.join(path.dirname(execPath), bundledName),
    path.join(appRoot, runtimeName),
    path.join(appRoot, bundledName),
    path.join(cwd, "src-tauri", "binaries", bundledName),
    !production ? path.join(cwd, "native-executor", "target", "debug", `judgedesk-native-executor${extension}`) : undefined,
  ].filter((value): value is string => !!value);
}

function resolveExecutorPath(): string | null {
  const candidates = executorPathCandidates();
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? null;
}

function targetTriple(platform: NodeJS.Platform, arch: string): string {
  if (platform === "win32" && arch === "x64") return "x86_64-pc-windows-msvc";
  if (platform === "darwin" && arch === "arm64") return "aarch64-apple-darwin";
  if (platform === "darwin" && arch === "x64") return "x86_64-apple-darwin";
  return `${arch}-${platform}`;
}

function minimalExecutorEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // The executor is trusted and needs the user's AppContainer/profile variables during its
  // startup self-test. It constructs a separate allowlisted environment for every untrusted
  // child, so credentials and proxy variables are never forwarded to submissions.
  const result = { ...environment };
  const resourceRoot = normalizeWindowsVerbatimPath(
    environment.THEMIS_RESOURCE_DIR || RESOURCE_ROOT,
  );
  if (environment.THEMIS_RESOURCE_DIR) {
    result.THEMIS_RESOURCE_DIR = resourceRoot;
  }
  const builtInToolchains = normalizeWindowsVerbatimPath(
    environment.JUDGEDESK_BUILTIN_TOOLCHAINS_DIR
      || path.join(resourceRoot, "toolchains"),
  );
  if (fs.existsSync(builtInToolchains)) {
    result.JUDGEDESK_BUILTIN_TOOLCHAINS_DIR = path.resolve(builtInToolchains);
  } else {
    delete result.JUDGEDESK_BUILTIN_TOOLCHAINS_DIR;
  }
  return result;
}

export function isTransientExecutorStartupFailure(health: ExecutorHealth): boolean {
  return !health.ready && health.diagnostics.some((diagnostic) =>
    diagnostic.includes("SECURE_RUNNER_SELF_TEST_FAILED: security probe returned invalid JSON: EOF")
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (childHasExited(child)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      child.off("exit", done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    child.once("exit", done);
  });
}

function waitForChildClose(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      child.off("close", done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    child.once("close", done);
  });
}

function childHasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function unavailableHealth(diagnostic: string): ExecutorHealth {
  return {
    ready: false,
    mode: "unavailable",
    executorVersion: "unknown",
    executorRoot: "",
    diagnostics: [diagnostic],
    networkBlocked: false,
    filesystemIsolated: false,
    processTreeControlled: false,
    memoryLimitSupported: false,
  };
}

export const executorClient = new ExecutorClient();
