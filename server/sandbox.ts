import { DockerSandboxBackend, NativeSandboxBackend, SandboxBackend, SandboxMode, WslSandboxBackend } from "./sandbox/backends.js";
import { detectSandboxEnvironment, SandboxDetection } from "./sandbox/detection.js";

export type { SandboxDetection, SandboxMode };

class SandboxManager {
  detection: SandboxDetection = {
    wsl: { installed: false, ready: false },
    docker: { installed: false, ready: false }
  };
  private backend: SandboxBackend = new NativeSandboxBackend();
  private isolateBoxCounter = 0;
  private cleanupHandlersRegistered = false;

  get mode(): SandboxMode {
    return this.backend.mode;
  }

  initialize(): void {
    const environment = detectSandboxEnvironment();
    this.detection = environment.detection;
    if (environment.detection.wsl.ready) {
      this.backend = new WslSandboxBackend(environment.wslDistroName, environment.mountPrefix);
    } else if (environment.detection.docker.installed) {
      const docker = new DockerSandboxBackend(environment.mountPrefix);
      if (docker.start()) {
        this.backend = docker;
        this.detection.docker.ready = true;
        console.log("[Sandbox Init] Started persistent Docker container: local-judge-sandbox-run");
      } else {
        this.backend = new NativeSandboxBackend();
        console.error("[Sandbox Init] Failed to start Docker container");
      }
    } else {
      this.backend = new NativeSandboxBackend();
    }
    this.registerCleanupHandlers();
    console.log(`[Sandbox Init] Sandbox Mode: ${this.mode}`);
    if (this.mode === "wsl") console.log(`  WSL Distro: ${environment.wslDistroName}, Mount Prefix: ${environment.mountPrefix}`);
  }

  nextIsolateBox(): number {
    const boxId = this.isolateBoxCounter % 100;
    this.isolateBoxCounter += 1;
    return boxId;
  }

  toPath(hostPath: string): string {
    return this.backend.toPath(hostPath);
  }

  runCommand(command: string[], options: { stdio?: any; cwd?: string; paths?: string[]; encoding?: BufferEncoding; timeout?: number } = {}) {
    return this.backend.runCommand(command, options);
  }

  spawnCommand(command: string[], options: { stdio?: any; cwd?: string; timeout?: number; paths?: string[] } = {}) {
    return this.backend.spawnCommand(command, options);
  }

  private registerCleanupHandlers(): void {
    if (this.cleanupHandlersRegistered) return;
    this.cleanupHandlersRegistered = true;
    process.on("exit", () => this.backend.dispose());
    process.on("SIGINT", () => process.exit());
    process.on("SIGTERM", () => process.exit());
  }
}

export const sandbox = new SandboxManager();
