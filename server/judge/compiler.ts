import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executorClient } from "../executor/client.js";
import { DEFAULT_EXECUTOR_LIMITS, type ExecutorRunResult } from "../executor/protocol.js";
import {
  createExecutorWorkspace,
  findCachedManagedToolchain,
  importManagedToolchain,
} from "../executor/workspace.js";
import { attachExecutorRun, detachExecutorRun } from "../jobs.js";
import type { ProblemResult } from "../types.js";
import {
  findDarwinSdkDirectory,
  getExecutableVersion,
  resolveNativeProtectedToolchain,
  resolveToolchain,
} from "../toolchains/resolver.js";
import { getToolchainsDir } from "../toolchains/storage.js";
import type { ResolvedToolchain } from "../toolchains/types.js";
import { RESOURCE_ROOT } from "../runtime.js";
import { isBuiltInChecker } from "./standard-checkers.js";

declare const __JUDGEDESK_TESTLIB__: string;

export const COMPILE_TIMEOUT_MS = 15_000;
export const MAX_GENERATED_FILE_BYTES = 32 * 1024 * 1024;
const MAX_COMPILER_DIAGNOSTIC_BYTES = 256 * 1024;
const COMPILER_MEMORY_BYTES = 1024 * 1024 * 1024;
const gccProgramDirectoryCache = new Map<string, string>();
const gccLibraryDirectoryCache = new Map<string, string[]>();
const gccIncludeDirectoryCache = new Map<string, string[]>();

export interface CompileLimits {
  timeoutMs: number;
  maxGeneratedFileBytes: number;
}

const DEFAULT_COMPILE_LIMITS: CompileLimits = {
  timeoutMs: COMPILE_TIMEOUT_MS,
  maxGeneratedFileBytes: MAX_GENERATED_FILE_BYTES,
};

export interface CompiledChecker {
  path: string | null;
  runtime?: "native" | "python";
  error?: string;
}

interface ResolveCheckerOptions {
  checkerType: string;
  problemName: string;
  problemDirectory: string;
  tempDirectory: string;
  jobId?: string;
}

interface CompileSubmissionOptions {
  language: string;
  contestantName: string;
  problemName: string;
  submissionPath: string;
  tempDirectory: string;
  jobId?: string;
  cppToolchain?: ResolvedToolchain;
}

export interface CompilationResult {
  executablePath: string;
  compileStatus: ProblemResult["compileStatus"];
  compileError: string;
  compileTime: number;
}

interface PreparedCompiler {
  executableId: string;
  executablePath: string;
  root?: string;
  argumentPrefix: string[];
  environment: Record<string, string>;
  compatibilityHeaderPath?: string;
}

function canonicalTestlibSource(): string {
  if (typeof __JUDGEDESK_TESTLIB__ !== "undefined" && __JUDGEDESK_TESTLIB__.length > 0) return __JUDGEDESK_TESTLIB__;
  const developmentPath = path.join(process.cwd(), "judgers", "testlib.h");
  if (fs.existsSync(developmentPath)) return fs.readFileSync(developmentPath, "utf8");
  throw new Error("Bundled testlib.h was not found.");
}

export async function resolveChecker(options: ResolveCheckerOptions): Promise<CompiledChecker> {
  const { checkerType, problemName, problemDirectory, tempDirectory, jobId } = options;
  if (isBuiltInChecker(checkerType)) return { path: null };
  if (checkerType.toLowerCase().endsWith(".cpp")) {
    return compileCustomChecker(checkerType, problemName, problemDirectory, tempDirectory, jobId);
  }
  if (checkerType.toLowerCase().endsWith(".py")) {
    const checkerPath = path.join(problemDirectory, checkerType);
    return fs.existsSync(checkerPath)
      ? { path: checkerPath, runtime: "python" }
      : { path: null, error: `Custom checker ${checkerType} not found.` };
  }
  if (checkerType.toLowerCase().endsWith(".exe")) {
    return {
      path: null,
      error: "Precompiled checker executables are not supported. Use a .cpp or .py source checker.",
    };
  }
  return { path: null, error: `Unsupported checker type '${checkerType}'.` };
}

