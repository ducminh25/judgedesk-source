import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { ToolchainKind, ResolvedToolchain, ToolchainSource } from "./types.js";
import {
  getToolchainsDir,
  loadToolchainPreferenceSnapshot,
} from "./storage.js";
import { getDescriptorForHost } from "./manifest.js";
import { sandbox } from "../sandbox.js";
import { getRegisteredProfileForKind } from "../languages/registry.js";
import { getStoredProfilePreference } from "./preferences-v2.js";
import {
  getDiscoveredCandidates,
  getToolchainDiscoverySnapshot,
} from "./discovery.js";

export const MIN_GNU_CPP_VERSION = "9.2.0";
export const MIN_GNU_GDB_VERSION = "7.6.1";
const DETECTION_CACHE_TTL_MS = 5 * 60 * 1000;

const detectionCache = new Map<
  ToolchainKind,
  { value: string | null; expiresAt: number }
>();
const executableSupportCache = new Map<
  string,
  { value: boolean; expiresAt: number }
>();

export function buildToolchainEnvironment(
  executablePath: string,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = os.platform(),
): NodeJS.ProcessEnv {
  const environment = { ...baseEnvironment };
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(executablePath)) return environment;

  const pathKey =
    Object.keys(environment).find((key) => key.toLowerCase() === "path") ||
    (platform === "win32" ? "Path" : "PATH");
  const delimiter = platform === "win32" ? ";" : ":";
  const executableDirectory = pathApi.dirname(executablePath);
  const currentPath = environment[pathKey] || "";
  const normalize = (value: string) =>
    platform === "win32"
      ? pathApi.resolve(value).toLowerCase()
      : pathApi.resolve(value);
  const alreadyIncluded = currentPath
    .split(delimiter)
    .filter(Boolean)
    .some((directory) => normalize(directory) === normalize(executableDirectory));

  if (!alreadyIncluded) {
    environment[pathKey] = currentPath
      ? `${executableDirectory}${delimiter}${currentPath}`
      : executableDirectory;
  }
  return environment;
}

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
      env: buildToolchainEnvironment(executablePath),
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

export function isDarwinSandboxCompatibleCpp(
  executablePath: string,
): boolean {
  try {
    const compiler = fs.realpathSync(executablePath).replaceAll("\\", "/");
    if (!isDarwinAppleToolchainLocation(compiler)) return false;

    const identity = execFileSync(executablePath, ["--version"], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
      env: buildToolchainEnvironment(executablePath, process.env, "darwin"),
    });
    return /\bApple clang version\b/i.test(identity);
  } catch {
    return false;
  }
}

export function isDarwinAppleToolchainLocation(
  executablePath: string,
): boolean {
  const compiler = executablePath.replaceAll("\\", "/");
  return compiler.startsWith("/Library/Developer/CommandLineTools/") ||
    /\/Contents\/Developer\/Toolchains\/[^/]+\.xctoolchain\//.test(compiler);
}

export function buildSelectedDarwinCppCandidates(
  developerRoot: string | null,
): string[] {
  if (!developerRoot) return [];
  return [
    path.posix.join(
      developerRoot,
      "Toolchains",
      "XcodeDefault.xctoolchain",
      "usr",
      "bin",
      "clang++",
    ),
    path.posix.join(developerRoot, "usr", "bin", "clang++"),
  ];
}

export function inferDarwinDeveloperRoot(
  executablePath: string,
): string | null {
  const compiler = executablePath.replaceAll("\\", "/");
  const commandLineTools = "/Library/Developer/CommandLineTools";
  if (
    compiler === commandLineTools ||
    compiler.startsWith(`${commandLineTools}/`)
  ) {
    return commandLineTools;
  }

  const marker = "/Contents/Developer/";
  const markerIndex = compiler.indexOf(marker);
  if (markerIndex < 0) return null;
  return compiler.slice(0, markerIndex + marker.length - 1);
}

export function buildDarwinSdkCandidates(developerRoot: string): string[] {
  return [
    path.posix.join(
      developerRoot,
      "Platforms",
      "MacOSX.platform",
      "Developer",
      "SDKs",
      "MacOSX.sdk",
    ),
    path.posix.join(developerRoot, "SDKs", "MacOSX.sdk"),
  ];
}

