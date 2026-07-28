import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { APP_ROOT, IS_PRODUCTION } from "../runtime.js";
import type {
  ExecutorHealth,
  ExecutorRequest,
  ExecutorResponse,
  ExecutorRunResult,
  ExecutorRunSpec,
} from "./protocol.js";

const MAX_FRAME_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const STARTUP_SELF_TEST_ATTEMPTS = 3;

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

  get health(): ExecutorHealth {
    return this.cachedHealth;
  }

  async start(): Promise<ExecutorHealth> {
    if (this.startPromise) return this.startPromise;
    const startup = this.startWithTransientRetry();
    this.startPromise = startup;
    const health = await startup;
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
    return response.result;
  }

  async cancel(runId: string): Promise<boolean> {
    if (!this.child) return false;
    const response = await this.request({ type: "cancel", id: crypto.randomUUID(), runId }, 10_000);
    if (response.type !== "cancel_result") return false;
    return response.cancelled;
  }

  async shutdown(): Promise<void> {
    const child = this.child;
    if (!child) return;
    try {
      await this.request({ type: "shutdown", id: crypto.randomUUID() }, 10_000);
    } catch {
      child.kill();
    }
    this.child = null;
    this.startPromise = null;
  }

  private async startInternal(): Promise<ExecutorHealth> {
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
        env: minimalExecutorEnvironment(),
      });
      this.child = child;
      child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
      child.stderr.on("data", (chunk: Buffer) => {
        const remaining = 16 * 1024 - Buffer.byteLength(this.stderrPreview);
        if (remaining > 0) this.stderrPreview += chunk.subarray(0, remaining).toString("utf8");
      });
      child.once("error", (error) => this.executorExited(error));
      child.once("exit", (code, signal) => {
        this.executorExited(new Error(`Native executor exited (code=${code}, signal=${signal}). ${this.stderrPreview}`));
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
      health = await this.startInternal();
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
    try {
      await this.request({ type: "shutdown", id: crypto.randomUUID() }, 2_000);
    } catch {
      child.kill();
    }
    await waitForChildExit(child, 1_000);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await waitForChildExit(child, 1_000);
    }
    if (this.child === child) this.child = null;
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
        reject(new SecureRunnerError("SECURE_RUNNER_PROTOCOL_ERROR", `Executor request ${request.id} timed out.`));
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

  private receive(chunk: Buffer): void {
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);
    while (this.receiveBuffer.length >= 4) {
      const length = this.receiveBuffer.readUInt32LE(0);
      if (length === 0 || length > MAX_FRAME_BYTES) {
        this.executorExited(new SecureRunnerError("SECURE_RUNNER_PROTOCOL_ERROR", "Executor sent an invalid frame length."));
        return;
      }
      if (this.receiveBuffer.length < length + 4) return;
      const payload = this.receiveBuffer.subarray(4, 4 + length);
      this.receiveBuffer = this.receiveBuffer.subarray(4 + length);
      let response: ExecutorResponse;
      try {
        response = JSON.parse(payload.toString("utf8")) as ExecutorResponse;
      } catch (error) {
        this.executorExited(new SecureRunnerError("SECURE_RUNNER_PROTOCOL_ERROR", String(error)));
        return;
      }
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      pending.resolve(response);
    }
  }

  private executorExited(error: Error): void {
    this.cachedHealth = unavailableHealth(error.message);
    this.startPromise = null;
    this.child = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
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

function minimalExecutorEnvironment(): NodeJS.ProcessEnv {
  // The executor is trusted and needs the user's AppContainer/profile variables during its
  // startup self-test. It constructs a separate allowlisted environment for every untrusted
  // child, so credentials and proxy variables are never forwarded to submissions.
  return { ...process.env };
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
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
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