export async function compileSubmission(options: CompileSubmissionOptions): Promise<CompilationResult> {
  const { language, contestantName, problemName, submissionPath, tempDirectory, jobId } = options;
  const compileStart = process.hrtime.bigint();
  if (language !== "cpp") {
    const python = await resolveCompilationToolchain("python");
    if (!python.ready) return compilationFailure("", "TOOLCHAIN_PYTHON_MISSING", compileStart);
    if (process.platform === "win32" && python.source !== "managed") {
      return compilationFailure("", "TOOLCHAIN_NOT_SANDBOX_COMPATIBLE", compileStart);
    }
    return {
      executablePath: python.executablePath,
      compileStatus: "OK",
      compileError: "",
      compileTime: 0,
    };
  }

  const executablePath = path.join(tempDirectory, `${safeName(contestantName)}_${safeName(problemName)}.out`);
  try {
    const cpp = options.cppToolchain ?? await resolveCompilationToolchain("cpp");
    if (!cpp.ready) throw new Error("TOOLCHAIN_CPP_MISSING");
    if (process.platform === "win32" && cpp.source !== "managed") {
      throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
    }
    await runCompilerPipelineWithLimits(
      cpp.executablePath,
      buildSubmissionCompilerArgs(os.platform(), submissionPath, executablePath),
      tempDirectory,
      executablePath,
      jobId,
    );
    return {
      executablePath,
      compileStatus: "OK",
      compileError: "",
      compileTime: elapsedMs(compileStart),
    };
  } catch (error) {
    return compilationFailure(executablePath, normalizeCompilerError(error), compileStart);
  }
}

async function compileCustomChecker(
  checkerType: string,
  problemName: string,
  problemDirectory: string,
  tempDirectory: string,
  jobId?: string,
): Promise<CompiledChecker> {
  const checkerSourcePath = path.join(problemDirectory, checkerType);
  if (!fs.existsSync(checkerSourcePath)) return { path: null, error: `Custom checker ${checkerType} not found.` };
  const checkerBinaryPath = path.join(tempDirectory, `checker_${safeName(problemName)}_${safeName(checkerType)}.out`);
  const checkerSupportDirectory = path.join(tempDirectory, `checker-support-${crypto.randomUUID()}`);
  const bundledTestlibPath = path.join(checkerSupportDirectory, "testlib.h");
  try {
    fs.mkdirSync(checkerSupportDirectory, { recursive: true });
    fs.writeFileSync(bundledTestlibPath, canonicalTestlibSource(), "utf8");
    const cpp = await resolveCompilationToolchain("cpp");
    if (!cpp.ready) return { path: null, error: "TOOLCHAIN_CPP_MISSING" };
    if (process.platform === "win32" && cpp.source !== "managed") {
      return { path: null, error: "TOOLCHAIN_NOT_SANDBOX_COMPATIBLE" };
    }
    await runCompilerPipelineWithLimits(
      cpp.executablePath,
      ["-std=c++14", "-O2", "-I", checkerSupportDirectory, checkerSourcePath, "-o", checkerBinaryPath],
      tempDirectory,
      checkerBinaryPath,
      jobId,
    );
    return { path: checkerBinaryPath, runtime: "native" };
  } catch (error) {
    return { path: null, error: normalizeCompilerError(error) };
  } finally {
    fs.rmSync(checkerSupportDirectory, { recursive: true, force: true });
  }
}

export async function resolveCompilationToolchain(
  kind: "cpp" | "python",
): Promise<ResolvedToolchain> {
  const selected = resolveNativeProtectedToolchain(kind);
  if (process.platform !== "win32" || selected.source === "managed" || selected.source === "sandbox") {
    return selected;
  }
  return await findCachedManagedToolchain(kind) ?? selected;
}

export function buildSubmissionCompilerArgs(
  platform: NodeJS.Platform,
  sourcePath: string,
  outputPath: string,
): string[] {
  const args = ["-std=c++14", "-pipe", "-O2", "-fno-finite-loops"];
  if (platform === "darwin") {
    // AArch64 integer division by zero does not trap in hardware like x86 IDIV.
    // Ask Apple Clang to emit a runtime trap so the affected testcase receives
    // the same RE verdict on Apple Silicon as it does on Windows.
    args.push(
      "-fsanitize=integer-divide-by-zero",
      "-fsanitize-trap=integer-divide-by-zero",
    );
  } else {
    args.push("-s", "-static", "-lm");
  }
  // Apple SDKs provide math symbols through libSystem rather than a separate
  // libm. Passing `-lm` fails on Xcode 17/macOS 26, while `-s` is obsolete.
  args.push("-x", "c++");
  if (platform === "win32") args.push("-Wl,--stack,66060288");
  args.push(sourcePath, "-o", outputPath);
  return args;
}

