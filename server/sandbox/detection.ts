import { execSync, type ExecSyncOptions } from "node:child_process";
import os from "node:os";

export const SANDBOX_PROBE_TIMEOUT_MS = 3000;

export type SandboxCommandRunner = (
  command: string,
  options: ExecSyncOptions,
) => string | Buffer;

export interface SandboxDetectionOptions {
  platform?: NodeJS.Platform;
  runCommand?: SandboxCommandRunner;
}

export interface SandboxDetection {
  wsl: { installed: boolean; ready: boolean };
  docker: { installed: boolean; ready: boolean };
}

export interface DetectedSandboxEnvironment {
  detection: SandboxDetection;
  wslDistroName: string;
  mountPrefix: string;
}

export function detectSandboxEnvironment(
  options: SandboxDetectionOptions = {},
): DetectedSandboxEnvironment {
  const platform = options.platform ?? os.platform();
  const runCommand: SandboxCommandRunner =
    options.runCommand ??
    ((command, commandOptions) => execSync(command, commandOptions));
  let wslInstalled = false;
  let wslCompiler = false;
  let wslIsolate = false;
  let wslDistroName = "Ubuntu";
  let mountPrefix = "/mnt";
  if (platform === "win32") {
    try {
      runCommand("wsl -l", {
        stdio: "ignore",
        timeout: SANDBOX_PROBE_TIMEOUT_MS,
      });
      wslInstalled = true;
      const ascii = runCommand("wsl -l -q", {
        encoding: "utf8",
        timeout: SANDBOX_PROBE_TIMEOUT_MS,
      });
      const utf16 = runCommand("wsl -l -q", {
        encoding: "utf16le",
        timeout: SANDBOX_PROBE_TIMEOUT_MS,
      });
      const distributions = `${ascii}\n${utf16}`;
      if (distributions.includes("Ubuntu")) wslDistroName = "Ubuntu";
      else if (distributions.includes("docker-desktop"))
        wslDistroName = "docker-desktop";
      try {
        runCommand(`wsl -d ${wslDistroName} ls /mnt/host/c`, {
          stdio: "ignore",
          timeout: SANDBOX_PROBE_TIMEOUT_MS,
        });
        mountPrefix = "/mnt/host";
      } catch {
        mountPrefix = "/mnt";
      }
    } catch {
      // WSL is unavailable.
    }
  }

  if (wslInstalled) {
    try {
      runCommand(`wsl -d ${wslDistroName} g++ --version`, {
        stdio: "ignore",
        timeout: SANDBOX_PROBE_TIMEOUT_MS,
      });
      wslCompiler = true;
    } catch {
      // Compiler is unavailable in this distribution.
    }
    try {
      runCommand(`wsl -d ${wslDistroName} which isolate`, {
        stdio: "ignore",
        timeout: SANDBOX_PROBE_TIMEOUT_MS,
      });
      wslIsolate = true;
    } catch {
      // isolate is unavailable in this distribution.
    }
  }

  let dockerInstalled = false;
  try {
    runCommand("docker ps", {
      stdio: "ignore",
      timeout: SANDBOX_PROBE_TIMEOUT_MS,
    });
    dockerInstalled = true;
  } catch {
    // Docker is unavailable, stopped, or did not respond in time.
  }

  return {
    detection: {
      wsl: {
        installed: wslInstalled,
        ready: wslInstalled && wslCompiler && wslIsolate,
      },
      docker: { installed: dockerInstalled, ready: false },
    },
    wslDistroName,
    mountPrefix,
  };
}
