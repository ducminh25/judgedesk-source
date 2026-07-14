import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { ToolchainKind, ResolvedToolchain, ToolchainSource } from "./types.js";
import { getToolchainsDir, loadPreferences } from "./storage.js";
import { getDescriptorForHost } from "./manifest.js";
import { sandbox } from "../sandbox.js";

// Extracts clean version from --version output
export function getExecutableVersion(
  executablePath: string,
  kind: ToolchainKind,
): string {
  try {
    if (!fs.existsSync(executablePath)) return "unknown";
    const stdout = execFileSync(executablePath, ["--version"], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });

    if (kind === "python") {
      // "Python 3.12.8\n"
      const match = stdout.match(/Python\s+([0-9.]+)/i);
      return match ? match[1] : "unknown";
    } else {
      // C++ (GCC/Clang): "g++ (GCC) 14.2.0\n"
      const match = stdout.match(/(gcc|g\+\+|clang|version)\s+([0-9.]+)/i);
      if (match) return match[2];

      const genericMatch = stdout.match(/([0-9]+\.[0-9]+\.[0-9]+)/);
      return genericMatch ? genericMatch[1] : "unknown";
    }
  } catch (error) {
    return "unknown";
  }
}

// Searches environment PATH for binary
export function searchInPath(binaryName: string): string | null {
  const envPath = process.env.PATH || "";
  const delimiter = os.platform() === "win32" ? ";" : ":";
  const extensions =
    os.platform() === "win32" ? [".exe", ".bat", ".cmd"] : [""];

  const dirs = envPath.split(delimiter);
  for (const dir of dirs) {
    for (const ext of extensions) {
      const fullPath = path.join(dir, binaryName + ext);
      try {
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
          // Verify it's executable
          if (os.platform() !== "win32") {
            const stats = fs.statSync(fullPath);
            const isExecutable = !!(stats.mode & 0o111);
            if (!isExecutable) continue;
          }
          return fullPath;
        }
      } catch {
        continue;
      }
    }
  }
  return null;
}

// Scans standard system installation directories
export function findSystemCpp(): string | null {
  const platform = os.platform();
  if (platform === "win32") {
    const commonPaths = [
      "C:\\msys64\\ucrt64\\bin\\g++.exe",
      "C:\\msys64\\mingw64\\bin\\g++.exe",
      "C:\\MinGW\\bin\\g++.exe",
      "C:\\Program Files\\mingw-w64\\x86_64-8.1.0-posix-seh-rt_v6-rev0\\mingw64\\bin\\g++.exe",
    ];
    for (const p of commonPaths) {
      if (fs.existsSync(p)) return p;
    }
  } else if (platform === "darwin") {
    const commonPaths = [
      "/usr/bin/clang++",
      "/usr/bin/g++",
      "/opt/homebrew/bin/g++",
      "/opt/homebrew/bin/g++-14",
      "/opt/homebrew/bin/g++-13",
    ];
    for (const p of commonPaths) {
      if (fs.existsSync(p)) return p;
    }
  } else {
    // Linux
    const commonPaths = ["/usr/bin/g++", "/usr/bin/clang++"];
    for (const p of commonPaths) {
      if (fs.existsSync(p)) return p;
    }
  }

  // Fallback to path search
  return searchInPath("g++") || searchInPath("clang++");
}

export function findSystemPython(): string | null {
  const platform = os.platform();
  if (platform === "win32") {
    // Check standard Windows Python installations
    const localAppData =
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const pythonDirs = [
      path.join(localAppData, "Programs", "Python"),
      "C:\\Python312",
      "C:\\Python311",
      "C:\\Python310",
      "C:\\Python3",
    ];
    for (const baseDir of pythonDirs) {
      if (fs.existsSync(baseDir)) {
        try {
          const subdirs = fs.readdirSync(baseDir);
          for (const subdir of subdirs) {
            const fullPath = path.join(baseDir, subdir, "python.exe");
            if (fs.existsSync(fullPath)) return fullPath;
          }
        } catch {}
      }
    }
  } else if (platform === "darwin" || platform === "linux") {
    const commonPaths = [
      "/opt/homebrew/bin/python3",
      "/usr/bin/python3",
      "/usr/local/bin/python3",
    ];
    for (const p of commonPaths) {
      if (fs.existsSync(p)) return p;
    }
  }

  return searchInPath("python3") || searchInPath("python");
}

export function resolveToolchain(kind: ToolchainKind): ResolvedToolchain {
  const platform = os.platform();
  const arch = os.arch();

  // 1. Sandbox active
  if (sandbox.mode !== "none") {
    return {
      kind,
      source: "sandbox",
      executablePath: kind === "cpp" ? "g++" : "python3",
      version: "Inside sandbox",
      ready: true,
    };
  }

  const prefs = loadPreferences();
  const preferredSource =
    kind === "cpp" ? prefs.preferredSourceCpp : prefs.preferredSourcePython;
  const customPath =
    kind === "cpp" ? prefs.customCppPath : prefs.customPythonPath;

  // Let's resolve managed toolchain path
  const descriptor = getDescriptorForHost(platform, arch, kind);
  let managedPath: string | null = null;
  if (descriptor) {
    const managedExec = path.join(
      getToolchainsDir(),
      descriptor.id,
      descriptor.executableRelativePath,
    );
    if (fs.existsSync(managedExec)) {
      managedPath = managedExec;
    }
  }

  // Helper to construct a System resolution result
  const resolveSystem = (): ResolvedToolchain => {
    const systemPath = kind === "cpp" ? findSystemCpp() : findSystemPython();
    if (systemPath) {
      const version = getExecutableVersion(systemPath, kind);
      return {
        kind,
        source: "system",
        executablePath: systemPath,
        version,
        ready: version !== "unknown",
      };
    }
    return {
      kind,
      source: "system",
      executablePath: "",
      version: "",
      ready: false,
      diagnostic: "System compiler not found.",
    };
  };

  // Helper to construct a Custom resolution result
  const resolveCustom = (): ResolvedToolchain => {
    if (customPath && fs.existsSync(customPath)) {
      const version = getExecutableVersion(customPath, kind);
      return {
        kind,
        source: "custom",
        executablePath: customPath,
        version,
        ready: version !== "unknown",
      };
    }
    return {
      kind,
      source: "custom",
      executablePath: customPath || "",
      version: "",
      ready: false,
      diagnostic: "Custom compiler path does not exist or is invalid.",
    };
  };

  // Helper to construct a Managed resolution result
  const resolveManaged = (): ResolvedToolchain => {
    if (managedPath) {
      const version = getExecutableVersion(managedPath, kind);
      return {
        kind,
        source: "managed",
        executablePath: managedPath,
        version,
        ready: version !== "unknown",
      };
    }
    return {
      kind,
      source: "managed",
      executablePath: "",
      version: "",
      ready: false,
      diagnostic: "Managed toolchain not installed.",
    };
  };

  // Resolve according to user preference
  if (preferredSource === "custom") {
    const res = resolveCustom();
    if (res.ready) return res;
  } else if (preferredSource === "managed") {
    const res = resolveManaged();
    if (res.ready) return res;
  } else {
    const res = resolveSystem();
    if (res.ready) return res;
  }

  // Fallbacks: If preferred source fails, search remaining in order: Managed -> Custom -> System
  if (managedPath) {
    const res = resolveManaged();
    if (res.ready) return res;
  }
  if (customPath && fs.existsSync(customPath)) {
    const res = resolveCustom();
    if (res.ready) return res;
  }
  return resolveSystem();
}