export async function runCompilerWithLimits(
  compilerPath: string,
  args: string[],
  cwd: string | undefined,
  outputPath: string,
  jobId?: string,
  limits: CompileLimits = DEFAULT_COMPILE_LIMITS,
): Promise<void> {
  const workspace = await createExecutorWorkspace();
  const runId = `compile_${crypto.randomUUID().replaceAll("-", "_")}`;
  attachExecutorRun(jobId, runId);
  try {
    const compiler = await prepareCompiler(workspace, compilerPath);
    if (compiler.compatibilityHeaderPath) {
      const stagedHeader = workspace.stage(
        compiler.compatibilityHeaderPath,
        "compiler-compat/include/bits/stdc++.h",
      );
      compiler.argumentPrefix.push("-isystem", path.dirname(path.dirname(stagedHeader)));
    }
    const stagedOutput = path.join(workspace.path, "compiled-output.bin");
    const stagedArgs = stageCompilerArguments(workspace.path, args, outputPath, stagedOutput);
    stagedArgs.unshift(...compiler.argumentPrefix);
    const environment = {
      ...buildCompilerEnvironment(compiler.executablePath),
      ...compiler.environment,
    };
    if (process.platform === "win32" && compiler.root) {
      const programDirectory = findGccProgramDirectory(compiler.root);
      // A relocated GCC driver otherwise remembers the source installation prefix and reports
      // "cannot execute cc1plus" inside LPAC. -B and COMPILER_PATH keep every compiler child in
      // the verified read-only toolchain cache and the same Job Object.
      stagedArgs.unshift(`-B${programDirectory}${path.sep}`);
      stagedArgs.unshift(...findGccIncludeDirectories(compiler.root).flatMap((directory) => ["-isystem", directory]));
      environment.COMPILER_PATH = [programDirectory, path.dirname(compiler.executablePath)].join(path.delimiter);
      environment.LIBRARY_PATH = findGccLibraryDirectories(compiler.root).join(path.delimiter);
    }
    const result = await executorClient.run({
      runId,
      role: "compiler",
      workspaceId: workspace.id,
      executableId: compiler.executableId,
      args: stagedArgs,
      stdoutFile: "compiler.stdout",
      stderrFile: "compiler.stderr",
      environment,
      limits: {
        ...DEFAULT_EXECUTOR_LIMITS.compiler,
        wallTimeMs: limits.timeoutMs,
        memoryBytes: COMPILER_MEMORY_BYTES,
        totalWriteBytes: limits.maxGeneratedFileBytes + 4 * 1024 * 1024,
      },
    });
    const stderr = readPreview(path.join(workspace.path, "compiler.stderr"), MAX_COMPILER_DIAGNOSTIC_BYTES);
    assertCompilerSucceeded(result, stderr);
    if (!fs.existsSync(stagedOutput)) throw new Error(stderr.trim() || "Compilation did not produce an output file.");
    if (fs.statSync(stagedOutput).size > limits.maxGeneratedFileBytes) throw new Error("GENERATED_FILE_TOO_LARGE");
    fs.copyFileSync(stagedOutput, outputPath);
  } finally {
    detachExecutorRun(jobId, runId);
    workspace.dispose();
  }
}

async function runCompilerPipelineWithLimits(
  compilerPath: string,
  args: string[],
  cwd: string | undefined,
  outputPath: string,
  jobId?: string,
  limits: CompileLimits = DEFAULT_COMPILE_LIMITS,
): Promise<void> {
  if (process.platform !== "darwin") {
    await runCompilerWithLimits(compilerPath, args, cwd, outputPath, jobId, limits);
    return;
  }

  const objectPath = `${outputPath}.${crypto.randomUUID()}.o`;
  const phases = buildDarwinCompilerPhases(args, outputPath, objectPath);
  const started = process.hrtime.bigint();
  try {
    await runCompilerWithLimits(compilerPath, phases.compile, cwd, objectPath, jobId, limits);
    const elapsed = elapsedMs(started);
    const remaining = Math.max(1, limits.timeoutMs - Math.ceil(elapsed));
    await runCompilerWithLimits(
      compilerPath,
      phases.link,
      cwd,
      outputPath,
      jobId,
      { ...limits, timeoutMs: remaining },
    );
  } finally {
    fs.rmSync(objectPath, { force: true });
  }
}

