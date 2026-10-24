import express, { type Express } from "express";
import type { Server } from "node:http";
import net, { type AddressInfo } from "node:net";
import { spawn, execSync, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { registerJobRoutes } from "../../jobs.js";
import {
  registerSystemRoutes,
  type ServerShutdownDependencies,
} from "../../routes/system-routes.js";
import { registerProblemRoutes } from "../../routes/problem-routes.js";
import { registerExportRoutes } from "../../routes/export-routes.js";
import { registerToolchainRoutes } from "../../routes/toolchain-routes.js";
import { registerBatchJudgeRoute } from "../../judge/batch-judge-route.js";
import { registerOsdRoutes } from "../../routes/osd-routes.js";
import { drainToolchainDiscovery } from "../../toolchains/discovery.js";
import { executorClient } from "../../executor/client.js";

import type { IsolatedTestEnvironment } from "./test-environment.js";
import { TOOLCHAIN_CATALOG } from "../../toolchains/manifest.js";
import type { ToolchainDescriptor } from "../../toolchains/types.js";
import { diagnoseLanguageProfile, type ToolchainDiagnosticResult } from "../../toolchains/diagnostics.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "../../..");

export interface BackendAdapter {
  readonly name: "node" | "rust";
  readonly baseUrl: string;
  start(): Promise<void>;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

export class NodeBackendAdapter implements BackendAdapter {
  readonly name = "node" as const;
  private server: Server | null = null;
  private url = "";
  public shutdownDeps: ServerShutdownDependencies;
  public testEnv?: IsolatedTestEnvironment;
  public targetPort?: number;
  private activeBackgroundOperations = new Set<Promise<unknown>>();
  private settledBackgroundErrors: unknown[] = [];
  private isClosing = false;

  constructor(
    testEnvOrShutdownDeps?: IsolatedTestEnvironment | Partial<ServerShutdownDependencies>,
    customShutdownDeps?: Partial<ServerShutdownDependencies>,
    targetPort?: number,
  ) {
    this.targetPort = targetPort;
    if (testEnvOrShutdownDeps && "mockSelectFile" in testEnvOrShutdownDeps) {
      this.testEnv = testEnvOrShutdownDeps;
      this.shutdownDeps = {
        beginDrain: () => {},
        cancelActiveJudgeJobs: () => 0,
        waitForJudgeSessionsToFinish: async () => true,
        activeJudgeSessionCount: () => 0,
        shutdownExecutor: async () => {},
        scheduleProcessExit: () => {},
        drainTimeoutMs: 100,
        ...customShutdownDeps,
      };
    } else {
      this.shutdownDeps = {
        beginDrain: () => {},
        cancelActiveJudgeJobs: () => 0,
        waitForJudgeSessionsToFinish: async () => true,
        activeJudgeSessionCount: () => 0,
        shutdownExecutor: async () => {},
        scheduleProcessExit: () => {},
        drainTimeoutMs: 100,
        ...(testEnvOrShutdownDeps as Partial<ServerShutdownDependencies>),
      };
    }
  }

  get baseUrl(): string {
    if (!this.url) {
      throw new Error("NodeBackendAdapter has not been started yet.");
    }
    return this.url;
  }

  trackBackgroundOperation(op: Promise<unknown>): void {
    if (this.isClosing) {
      throw new Error("Cannot admit background operation: adapter is closing or closed");
    }
    this.activeBackgroundOperations.add(op);
    op.then(
      () => {
        this.activeBackgroundOperations.delete(op);
      },
      (err) => {
        this.settledBackgroundErrors.push(err);
        this.activeBackgroundOperations.delete(op);
      },
    );
  }

  async start(): Promise<void> {
    const app: Express = express();
    app.use(express.json({ limit: "50mb" }));
    app.use(express.urlencoded({ extended: true, limit: "50mb" }));

    const testDirectoryPicker = (_defaultPath?: string): string | null => {
      const mockFile = this.testEnv?.mockSelectFile ?? process.env.JUDGEDESK_TEST_SELECT_FILE;
      if (mockFile && fs.existsSync(mockFile)) {
        const val = fs.readFileSync(mockFile, "utf8").trim();
        if (val === "__CANCEL__") return null;
        if (val === "__ERROR__") throw new Error("Directory selection failed.");
        return val;
      }
      return null;
    };

    const testWorkbookOpener = async (_exportPath: string) => {
      return process.platform === "win32" ? "excel-unsaved" : "system-open";
    };

    const testInstaller = async (
      _descriptor: ToolchainDescriptor,
      options?: { beforeCommit?: () => void },
    ) => {
      options?.beforeCommit?.();
    };

    const testManifestLoader = async (): Promise<readonly ToolchainDescriptor[]> => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return TOOLCHAIN_CATALOG.map((entry) => ({
        ...entry,
        manifestSchemaVersion: 2 as const,
        downloadUrl: `https://downloads.judgedesk.internal/${entry.id}.${entry.archiveFormat}`,
        sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        sizeBytes: 1024,
        installedSizeBytes: 4096,
      }));
    };

    registerJobRoutes(app);
    registerSystemRoutes(app, this.shutdownDeps, testDirectoryPicker);
    registerProblemRoutes(app);
    registerExportRoutes(app, testWorkbookOpener);
    registerToolchainRoutes(
      app,
      testInstaller,
      (op) => this.trackBackgroundOperation(op),
      undefined,
      testManifestLoader,
      async (profileId): Promise<ToolchainDiagnosticResult> => {
        // Contract payloads use dummy compiler files, not executable toolchains.
        // Keep the native boundary deterministic, like the Rust contract adapter.
        if (profileId !== "cpp-legacy-v1") return diagnoseLanguageProfile(profileId);
        return {
          success: false, profileId, language: "cpp", sourceMode: "managed",
          version: process.platform === "darwin" ? "" : "14.2.0",
          phase: process.platform === "darwin" ? "configuration" : "compilation",
          error: process.platform === "darwin" ? "Managed toolchain not installed." : "TOOLCHAIN_NOT_SANDBOX_COMPATIBLE",
        };
      },
    );
    registerBatchJudgeRoute(app);
    registerOsdRoutes(app);

    await new Promise<void>((resolve, reject) => {
      const srv = app.listen(this.targetPort ?? 0, "127.0.0.1", () => {
        this.server = srv;
        const addr = srv.address() as AddressInfo;
        this.url = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
      srv.once("error", (err) => {
        this.server = null;
        reject(err);
      });
      this.server = srv;
    });
  }

  async fetch(path: string, init?: RequestInit): Promise<Response> {
    const targetUrl = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    return fetch(targetUrl, init);
  }

  async close(): Promise<void> {
    this.isClosing = true;
    const errors: unknown[] = [...this.settledBackgroundErrors];
    this.settledBackgroundErrors = [];
    if (this.activeBackgroundOperations.size > 0) {
      const ops = Array.from(this.activeBackgroundOperations);
      const results = await Promise.allSettled(ops);
      this.activeBackgroundOperations.clear();
      for (const res of results) {
        if (res.status === "rejected" && !errors.includes(res.reason)) {
          errors.push(res.reason);
        }
      }
    }
    try {
      await drainToolchainDiscovery();
    } catch (err) {
      errors.push(err);
    }
    try {
      await executorClient.shutdown();
    } catch (err) {
      errors.push(err);
    }
    if (this.server) {
      try {
        await new Promise<void>((resolve, reject) => {
          this.server?.close((err) => (err ? reject(err) : resolve()));
        });
      } catch (err) {
        errors.push(err);
      }
      this.server = null;
      this.url = "";
    }
    if (errors.length > 0) {
      const messages = errors.map((e) => (e instanceof Error ? e.message : String(e)));
      const errorObjects = errors.map((e) => (e instanceof Error ? e : new Error(String(e))));
      throw new AggregateError(
        errorObjects,
        `NodeBackendAdapter.close() failed with ${errors.length} background/server error(s):\n  ${messages.join("\n  ")}`,
      );
    }
  }
}

export class RustBackendAdapter implements BackendAdapter {
  readonly name = "rust" as const;
  private process: ChildProcess | null = null;
  private url = "";
  public testEnv?: IsolatedTestEnvironment;
  public customBinPath?: string;
  public startupTimeoutMs?: number;

  constructor(testEnvOrPort?: IsolatedTestEnvironment | number) {
    if (typeof testEnvOrPort === "number") {
      this.url = `http://127.0.0.1:${testEnvOrPort}`;
    } else if (testEnvOrPort && "mockSelectFile" in testEnvOrPort) {
      this.testEnv = testEnvOrPort;
    }
  }

  get baseUrl(): string {
    if (!this.url) {
      throw new Error("RustBackendAdapter has not been started yet.");
    }
    return this.url;
  }

  async start(): Promise<void> {
    if (this.url) {
      // Port was pre-configured
      return;
    }

    const ext = process.platform === "win32" ? ".exe" : "";
    const binPath =
      this.customBinPath
      || path.join(
        repoRoot,
        "crates",
        "judgedesk-core",
        "target",
        "debug",
        `test-server${ext}`,
      );

    if (!this.customBinPath) {
      // Always build test-server binary with required feature from locked source before starting
      execSync(
        "cargo build --locked --manifest-path crates/judgedesk-core/Cargo.toml --bin test-server --features test-server",
        { cwd: repoRoot, stdio: "inherit" },
      );
    }

    return new Promise<void>((resolve, reject) => {
      let resolved = false;
      let readinessTimer: NodeJS.Timeout | null = null;

      const finishReject = (err: unknown) => {
        if (!resolved) {
          resolved = true;
          if (readinessTimer) clearTimeout(readinessTimer);
          reject(err);
        }
      };

      const finishResolve = () => {
        if (!resolved) {
          resolved = true;
          if (readinessTimer) clearTimeout(readinessTimer);
          resolve();
        }
      };

      const isBatch = process.platform === "win32" && /\.(bat|cmd)$/i.test(binPath);
      const proc = spawn(binPath, [], {
        cwd: repoRoot,
        shell: isBatch,
        env: {
          ...process.env,
          PORT: "0",
          ...(this.testEnv
            ? {
                THEMIS_APP_DATA_DIR: this.testEnv.appDataDir,
                TEMP: this.testEnv.tempDir,
                TMP: this.testEnv.tempDir,
                JUDGEDESK_TEST_SELECT_DIRECTORY: this.testEnv.mockSelectFile,
              }
            : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      this.process = proc;

      let timedOut = false;
      const timeoutMs = this.startupTimeoutMs ?? 15000;
      readinessTimer = setTimeout(() => {
        if (!resolved) {
          timedOut = true;
          void (async () => {
            const timeoutError = new Error(
              `Rust test-server process timed out waiting for readiness signal (${timeoutMs}ms)`,
            );
            try {
              this.process = null;
              await this.terminateChildProcess(proc);
              finishReject(timeoutError);
            } catch (termErr) {
              finishReject(
                new AggregateError(
                  [timeoutError, termErr],
                  `Rust test-server startup timed out and termination failed: ${termErr instanceof Error ? termErr.message : String(termErr)}`,
                ),
              );
            }
          })();
        }
      }, timeoutMs);

      proc.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        const match = text.match(/JUDGEDESK_CORE_PORT=(\d+)/);
        if (match && !resolved) {
          const port = parseInt(match[1], 10);
          this.url = `http://127.0.0.1:${port}`;
          finishResolve();
        }
      });

      proc.on("error", (err) => {
        finishReject(err);
      });

      proc.on("exit", (code) => {
        if (timedOut) {
          return;
        }
        finishReject(new Error(`Rust server process exited prematurely with code ${code}`));
      });
    });
  }

  async fetch(path: string, init?: RequestInit): Promise<Response> {
    const targetUrl = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    return fetch(targetUrl, init);
  }

  async close(): Promise<void> {
    if (this.process) {
      const proc = this.process;
      const port = this.url ? parseInt(new URL(this.url).port, 10) : undefined;
      this.process = null;
      this.url = "";
      await this.terminateChildProcess(proc, port);
    }
  }

  public async terminateChildProcess(
    proc: ChildProcess,
    boundPort?: number,
    deadlineMs = 5000,
  ): Promise<void> {
    const errors: unknown[] = [];
    if (proc.exitCode !== null || proc.signalCode !== null) {
      if (boundPort !== undefined) {
        await this.verifyPortReleased(boundPort);
      }
      return;
    }

    try {
      await new Promise<void>((resolve, reject) => {
        let resolved = false;
        let deadlineTimer: NodeJS.Timeout | null = null;

        const finishReject = (err: unknown) => {
          if (!resolved) {
            resolved = true;
            if (deadlineTimer) clearTimeout(deadlineTimer);
            reject(err);
          }
        };

        const finishResolve = () => {
          if (!resolved) {
            resolved = true;
            if (deadlineTimer) clearTimeout(deadlineTimer);
            resolve();
          }
        };

        proc.once("exit", () => {
          finishResolve();
        });

        // Terminate process tree immediately: on Windows taskkill /F /T kills the entire tree
        try {
          if (process.platform === "win32" && proc.pid) {
            const tk = spawnSync("taskkill", ["/F", "/T", "/PID", proc.pid.toString()], {
              windowsHide: true,
            });
            if (tk.error) {
              errors.push(tk.error);
            } else if (tk.status !== null && tk.status !== 0 && tk.status !== 128) {
              const stderr = tk.stderr ? tk.stderr.toString("utf8").trim() : "";
              errors.push(new Error(`taskkill failed with exit status ${tk.status}: ${stderr}`));
            }
          } else {
            proc.kill("SIGTERM");
            const killTimer = setTimeout(() => {
              if (proc.exitCode === null && proc.signalCode === null) {
                try {
                  proc.kill("SIGKILL");
                } catch {
                  // Ignore ESRCH
                }
              }
            }, Math.min(1500, Math.max(100, Math.floor(deadlineMs / 2))));
            proc.once("exit", () => clearTimeout(killTimer));
          }
        } catch (err: unknown) {
          const isEsrch =
            typeof err === "object"
            && err !== null
            && "code" in err
            && (err as { code: unknown }).code === "ESRCH";
          if (!isEsrch) {
            errors.push(err);
          }
        }

        deadlineTimer = setTimeout(() => {
          if (proc.exitCode === null && proc.signalCode === null) {
            finishReject(new Error(`Child process PID ${proc.pid} failed to exit within ${deadlineMs}ms deadline`));
          } else {
            finishResolve();
          }
        }, deadlineMs);
      });
    } catch (err) {
      errors.push(err);
    }

    if (boundPort !== undefined) {
      try {
        await this.verifyPortReleased(boundPort);
      } catch (portErr) {
        errors.push(portErr);
      }
    }

    if (errors.length > 0) {
      const errorObjects = errors.map((e) => (e instanceof Error ? e : new Error(String(e))));
      const messages = errors.map((e) => (e instanceof Error ? e.message : String(e)));
      throw new AggregateError(errorObjects, `Failed to terminate child process cleanly:\n  ${messages.join("\n  ")}`);
    }
  }

  private async verifyPortReleased(port: number, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const free = await new Promise<boolean>((resolve) => {
        const tester = net.createServer();
        tester.once("error", () => resolve(false));
        tester.listen(port, "127.0.0.1", () => {
          tester.close(() => resolve(true));
        });
      });
      if (free) {
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Port ${port} was not released within ${timeoutMs}ms after child exit`);
  }
}
