import fs from "fs";
import { execFileSync, spawn, spawnSync } from "child_process";
import { mapWindowsPath } from "./path-mapping.js";

export type SandboxMode = "wsl" | "docker" | "none";

type CommandOptions = { stdio?: any; cwd?: string; paths?: string[]; encoding?: BufferEncoding; timeout?: number };

export interface SandboxBackend {
  readonly mode: SandboxMode;
  toPath(hostPath: string): string;
  runCommand(command: string[], options?: CommandOptions): ReturnType<typeof spawnSync>;
  spawnCommand(command: string[], options?: CommandOptions): ReturnType<typeof spawn>;
  dispose(): void;
}

export class NativeSandboxBackend implements SandboxBackend {
  readonly mode = "none" as const;
  toPath(hostPath: string): string { return hostPath; }
  runCommand(command: string[], options: CommandOptions = {}) { return spawnSync(command[0], command.slice(1), options); }
  spawnCommand(command: string[], options: CommandOptions = {}) { return spawn(command[0], command.slice(1), options); }
  dispose(): void {}
}

export class WslSandboxBackend implements SandboxBackend {
  readonly mode = "wsl" as const;
  constructor(private readonly distribution: string, private readonly mountPrefix: string) {}
  toPath(hostPath: string): string { return mapWindowsPath(hostPath, this.mountPrefix); }
  runCommand(command: string[], options: CommandOptions = {}) { return spawnSync("wsl", ["-d", this.distribution, ...command], options); }
  spawnCommand(command: string[], options: CommandOptions = {}) { return spawn("wsl", ["-d", this.distribution, ...command], options); }
  dispose(): void {}
}

export class DockerSandboxBackend implements SandboxBackend {
  readonly mode = "docker" as const;
  private readonly containerName = "local-judge-sandbox-run";
  constructor(private readonly mountPrefix: string) {}

  start(): boolean {
    this.dispose();
    const mountArgs: string[] = [];
    for (const drive of ["c", "d", "e", "f", "g"]) {
      if (fs.existsSync(`${drive}:\\`)) mountArgs.push("-v", `${drive}:/:${this.mountPrefix}/${drive}`);
    }
    try {
      execFileSync("docker", [
        "run", "-d", "--privileged", "-m", "1.5g", "--memory-swap", "1.5g",
        "--name", this.containerName, ...mountArgs, "local-judge-sandbox", "sleep", "infinity"
      ], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  toPath(hostPath: string): string { return mapWindowsPath(hostPath, this.mountPrefix); }
  runCommand(command: string[], options: CommandOptions = {}) { return spawnSync("docker", ["exec", this.containerName, ...command], options); }
  spawnCommand(command: string[], options: CommandOptions = {}) { return spawn("docker", ["exec", this.containerName, ...command], options); }
  dispose(): void {
    try { execFileSync("docker", ["rm", "-f", this.containerName], { stdio: "ignore" }); } catch { /* Container does not exist. */ }
  }
}