export function buildDarwinCompilerPhases(
  args: string[],
  outputPath: string,
  objectPath: string,
): { compile: string[]; link: string[] } {
  const compile: string[] = [];
  const linkerFlags: string[] = [];
  let foundOutput = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "-o" && index + 1 < args.length && samePath(args[index + 1], outputPath)) {
      foundOutput = true;
      index += 1;
      continue;
    }
    if (argument === "-s" || argument === "-lm" || argument.startsWith("-Wl,")) {
      linkerFlags.push(argument);
      continue;
    }
    compile.push(argument);
  }
  if (!foundOutput) throw new Error("Compiler output argument was not found.");
  compile.push("-c", "-o", objectPath);
  return {
    compile,
    link: [objectPath, "-o", outputPath, ...linkerFlags],
  };
}

export function buildCompilerEnvironment(
  compilerPath: string,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  // The native executor supplies a small set of safe OS variables itself. Sending
  // process.env here is both unnecessary and unsafe: Visual Studio Developer
  // PowerShell commonly contains more than the protocol's 128-entry limit.
  return platform === "win32" ? { Path: path.dirname(compilerPath) } : {};
}

async function prepareCompiler(
  workspace: Awaited<ReturnType<typeof createExecutorWorkspace>>,
  compilerPath: string,
): Promise<PreparedCompiler> {
  const cached = await findCachedManagedToolchain("cpp");
  if (cached && sameFile(cached.executablePath, compilerPath)) {
    return {
      executableId: cached.executableId,
      executablePath: cached.executablePath,
      root: cached.root,
      argumentPrefix: [],
      environment: {},
    };
  }
  const resolved = resolveToolchain("cpp");
  if (resolved.ready && resolved.source === "managed" && sameFile(resolved.executablePath, compilerPath)) {
    return {
      ...await importManagedToolchain("cpp", resolved.executablePath, resolved.version),
      argumentPrefix: [],
      environment: {},
    };
  }
  const realCompiler = fs.realpathSync(compilerPath);
  const managedRoot = fs.realpathSync(getToolchainsDir());
  if (isDescendant(managedRoot, realCompiler)) {
    return {
      ...await importManagedToolchain("cpp", realCompiler, getExecutableVersion(realCompiler, "cpp")),
      argumentPrefix: [],
      environment: {},
    };
  }
  const darwin = process.platform === "darwin" ? resolveDarwinCompilerSupport(realCompiler) : null;
  const name = stagedCompilerName(realCompiler);
  const staged = workspace.stage(realCompiler, name, true);
  return {
    executableId: workspace.relative(name),
    executablePath: staged,
    argumentPrefix: darwin?.argumentPrefix ?? [],
    environment: darwin?.environment ?? {},
    compatibilityHeaderPath: darwin
      ? resolveDarwinCompatibilityHeader(RESOURCE_ROOT)
      : undefined,
  };
}

export function resolveDarwinCompatibilityHeader(resourceRoot: string): string {
  const header = path.join(resourceRoot, "compiler-compat", "include", "bits", "stdc++.h");
  let metadata: fs.Stats;
  try {
    metadata = fs.lstatSync(header);
  } catch {
    throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE: JudgeDesk C++ compatibility headers were not found");
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE: JudgeDesk C++ compatibility header is invalid");
  }
  return fs.realpathSync(header);
}

export function stagedCompilerName(
  compilerPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  // Apple Clang re-executes its own driver for the cc1 phase. Keeping clang/clang++ in argv[0]
  // is therefore functional, not cosmetic; renaming it to "compiler" makes posix_spawn fail.
  return platform === "win32" ? "compiler.exe" : path.basename(compilerPath);
}