export function findDarwinSdkDirectory(
  executablePath: string,
): string | null {
  try {
    const compiler = fs.realpathSync(executablePath).replaceAll("\\", "/");
    const developerRoot = inferDarwinDeveloperRoot(compiler);
    if (!developerRoot) return null;
    const sdk = buildDarwinSdkCandidates(developerRoot).find((candidate) =>
      fs.existsSync(candidate),
    );
    return sdk ? fs.realpathSync(sdk) : null;
  } catch {
    return null;
  }
}

export function compareVersions(left: string, right: string): number {
  const a = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const b = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function clearToolchainDetectionCache(): void {
  detectionCache.clear();
  executableSupportCache.clear();
}

export function resolveManagedToolchain(kind: ToolchainKind): ResolvedToolchain {
  const descriptor = getDescriptorForHost(os.platform(), os.arch(), kind);
  if (descriptor) {
    const executablePath = path.join(
      getToolchainsDir(),
      descriptor.id,
      descriptor.executableRelativePath,
    );
    if (fs.existsSync(executablePath)) {
      const version = getExecutableVersion(executablePath, kind);
      const ready = isSupportedExecutable(executablePath, kind);
      return {
        kind,
        source: "managed",
        executablePath,
        version,
        ready,
        ...(!ready
          ? {
              diagnostic: "Managed toolchain health check failed.",
              diagnosticCode: "HEALTH_CHECK_FAILED" as const,
            }
          : {}),
      };
    }
  }
  return {
    kind,
    source: "managed",
    executablePath: "",
    version: "",
    ready: false,
    diagnostic: "Managed toolchain not installed.",
    diagnosticCode: descriptor
      ? "MANAGED_PACKAGE_NOT_INSTALLED"
      : "MANAGED_PACKAGE_UNSUPPORTED",
  };
}

export function chooseNativeProtectedToolchain(
  platform: NodeJS.Platform,
  kind: ToolchainKind,
  managed: ResolvedToolchain,
  selected: ResolvedToolchain,
): ResolvedToolchain {
  // D15 selections are fixed intent. Native protection may reject an active
  // source, but it must never silently replace it with another installed source.
  if (selected.source === "managed") return managed;
  if (kind === "cpp" && platform === "win32" && selected.ready) {
    return {
      ...selected,
      ready: false,
      diagnostic:
        "The selected local C++ compiler has not been certified for the Windows secure runner.",
      diagnosticCode: "CERTIFICATION_REQUIRED",
    };
  }
  return selected;
}

export function resolveNativeProtectedToolchain(kind: ToolchainKind): ResolvedToolchain {
  const managed = resolveManagedToolchain(kind);
  return chooseNativeProtectedToolchain(os.platform(), kind, managed, resolveToolchain(kind));
}

export function isPythonSubmissionReady(toolchain: ResolvedToolchain): boolean {
  return toolchain.kind === "python"
    && toolchain.ready
    && toolchain.source === "managed";
}

export function isPythonCheckerReady(toolchain: ResolvedToolchain): boolean {
  // Local/system runtimes may become eligible after the D15 certification-and-snapshot
  // workflow exists. Until then, reporting them ready would contradict resolveChecker's
  // fail-closed admission rule.
  return toolchain.kind === "python"
    && toolchain.ready
    && toolchain.source === "managed";
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
  return findCachedSystemToolchain("cpp", collectSystemCppCandidates);
}

export function findSystemPython(): string | null {
  return findCachedSystemToolchain("python", collectSystemPythonCandidates);
}

function findCachedSystemToolchain(
  kind: ToolchainKind,
  collectCandidates: () => string[],
): string | null {
  const cached = detectionCache.get(kind);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const value = uniqueExistingFiles(collectCandidates()).find((candidate) =>
    isSupportedExecutable(candidate, kind),
  ) || null;
  detectionCache.set(kind, {
    value,
    expiresAt: Date.now() + DETECTION_CACHE_TTL_MS,
  });
  return value;
}

function collectSystemCppCandidates(): string[] {
  const platform = os.platform();
  const pathCandidates = [searchInPath("g++"), searchInPath("clang++")];
  const candidates = platform === "darwin" ? [] : [...pathCandidates];
  if (platform === "win32") {
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    const programFilesX86 =
      process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const localAppData =
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const userProfile = process.env.USERPROFILE || os.homedir();
    candidates.push(
      path.join(programFiles, "Themis", "GCC", "bin", "g++.exe"),
      path.join(programFilesX86, "Themis", "GCC", "bin", "g++.exe"),
      "C:\\Themis\\GCC\\bin\\g++.exe",
      "C:\\msys64\\ucrt64\\bin\\g++.exe",
      "C:\\msys64\\mingw64\\bin\\g++.exe",
      "C:\\msys64\\clang64\\bin\\clang++.exe",
      path.join(localAppData, "Programs", "msys64", "ucrt64", "bin", "g++.exe"),
      path.join(localAppData, "Programs", "msys64", "mingw64", "bin", "g++.exe"),
      path.join(programFiles, "CodeBlocks", "MinGW", "bin", "g++.exe"),
      path.join(programFilesX86, "CodeBlocks", "MinGW", "bin", "g++.exe"),
      path.join(localAppData, "Programs", "CodeBlocks", "MinGW", "bin", "g++.exe"),
      "C:\\MinGW\\bin\\g++.exe",
      path.join(userProfile, "scoop", "apps", "gcc", "current", "bin", "g++.exe"),
      path.join(userProfile, "scoop", "apps", "msys2", "current", "ucrt64", "bin", "g++.exe"),
      path.join(
        process.env.ChocolateyInstall || "C:\\ProgramData\\chocolatey",
        "bin",
        "g++.exe",
      ),
    );
    candidates.push(...findNamedFiles(path.join(programFiles, "mingw-w64"), "g++.exe", 5));
    candidates.push(...findNamedFiles(path.join(programFilesX86, "mingw-w64"), "g++.exe", 5));
  } else if (platform === "darwin") {
    const selectedDeveloperRoot = findWithCommand(
      "/usr/bin/xcode-select",
      ["-p"],
    );
    candidates.push(
      // On a normal Mac, xcrun may return /usr/bin/clang++, a system shim
      // outside the sealed Developer root allowed by the compiler sandbox.
      // Resolve the selected Xcode/CLT installation first so judging launches
      // the real driver and its resource files inside the approved root.
      ...buildSelectedDarwinCppCandidates(selectedDeveloperRoot),
      findWithCommand("/usr/bin/xcrun", ["--find", "clang++"]),
      "/usr/bin/clang++",
      "/usr/bin/g++",
      "/Library/Developer/CommandLineTools/usr/bin/clang++",
      "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang++",
      "/opt/homebrew/bin/clang++",
      "/opt/homebrew/bin/g++",
      "/usr/local/bin/clang++",
      "/usr/local/bin/g++",
      "/opt/local/bin/clang++",
      "/opt/local/bin/g++",
      findInLoginShell("g++"),
      findInLoginShell("clang++"),
      ...pathCandidates,
    );
    candidates.push(...findVersionedCommands("/opt/homebrew/bin", ["g++-", "clang++-"]));
    candidates.push(...findVersionedCommands("/usr/local/bin", ["g++-", "clang++-"]));
  } else {
    candidates.push("/usr/bin/g++", "/usr/bin/clang++", "/usr/local/bin/g++");
  }
  return candidates.filter((candidate): candidate is string => !!candidate);
}

function collectSystemPythonCandidates(): string[] {
  const platform = os.platform();
  const candidates = [searchInPath("python3"), searchInPath("python")];
  if (platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const userProfile = process.env.USERPROFILE || os.homedir();
    candidates.push(...findPythonLauncherInstallations());
    candidates.push(
      "C:\\Python313\\python.exe",
      "C:\\Python312\\python.exe",
      "C:\\Python311\\python.exe",
      "C:\\Python310\\python.exe",
      path.join(userProfile, "scoop", "apps", "python", "current", "python.exe"),
    );
    candidates.push(
      ...findNamedFiles(path.join(localAppData, "Programs", "Python"), "python.exe", 3),
      ...findPythonRegistryInstallations(),
    );
  } else if (platform === "darwin") {
    candidates.push(
      "/opt/homebrew/bin/python3",
      "/usr/local/bin/python3",
      "/usr/bin/python3",
      "/opt/local/bin/python3",
      findInLoginShell("python3"),
    );
    candidates.push(
      ...findNamedFiles("/Library/Frameworks/Python.framework/Versions", "python3", 3),
      ...findNamedFiles(path.join(os.homedir(), ".pyenv", "versions"), "python3", 3),
      ...findNamedFiles(path.join(os.homedir(), ".asdf", "installs", "python"), "python3", 3),
      ...findNamedFiles(path.join(os.homedir(), ".local", "share", "uv", "python"), "python3", 4),
    );
  } else {
    candidates.push("/usr/bin/python3", "/usr/local/bin/python3");
  }
  return candidates.filter((candidate): candidate is string => !!candidate);
}

function isSupportedExecutable(
  executablePath: string,
  kind: ToolchainKind,
): boolean {
  const cacheKey = `${kind}:${os.platform() === "win32" ? executablePath.toLowerCase() : executablePath}`;
  const cached = executableSupportCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const version = getExecutableVersion(executablePath, kind);
  let supported = version !== "unknown";
  if (supported && kind === "python") {
    supported = probePythonExecutable(executablePath);
  }

  if (supported && kind === "cpp" && os.platform() === "darwin") {
    // The macOS native executor intentionally grants compiler access only to
    // Apple's sealed Xcode/Command Line Tools roots. A Homebrew compiler can
    // compile during the discovery probe outside Seatbelt, but cannot be
    // launched safely during judging and must not be reported as Ready.
    supported = isDarwinSandboxCompatibleCpp(executablePath);
  }

  const basename = path.basename(executablePath).toLowerCase();
  if (
    supported &&
    kind === "cpp" &&
    basename.includes("g++") &&
    compareVersions(version, MIN_GNU_CPP_VERSION) < 0
  ) {
    supported = false;
  }
  if (supported && kind === "cpp" && os.platform() === "win32" && basename.includes("g++")) {
    const binDirectory = path.dirname(executablePath);
    const gccPath = path.join(binDirectory, "gcc.exe");
    const gdbPath = path.join(binDirectory, "gdb.exe");
    if (
      fs.existsSync(gccPath) &&
      compareVersions(getExecutableVersion(gccPath, "cpp"), MIN_GNU_CPP_VERSION) < 0
    )
      supported = false;
    if (
      supported &&
      fs.existsSync(gdbPath) &&
      compareVersions(getGenericExecutableVersion(gdbPath), MIN_GNU_GDB_VERSION) < 0
    )
      supported = false;
  }
  if (supported && kind === "cpp") supported = probeCppCompiler(executablePath);
  executableSupportCache.set(cacheKey, {
    value: supported,
    expiresAt: Date.now() + DETECTION_CACHE_TTL_MS,
  });
  return supported;
}

function probePythonExecutable(executablePath: string): boolean {
  try {
    execFileSync(executablePath, ["-c", "import sys; raise SystemExit(0 if sys.version_info.major >= 3 else 1)"], {
      encoding: "utf8",
      timeout: 3_000,
      stdio: ["ignore", "ignore", "ignore"],
      env: buildToolchainEnvironment(executablePath),
    });
    return true;
  } catch {
    return false;
  }
}

function probeCppCompiler(executablePath: string): boolean {
  const probeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "themis-cpp-probe-"));
  const sourcePath = path.join(probeDirectory, "probe.cpp");
  const outputPath = path.join(
    probeDirectory,
    os.platform() === "win32" ? "probe.exe" : "probe",
  );
  try {
    // MinGW.org GCC 9.2.0 (bundled with Themis) does not accept `-` as a
    // source file on Windows, so use a real temporary file for the probe.
    fs.writeFileSync(sourcePath, "int main() { return 0; }\n", "utf8");
    const platform = os.platform();
    const sdkDirectory = platform === "darwin"
      ? findDarwinSdkDirectory(executablePath)
      : undefined;
    execFileSync(executablePath, buildCompilerProbeArgs(platform, sourcePath, outputPath, sdkDirectory), {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "ignore", "pipe"],
      env: buildToolchainEnvironment(executablePath),
    });
    return fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0;
  } catch (error) {
    if (os.platform() === "darwin") {
      const stderr = typeof error === "object" && error && "stderr" in error
        ? String(error.stderr || "").trim()
        : "";
      console.warn(
        `[Toolchains] Apple Clang probe failed for ${executablePath}: ${stderr || String(error)}`,
      );
    }
    return false;
  } finally {
    fs.rmSync(probeDirectory, { recursive: true, force: true });
  }
}

