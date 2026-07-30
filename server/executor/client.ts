import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { APP_ROOT, IS_PRODUCTION, RESOURCE_ROOT } from "../runtime.js";
import type {
  ExecutorHealth,
  ExecutorRequest,
  ExecutorResponse,
  ExecutorRunResult,
  ExecutorRunSpec,
} from "./protocol.js";

const MAX_FRAME_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
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

interface PendingRequest {
  resolve(response: ExecutorResponse): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class SecureRunnerError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "SecureRunnerError";
  }
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
  private readonly environment: NodeJS.ProcessEnv;
  private readonly shutdownRequestTimeoutMs: number;
  private readonly shutdownExitTimeoutMs: number;
  private readonly startupRetryChildren = new WeakSet<ChildProcessWithoutNullStreams>();

  constructor(options: ExecutorClientOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.environment = { ...(options.environment ?? process.env) };
    this.shutdownRequestTimeoutMs = options.shutdownRequestTimeoutMs ?? SHUTDOWN_REQUEST_TIMEOUT_MS;
    this.shutdownExitTimeoutMs = options.shutdownExitTimeoutMs ?? SHUTDOWN_EXIT_TIMEOUT_MS;
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
    const response = await this.request({ type: "run", id: crypto.randomUUID(), spec }, spec.limits.wallTimeMs + 30_000);
    if (response.type !== "run_result") {
      throw new SecureRunnerError("SECURE_RUNNER_PROTOCOL_ERROR", `Unexpected ${response.type} response to run request.`);
    }
    if (response.result.runId !== spec.runId) {
      throw new SecureRunnerError(
        "SECURE_RUNNER_PROTOCOL_ERROR",
        `Executor result runId mismatch: expected ${spec.runId}, received ${response.result.runId}.`,
      );
    }
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
        this.finishShutdown(child, message);
        throw new SecureRunnerError("SECURE_RUNNER_UNAVAILABLE", message);
      }
      this.finishShutdown(child, "Native executor was stopped after its shutdown request failed.");
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
      this.finishShutdown(child, message);
      throw new SecureRunnerError("SECURE_RUNNER_UNAVAILABLE", message);
    }
    this.finishShutdown(child, "Native executor shut down.");
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
    try {
      const child = spawn(executable, [], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: minimalExecutorEnvironment(this.environment),
      });
      this.child = child;
      child.stdout.on("data", (chunk: Buffer) => this.receive(child, chunk));
      child.stderr.on("data", (chunk: Buffer) => {
        if (this.child !== child) return;
        const remaining = 16 * 1024 - Buffer.byteLength(this.stderrPreview);
        if (remaining > 0) this.stderrPreview += chunk.subarray(0, remaining).toString("utf8");
      });
      child.once("error", (error) => this.executorExited(child, error));
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
      this.cachedHealth = response.health;
    } catch (error) {
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
      await delay(50 * attempt);
    }
    return health;
  }

  private async stopChildForStartupRetry(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.startupRetryChildren.add(child);
    try {
      try {
        await this.request(
          { type: "shutdown", id: crypto.randomUUID() },
          Math.min(this.shutdownRequestTimeoutMs, 2_000),
        );
      } catch {
        child.kill();
      }
      await waitForChildExit(child, this.shutdownExitTimeoutMs);
      if (!childHasExited(child)) {
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
      if (this.child === child) this.child = null;
    } finally {
      this.startupRetryChildren.delete(child);
    }
  }

  private request(request: ExecutorRequest, timeoutMs = REQUEST_TIMEOUT_MS): Promise<ExecutorResponse> {
    const child = this.child;
    if (!child || !child.stdin.writable) {
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
        this.pending.delete(request.id);
        const stderr = this.stderrPreview.trim();
        reject(
          new SecureRunnerError(
            "SECURE_RUNNER_PROTOCOL_ERROR",
            `Executor request ${request.id} timed out.` +
              (stderr ? ` Executor stderr: ${stderr}` : ""),
          ),
        );
      }, timeoutMs);
      this.pending.set(request.id, { resolve, reject, timer });
      child.stdin.write(Buffer.concat([header, payload]), (error) => {
        if (!error) return;
        const pending = this.pending.get(request.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(request.id);
        pending.reject(error);
      });
    }).then((response) => {
      if (response.type === "error") throw new SecureRunnerError(response.code, response.message);
      return response;
    });
  }

  private receive(child: ChildProcessWithoutNullStreams, chunk: Buffer): void {
    if (this.child !== child) return;
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);
    while (this.receiveBuffer.length >= 4) {
      const length = this.receiveBuffer.readUInt32LE(0);
      if (length === 0 || length > MAX_FRAME_BYTES) {
        this.executorExited(
          child,
          new SecureRunnerError("SECURE_RUNNER_PROTOCOL_ERROR", "Executor sent an invalid frame length."),
        );
        return;
      }
      if (this.receiveBuffer.length < length + 4) return;
      const payload = this.receiveBuffer.subarray(4, 4 + length);
      this.receiveBuffer = this.receiveBuffer.subarray(4 + length);
      let response: ExecutorResponse;
      try {
        response = JSON.parse(payload.toString("utf8")) as ExecutorResponse;
      } catch (error) {
        this.executorExited(
          child,
          new SecureRunnerError("SECURE_RUNNER_PROTOCOL_ERROR", String(error)),
        );
        return;
      }
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      pending.resolve(response);
    }
  }

  private executorExited(child: ChildProcessWithoutNullStreams, error: Error): void {
    // An earlier executor may finish after a replacement has already started. Its delayed close
    // event must never clear the replacement or reject the replacement's requests.
    if (this.child !== child) return;
    const startupRetry = this.startupRetryChildren.has(child);
    this.cachedHealth = unavailableHealth(error.message);
    this.child = null;
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
      this.requiresGuardedMacosDrain()
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

  private finishShutdown(
    child: ChildProcessWithoutNullStreams,
    diagnostic: string,
  ): void {
    if (this.child === child && childHasExited(child)) this.child = null;
    this.cachedHealth = unavailableHealth(diagnostic);
    this.lifecycleState = "terminal";
    this.startPromise = Promise.resolve(this.cachedHealth);
  }

  private requiresGuardedMacosDrain(): boolean {
    return this.platform === "darwin" && this.environment.JUDGEDESK_TREE_GUARD_REQUIRED === "1";
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
  const builtInToolchains = environment.JUDGEDESK_BUILTIN_TOOLCHAINS_DIR
    || path.join(environment.THEMIS_RESOURCE_DIR || RESOURCE_ROOT, "toolchains");
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