export function resolveDarwinCompilerSupport(compilerPath: string): {
  argumentPrefix: string[];
  environment: Record<string, string>;
} {
  const compiler = fs.realpathSync(compilerPath);
  const commandLineTools = fs.existsSync("/Library/Developer/CommandLineTools")
    ? fs.realpathSync("/Library/Developer/CommandLineTools")
    : null;
  const toolchainRoot = findAncestor(compiler, (candidate) =>
    path.basename(candidate).endsWith(".xctoolchain"),
  ) ?? (commandLineTools && isDescendantOrEqual(commandLineTools, compiler) ? commandLineTools : null);
  const developerRoot = findAncestor(compiler, (candidate) =>
    path.basename(candidate) === "Developer" && path.basename(path.dirname(candidate)) === "Contents",
  ) ?? (commandLineTools && isDescendantOrEqual(commandLineTools, compiler) ? commandLineTools : null);
  if (!toolchainRoot || !developerRoot) {
    throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE: use Apple Clang from Xcode or Command Line Tools");
  }

  const resourceBase = path.join(toolchainRoot, "usr", "lib", "clang");
  const resourceDirectory = fs.readdirSync(resourceBase, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(resourceBase, entry.name, "include")))
    .map((entry) => path.join(resourceBase, entry.name))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    .at(-1);
  const sdkDirectory = findDarwinSdkDirectory(compiler);
  if (!resourceDirectory || !sdkDirectory) {
    throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE: Apple Clang resource directory or macOS SDK was not found");
  }

  return {
    argumentPrefix: [
      "--driver-mode=g++",
      "-fintegrated-cc1",
      // Seatbelt can prevent the driver from inferring this directory through realpath.
      // Pin it to the Apple toolchain path already validated by the native executor.
      "-ccc-install-dir",
      path.dirname(compiler),
      "-resource-dir",
      fs.realpathSync(resourceDirectory),
      "-isysroot",
      fs.realpathSync(sdkDirectory),
      `-B${path.dirname(compiler)}${path.sep}`,
    ],
    environment: {
      JUDGEDESK_COMPILER_TOOLCHAIN_ROOT: fs.realpathSync(toolchainRoot),
      JUDGEDESK_COMPILER_DEVELOPER_ROOT: fs.realpathSync(developerRoot),
      JUDGEDESK_COMPILER_EXECUTABLE: compiler,
    },
  };
}

function findAncestor(candidate: string, matches: (value: string) => boolean): string | null {
  let current = path.resolve(candidate);
  while (true) {
    if (matches(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function isDescendantOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isDescendant(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function findGccProgramDirectory(root: string): string {
  const cached = gccProgramDirectoryCache.get(root);
  if (cached) return cached;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      if (entry.isFile() && entry.name.toLowerCase() === "cc1plus.exe") {
        gccProgramDirectoryCache.set(root, directory);
        return directory;
      }
    }
  }
  throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE: cc1plus.exe was not found in the managed GCC cache");
}

function findGccLibraryDirectories(root: string): string[] {
  const cached = gccLibraryDirectoryCache.get(root);
  if (cached) return cached;
  const markerNames = new Set([
    "crt2.o",
    "crtbegin.o",
    "libgcc.a",
    "libmingw32.a",
    "libstdc++.a",
  ]);
  const directories = new Set<string>();
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile() && markerNames.has(entry.name.toLowerCase())) {
        directories.add(directory);
      }
    }
  }
  const result = [...directories];
  if (result.length === 0) {
    throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE: managed GCC libraries were not found");
  }
  gccLibraryDirectoryCache.set(root, result);
  return result;
}

export function findGccIncludeDirectories(root: string): string[] {
  const cached = gccIncludeDirectoryCache.get(root);
  if (cached) return cached;
  let cppRoot: string | undefined;
  const cppTargets = new Set<string>();
  const gccIncludes = new Set<string>();
  const fixedIncludes = new Set<string>();
  const systemIncludes = new Set<string>();
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const normalized = entryPath.replaceAll("\\", "/").toLowerCase();
      if (entry.name === "iostream" && normalized.includes("/include/c++/")) {
        cppRoot = directory;
        for (const child of fs.readdirSync(directory, { withFileTypes: true })) {
          if (!child.isDirectory() || child.name === "backward") continue;
          const candidate = path.join(directory, child.name);
          if (fs.existsSync(path.join(candidate, "bits", "c++config.h"))) cppTargets.add(candidate);
        }
      } else if (entry.name.toLowerCase() === "stddef.h" && normalized.includes("/lib/gcc/")) {
        gccIncludes.add(directory);
        const fixed = path.join(path.dirname(directory), "include-fixed");
        if (fs.existsSync(fixed)) fixedIncludes.add(fixed);
      } else if (entry.name.toLowerCase() === "windows.h" && /\/[^/]+-w64-mingw32\/include\/windows\.h$/.test(normalized)) {
        systemIncludes.add(directory);
      }
    }
  }
  if (!cppRoot || gccIncludes.size === 0 || systemIncludes.size === 0) {
    throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE: managed GCC headers were not found");
  }
  const backward = path.join(cppRoot, "backward");
  const result = [
    cppRoot,
    ...cppTargets,
    ...(fs.existsSync(backward) ? [backward] : []),
    ...gccIncludes,
    ...fixedIncludes,
    ...systemIncludes,
  ];
  gccIncludeDirectoryCache.set(root, result);
  return result;
}