export function buildCompilerProbeArgs(
  platform: NodeJS.Platform,
  sourcePath: string,
  outputPath: string,
  darwinSdkDirectory?: string | null,
): string[] {
  const args = ["-std=c++14", "-pipe", "-O2"];
  if (platform !== "darwin") {
    if (platform === "win32") {
      args.push(
        "-fsanitize=integer-divide-by-zero",
        "-fsanitize-undefined-trap-on-error",
      );
    }
    args.push("-s", "-static", "-lm");
  } else {
    if (!darwinSdkDirectory) {
      throw new Error("macOS SDK was not found for the Apple Clang probe");
    }
    args.push("-isysroot", darwinSdkDirectory);
  }
  // Current Apple SDKs expose the C math API through libSystem and no longer
  // provide a standalone libm for `-lm`. The Xcode 17 linker also reports `-s`
  // as obsolete, so neither flag belongs in the macOS availability probe.
  args.push("-x", "c++");
  if (platform === "win32") args.push("-Wl,--stack,66060288");
  args.push(sourcePath, "-o", outputPath);
  return args;
}

function getGenericExecutableVersion(executablePath: string): string {
  try {
    const stdout = execFileSync(executablePath, ["--version"], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
      env: buildToolchainEnvironment(executablePath),
    });
    return stdout.match(/([0-9]+(?:\.[0-9]+){1,3})/)?.[1] || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function uniqueExistingFiles(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = os.platform() === "win32" ? value.toLowerCase() : value;
    if (seen.has(key)) return false;
    seen.add(key);
    try {
      return fs.statSync(value).isFile();
    } catch {
      return false;
    }
  });
}

