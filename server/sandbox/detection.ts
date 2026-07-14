import { execSync } from "child_process";

export interface SandboxDetection {
  wsl: { installed: boolean; ready: boolean };
  docker: { installed: boolean; ready: boolean };
}

export interface DetectedSandboxEnvironment {
  detection: SandboxDetection;
  wslDistroName: string;
  mountPrefix: string;
}

export function detectSandboxEnvironment(): DetectedSandboxEnvironment {
  let wslInstalled = false;
  let wslCompiler = false;
  let wslIsolate = false;
  let wslDistroName = "Ubuntu";
  let mountPrefix = "/mnt";
  try {
    execSync("wsl -l", { stdio: "ignore", timeout: 3000 });
    wslInstalled = true;
    const ascii = execSync("wsl -l -q", { encoding: "utf8", timeout: 3000 });
    const utf16 = execSync("wsl -l -q", { encoding: "utf16le", timeout: 3000 });
    const distributions = `${ascii}\n${utf16}`;
    if (distributions.includes("Ubuntu")) wslDistroName = "Ubuntu";
    else if (distributions.includes("docker-desktop")) wslDistroName = "docker-desktop";
    try {
      execSync(`wsl -d ${wslDistroName} ls /mnt/host/c`, { stdio: "ignore", timeout: 3000 });
      mountPrefix = "/mnt/host";
    } catch {
      mountPrefix = "/mnt";
    }
  } catch { /* WSL is unavailable. */ }

  if (wslInstalled) {
    try {
      execSync(`wsl -d ${wslDistroName} g++ --version`, { stdio: "ignore", timeout: 3000 });
      wslCompiler = true;
    } catch { /* Compiler is unavailable in this distribution. */ }
    try {
      execSync(`wsl -d ${wslDistroName} which isolate`, { stdio: "ignore", timeout: 3000 });
      wslIsolate = true;
    } catch { /* isolate is unavailable in this distribution. */ }
  }

  let dockerInstalled = false;
  try {
    execSync("docker ps", { stdio: "ignore" });
    dockerInstalled = true;
  } catch { /* Docker is unavailable or its daemon is stopped. */ }

  return {
    detection: {
      wsl: { installed: wslInstalled, ready: wslInstalled && wslCompiler && wslIsolate },
      docker: { installed: dockerInstalled, ready: false }
    },
    wslDistroName,
    mountPrefix
  };
}