function stageCompilerArguments(
  workspacePath: string,
  args: string[],
  outputPath: string,
  stagedOutput: string,
): string[] {
  const staged = new Map<string, string>();
  return args.map((argument, index) => {
    if (samePath(argument, outputPath)) return stagedOutput;
    if (!path.isAbsolute(argument) || !fs.existsSync(argument)) return argument;
    const canonical = fs.realpathSync(argument);
    const existing = staged.get(canonical);
    if (existing) return existing;
    const metadata = fs.lstatSync(canonical);
    if (metadata.isSymbolicLink()) throw new Error("Compiler inputs cannot be symlinks.");
    const destination = path.join(workspacePath, "inputs", `${index}_${safeName(path.basename(canonical))}`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (metadata.isDirectory()) {
      assertTreeContainsNoLinks(canonical);
      fs.cpSync(canonical, destination, { recursive: true, dereference: false, force: false });
    } else if (metadata.isFile()) {
      fs.copyFileSync(canonical, destination);
    } else {
      throw new Error("Compiler inputs must be regular files or directories.");
    }
    staged.set(canonical, destination);
    return destination;
  });
}

function assertCompilerSucceeded(result: ExecutorRunResult, stderr: string): void {
  switch (result.reason) {
    case "wall_time_limit":
      throw new Error("COMPILER_TIMEOUT");
    case "output_limit":
    case "write_limit":
      throw new Error("GENERATED_FILE_TOO_LARGE");
    case "cancelled":
      throw new Error("COMPILATION_CANCELLED");
    case "sandbox_denied":
    case "launch_error":
    case "internal_error":
      throw new Error(`SECURE_RUNNER_LAUNCH_FAILED: ${result.diagnostic || stderr}`);
    case "memory_limit":
      throw new Error("COMPILER_MEMORY_LIMIT");
    case "process_limit":
    case "thread_limit":
      throw new Error("COMPILER_RESOURCE_LIMIT");
    case "exited":
      if (result.exitCode !== 0) throw new Error(stderr.trim() || `Compilation failed (exit code ${result.exitCode})`);
  }
}

function assertTreeContainsNoLinks(root: string): void {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    const metadata = fs.lstatSync(entryPath);
    if (metadata.isSymbolicLink()) throw new Error("Compiler input directories cannot contain symlinks.");
    if (metadata.isDirectory()) assertTreeContainsNoLinks(entryPath);
  }
}

function readPreview(filePath: string, maxBytes: number): string {
  if (!fs.existsSync(filePath)) return "";
  const handle = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(Math.min(maxBytes, fs.fstatSync(handle).size));
    return buffer.subarray(0, fs.readSync(handle, buffer, 0, buffer.length, 0)).toString("utf8");
  } finally {
    fs.closeSync(handle);
  }
}

function compilationFailure(executablePath: string, error: string, started: bigint): CompilationResult {
  return { executablePath, compileStatus: "CE", compileError: error, compileTime: elapsedMs(started) };
}

function normalizeCompilerError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("GENERATED_FILE_TOO_LARGE")) return "GENERATED_FILE_TOO_LARGE";
  if (message.includes("COMPILER_TIMEOUT")) return "COMPILER_TIMEOUT";
  return message.trim() || "Compilation failed";
}

function safeName(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9_.-]/g, "_").slice(0, 96) || "artifact";
}

function elapsedMs(started: bigint): number {
  return Number(process.hrtime.bigint() - started) / 1_000_000;
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function sameFile(left: string, right: string): boolean {
  try { return samePath(fs.realpathSync(left), fs.realpathSync(right)); } catch { return false; }
}