function findNamedFiles(root: string, filename: string, maxDepth: number): string[] {
  if (!fs.existsSync(root)) return [];
  const results: string[] = [];
  const pending: Array<{ directory: string; depth: number }> = [
    { directory: root, depth: 0 },
  ];
  while (pending.length > 0 && results.length < 50) {
    const current = pending.shift()!;
    try {
      const entries = fs
        .readdirSync(current.directory, { withFileTypes: true })
        .sort((left, right) => right.name.localeCompare(left.name, undefined, { numeric: true }));
      for (const entry of entries) {
        const entryPath = path.join(current.directory, entry.name);
        if (
          (entry.isFile() || entry.isSymbolicLink()) &&
          entry.name.toLowerCase() === filename.toLowerCase()
        )
          results.push(entryPath);
        else if (entry.isDirectory() && current.depth < maxDepth)
          pending.push({ directory: entryPath, depth: current.depth + 1 });
      }
    } catch {
      // Ignore protected or concurrently removed installation directories.
    }
  }
  return results;
}

function findVersionedCommands(directory: string, prefixes: string[]): string[] {
  try {
    return fs
      .readdirSync(directory)
      .filter((name) => prefixes.some((prefix) => name.startsWith(prefix)))
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
      .map((name) => path.join(directory, name));
  } catch {
    return [];
  }
}

function findWithCommand(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

function findInLoginShell(command: string): string | null {
  if (os.platform() === "win32") return null;
  const shell = process.env.SHELL && fs.existsSync(process.env.SHELL)
    ? process.env.SHELL
    : "/bin/zsh";
  return findWithCommand(shell, ["-lc", `command -v ${command}`]);
}

function findPythonLauncherInstallations(): string[] {
  const launcher = searchInPath("py") || path.join(process.env.WINDIR || "C:\\Windows", "py.exe");
  if (!fs.existsSync(launcher)) return [];
  try {
    return execFileSync(launcher, ["-0p"], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split(/\r?\n/)
      .map((line) => line.match(/([A-Za-z]:\\.*python(?:3)?\.exe)\s*$/i)?.[1])
      .filter((value): value is string => !!value);
  } catch {
    return [];
  }
}

function findPythonRegistryInstallations(): string[] {
  const roots = [
    "HKCU\\Software\\Python\\PythonCore",
    "HKLM\\Software\\Python\\PythonCore",
    "HKLM\\Software\\WOW6432Node\\Python\\PythonCore",
  ];
  const results: string[] = [];
  for (const root of roots) {
    try {
      const output = execFileSync("reg.exe", ["query", root, "/s", "/v", "ExecutablePath"], {
        encoding: "utf8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      for (const line of output.split(/\r?\n/)) {
        const match = line.match(/REG_SZ\s+(.+python(?:3)?\.exe)\s*$/i);
        if (match) results.push(match[1].trim());
      }
    } catch {
      // Registry key is optional.
    }
  }
  return results;
}

export function resolveToolchain(kind: ToolchainKind): ResolvedToolchain {
  if (sandbox.mode !== "none") {
    return {
      kind,
      source: "sandbox",
      executablePath: kind === "cpp" ? "g++" : "python3",
      version: "Inside sandbox",
      ready: true,
    };
  }
  const profileId = getRegisteredProfileForKind(kind).profile.ref.id;
  const preferenceSnapshot = loadToolchainPreferenceSnapshot();
  const preference = getStoredProfilePreference(
    preferenceSnapshot.preferences,
    profileId,
  );
  if (preferenceSnapshot.status === "recovery") {
    return unavailableToolchain(
      kind,
      "none",
      "Toolchain preferences require recovery.",
      "DISABLED_BY_USER",
    );
  }
  if (preference.mode === "none") {
    return unavailableToolchain(
      kind,
      "none",
      "Toolchain profile is disabled by the user.",
      "DISABLED_BY_USER",
    );
  }
  if (preference.mode === "managed") return resolveManagedToolchain(kind);
  if (preference.mode === "local_path") {
    if (!preference.localPath) {
      return unavailableToolchain(
        kind,
        "custom",
        "A local executable path is required.",
        "LOCAL_PATH_REQUIRED",
      );
    }
    return resolveSelectedLocalExecutable(kind, "custom", preference.localPath);
  }

  const discovery = getToolchainDiscoverySnapshot();
  if (discovery.status === "not_started" || discovery.status === "running") {
    return unavailableToolchain(
      kind,
      "system",
      "Toolchain detection is still in progress.",
      "DETECTION_IN_PROGRESS",
    );
  }
  if (discovery.status === "failed") {
    return unavailableToolchain(
      kind,
      "system",
      "Automatic toolchain detection failed.",
      "AUTO_DETECT_NOT_FOUND",
    );
  }
  const candidates = getDiscoveredCandidates(kind);
  if (candidates.length === 0) {
    return unavailableToolchain(
      kind,
      "system",
      "No compatible local candidate was detected.",
      "AUTO_DETECT_NOT_FOUND",
    );
  }
  if (candidates.length > 1) {
    return unavailableToolchain(
      kind,
      "system",
      "Multiple local candidates were detected; choose one explicitly.",
      "AUTO_DETECT_AMBIGUOUS",
    );
  }
  return resolveSelectedLocalExecutable(
    kind,
    "system",
    candidates[0].canonicalPath,
    candidates[0].candidateId,
  );
}

function resolveSelectedLocalExecutable(
  kind: ToolchainKind,
  source: Extract<ToolchainSource, "custom" | "system">,
  executablePath: string,
  candidateId?: string,
): ResolvedToolchain {
  const isWindowsNetworkOrDevicePath = os.platform() === "win32"
    && executablePath.replaceAll("/", "\\").startsWith("\\\\");
  if (
    !path.isAbsolute(executablePath)
    || isWindowsNetworkOrDevicePath
  ) {
    return {
      ...unavailableToolchain(
        kind,
        source,
        "The selected local executable path is not an accepted absolute local path.",
        "LOCAL_EXECUTABLE_INVALID",
      ),
      executablePath,
      ...(candidateId ? { candidateId } : {}),
    };
  }
  try {
    if (!fs.statSync(executablePath).isFile()) throw new Error("not a file");
  } catch {
    return {
      ...unavailableToolchain(
        kind,
        source,
        "The selected local executable does not exist or is not a regular file.",
        source === "custom" ? "LOCAL_PATH_MISSING" : "AUTO_DETECT_NOT_FOUND",
      ),
      executablePath,
      ...(candidateId ? { candidateId } : {}),
    };
  }
  const version = getExecutableVersion(executablePath, kind);
  const ready = isSupportedExecutable(executablePath, kind);
  const diagnosticCode: NonNullable<ResolvedToolchain["diagnosticCode"]> =
    version === "unknown" ? "LOCAL_EXECUTABLE_INVALID" : "HEALTH_CHECK_FAILED";
  return {
    kind,
    source,
    executablePath,
    version,
    ready,
    ...(candidateId ? { candidateId } : {}),
    ...(!ready
      ? {
          diagnostic: "The selected local executable failed version or health policy.",
          diagnosticCode,
        }
      : {}),
  };
}

/** Explicit user action only; passive discovery never calls this probe. */
export function verifyLocalToolchainCandidate(
  kind: ToolchainKind,
  executablePath: string,
): ResolvedToolchain {
  return resolveSelectedLocalExecutable(kind, "custom", executablePath);
}

function unavailableToolchain(
  kind: ToolchainKind,
  source: ToolchainSource,
  diagnostic: string,
  diagnosticCode: NonNullable<ResolvedToolchain["diagnosticCode"]>,
): ResolvedToolchain {
  return {
    kind,
    source,
    executablePath: "",
    version: "",
    ready: false,
    diagnostic,
    diagnosticCode,
  };
}
