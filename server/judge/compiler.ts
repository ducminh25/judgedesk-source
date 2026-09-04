import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExecutorRunResult } from "../executor/protocol.js";
import type {
  ExecutorLocalToolchainIdentity,
  ExecutorToolchainIdentity,
} from "../executor/protocol.js";
import { executorClient } from "../executor/client.js";
import {
  createExecutorWorkspace,
  findCachedManagedToolchain,
  importManagedToolchain,
  inspectRegularDirectory,
  prepareManagedToolchainComponent,
  prepareManagedToolchainExecutable,
} from "../executor/workspace.js";
import {
  attachExecutorRun,
  detachExecutorRun,
  runReservedExecutor,
} from "../jobs.js";
import type {
  ProblemCompileConfig,
  ProblemResult,
  SubmissionLanguage,
} from "../types.js";
import {
  findDarwinSdkDirectory,
  findSelectedDarwinCompiler,
  getExecutableVersion,
  isManagedSubmissionToolchainReady,
  resolveManagedToolchain,
  resolveNativeProtectedToolchain,
  resolveToolchain,
} from "../toolchains/resolver.js";
import { getToolchainsDir } from "../toolchains/storage.js";
import { deriveLocalToolchain } from "../toolchains/local-execution.js";
import type {
  ResolvedToolchain,
  ToolchainKind,
} from "../toolchains/types.js";
import {
  buildCertifiedWindowsCppCheckerArgs,
} from "../toolchains/cpp-certification-policy.js";
import { RESOURCE_ROOT } from "../runtime.js";
import { resolveCompilerMemoryLimitBytes } from "./resource-policy.js";
import { buildCompilerExecutorRunSpec } from "./execution-request.js";
import { isBuiltInChecker } from "./standard-checkers.js";
import { validatePythonCheckerSource } from "./python-checker.js";
import {
  buildCompilerAdapterEnvironment,
  buildJavaCompilationArgs,
  buildManagedPascalSupportArgs,
  buildNativeCompilationRecipe,
  isNativeCompiledLanguage,
  resolveJavaSubmissionStaging,
} from "./language-adapters.js";
import type { PreparedSubmissionProgram } from "./prepared-program.js";

declare const __JUDGEDESK_TESTLIB__: string;

export const COMPILE_TIMEOUT_MS = 15_000;
export const MAX_GENERATED_FILE_BYTES = 32 * 1024 * 1024;
const MAX_COMPILER_DIAGNOSTIC_BYTES = 256 * 1024;
const gccProgramDirectoryCache = new Map<string, string>();
const gccLibraryDirectoryCache = new Map<string, string[]>();
const gccIncludeDirectoryCache = new Map<string, string[]>();

export {
  CHECKER_COMPILE_TIMEOUT_MS,
  CHECKER_COMPILE_MEMORY_LIMIT_BYTES,
  CHECKER_COMPILE_LIMITS,
  getBundledTestlibSource,
  buildCustomCheckerCompilerArgs,
  compileCustomChecker,
  resolveChecker,
  type CompiledChecker,
  type ResolveCheckerOptions,
} from "./checker-compiler.js";

export {
  resolveInteractor,
  type CompiledInteractor,
  type ResolveInteractorOptions,
} from "./interactor-compiler.js";

export interface CompileLimits {
  timeoutMs: number;
  maxGeneratedFileBytes: number;
  maxWorkspaceWriteBytes?: number;
  maxCreatedFiles?: number;
  memoryBytes?: number;
}

const DEFAULT_COMPILE_LIMITS: CompileLimits = {
  timeoutMs: COMPILE_TIMEOUT_MS,
  maxGeneratedFileBytes: MAX_GENERATED_FILE_BYTES,
};

interface CompileSubmissionOptions {
  language: SubmissionLanguage;
  contestantName: string;
  problemName: string;
  submissionPath: string;
  tempDirectory: string;
  jobId?: string;
  compile?: ProblemCompileConfig;
  cppToolchain?: ResolvedToolchain;
  cToolchain?: ResolvedToolchain;
  pythonToolchain?: ResolvedToolchain;
  toolchains?: Readonly<Partial<Record<ToolchainKind, ResolvedToolchain>>>;
}

export interface CompilationResult {
  executablePath: string;
  compileStatus: ProblemResult["compileStatus"];
  compileError: string;
  compileTime: number;
  program?: PreparedSubmissionProgram;
}

interface PreparedCompiler {
  executableId: string;
  executablePath: string;
  root?: string;
  argumentPrefix: string[];
  environment: Record<string, string>;
  compatibilityHeaderPath?: string;
  toolchain?: ExecutorToolchainIdentity;
  localToolchain?: ExecutorLocalToolchainIdentity;
}

export async function compileSubmission(options: CompileSubmissionOptions): Promise<CompilationResult> {
  const { language, contestantName, problemName, submissionPath, tempDirectory, jobId } = options;
  const compileStart = process.hrtime.bigint();
  if (language === "python") {
    const python = options.toolchains?.python
      ?? options.pythonToolchain
      ?? await resolveCompilationToolchain("python");
    if (!python.ready) return compilationFailure("", "TOOLCHAIN_PYTHON_MISSING", compileStart);
    if (python.source !== "managed" && !python.localToolchain) {
      return compilationFailure("", "TOOLCHAIN_NOT_SANDBOX_COMPATIBLE", compileStart);
    }
    return {
      executablePath: python.executablePath,
      compileStatus: "OK",
      compileError: "",
      compileTime: 0,
      program: {
        kind: "script-runtime",
        language: "python",
        sourcePath: submissionPath,
        stagedFileName: "submission.py",
        runtimeKind: "python",
        runtimeToolchain: python,
      },
    };
  }
  if (language === "javascript") {
    const javascript = options.toolchains?.javascript
      ?? await resolveCompilationToolchain("javascript");
    if (!isManagedSubmissionToolchainReady(javascript)) {
      return compilationFailure(
        "",
        "TOOLCHAIN_JAVASCRIPT_MISSING",
        compileStart,
      );
    }
    return {
      executablePath:
        javascript.executionPath || javascript.executablePath,
      compileStatus: "OK",
      compileError: "",
      compileTime: 0,
      program: {
        kind: "script-runtime",
        language: "javascript",
        sourcePath: submissionPath,
        stagedFileName: "submission.js",
        runtimeKind: "javascript",
        runtimeToolchain: javascript,
      },
    };
  }
  if (language === "scratch") {
    const scratch = options.toolchains?.scratch
      ?? await resolveCompilationToolchain("scratch");
    if (!isManagedSubmissionToolchainReady(scratch)) {
      return compilationFailure(
        "",
        "TOOLCHAIN_SCRATCH_MISSING",
        compileStart,
      );
    }
    const ext = path.extname(submissionPath).toLowerCase() || ".sb3";
    return {
      executablePath:
        scratch.executionPath || scratch.executablePath,
      compileStatus: "OK",
      compileError: "",
      compileTime: 0,
      program: {
        kind: "script-runtime",
        language: "scratch",
        sourcePath: submissionPath,
        stagedFileName: `submission${ext}`,
        runtimeKind: "scratch",
        runtimeToolchain: scratch,
      },
    };
  }
  if (language === "java" || language === "csharp") {
    return compileManagedDirectorySubmission(options, compileStart);
  }
  if (!isNativeCompiledLanguage(language)) {
    return compilationFailure(
      "",
      `LANGUAGE_ADAPTER_UNAVAILABLE: ${language}`,
      compileStart,
    );
  }

  const executablePath = path.join(tempDirectory, `${safeName(contestantName)}_${safeName(problemName)}.out`);
  try {
    const recipe = buildNativeCompilationRecipe(
      language,
      os.platform(),
      submissionPath,
      executablePath,
      options.compile,
    );
    const toolchain = options.toolchains?.[recipe.toolchainKind]
      ?? (language === "cpp"
        ? options.cppToolchain
        : language === "c"
          ? options.cToolchain
          : undefined)
      ?? await resolveCompilationToolchain(recipe.toolchainKind);
    if (!toolchain.ready) {
      throw new Error(`TOOLCHAIN_${language.toUpperCase()}_MISSING`);
    }
    if (
      language !== "cpp"
      && language !== "c"
      && !isManagedSubmissionToolchainReady(toolchain)
    ) {
      throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
    }
    if (
      process.platform === "win32"
      && !isWindowsNativeCompilerExecutionReady(toolchain)
    ) {
      throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
    }
    const compilerPath = toolchain.executionPath || toolchain.executablePath;
    const limits = {
      timeoutMs: recipe.timeoutMs,
      maxGeneratedFileBytes: recipe.maxGeneratedFileBytes,
      maxWorkspaceWriteBytes: recipe.maxWorkspaceWriteBytes,
      maxCreatedFiles: recipe.maxCreatedFiles,
    };
    if (recipe.splitCompilerPhases) {
      await runCompilerPipelineWithLimits(
        compilerPath,
        recipe.args,
        tempDirectory,
        executablePath,
        jobId,
        limits,
        recipe.toolchainKind as "cpp" | "c",
        recipe.environment,
        toolchain,
      );
    } else {
      await runCompilerWithLimits(
        compilerPath,
        recipe.args,
        tempDirectory,
        executablePath,
        jobId,
        limits,
        recipe.toolchainKind,
        recipe.environment,
        toolchain,
      );
    }
    return {
      executablePath,
      compileStatus: "OK",
      compileError: "",
      compileTime: elapsedMs(compileStart),
      program: {
        kind: "native",
        language,
        artifactPath: executablePath,
      },
    };
  } catch (error) {
    return compilationFailure(executablePath, normalizeCompilerError(error), compileStart);
  }
}

async function compileManagedDirectorySubmission(
  options: CompileSubmissionOptions,
  compileStart: bigint,
): Promise<CompilationResult> {
  const language = options.language as "java" | "csharp";
  const toolchain = options.toolchains?.[language]
    ?? await resolveCompilationToolchain(language);
  const artifactDirectory = path.join(
    options.tempDirectory,
    `${safeName(options.contestantName)}_${safeName(options.problemName)}_${language}`,
  );
  try {
    if (!isManagedSubmissionToolchainReady(toolchain)) {
      throw new Error(`TOOLCHAIN_${language.toUpperCase()}_MISSING`);
    }
    const compilerPath = toolchain.executionPath || toolchain.executablePath;
    if (language === "java") {
      const fallbackCandidate = safeName(
        path.basename(options.submissionPath, path.extname(options.submissionPath)),
      ) || "Main";
      const { stagedSourceName, entrypointCandidate } =
        resolveJavaSubmissionStaging(options.submissionPath, fallbackCandidate);
      await runDirectoryCompilerWithLimits({
        kind: "java",
        compilerPath,
        sourcePath: options.submissionPath,
        stagedSourceName,
        outputPath: artifactDirectory,
        jobId: options.jobId,
        limits: {
          timeoutMs: 30_000,
          maxGeneratedFileBytes: 64 * 1024 * 1024,
          memoryBytes: 768 * 1024 * 1024,
        },
        pinnedToolchain: toolchain,
        buildArgs: ({ sourcePath, outputDirectory }) =>
          buildJavaCompilationArgs(sourcePath, outputDirectory),
        validateArtifact: (directory) =>
          validateJavaClassDirectory(directory, entrypointCandidate),
      });
      const resolvedEntrypoint = resolveJavaEntrypoint(
        artifactDirectory,
        entrypointCandidate,
      );
      return {
        executablePath: artifactDirectory,
        compileStatus: "OK",
        compileError: "",
        compileTime: elapsedMs(compileStart),
        program: {
          kind: "directory-runtime",
          language: "java",
          artifactDirectory,
          entrypoint: resolvedEntrypoint,
          runtimeKind: "java",
          runtimeToolchain: toolchain,
          runtimeComponentId: "java.runtime",
        },
      };
    }

    await runDirectoryCompilerWithLimits({
      kind: "csharp",
      compilerPath,
      sourcePath: options.submissionPath,
      stagedSourceName: "Submission.cs",
      outputPath: artifactDirectory,
      jobId: options.jobId,
      limits: {
        timeoutMs: 60_000,
        maxGeneratedFileBytes: 64 * 1024 * 1024,
        memoryBytes: 1024 * 1024 * 1024,
      },
      pinnedToolchain: toolchain,
      generatedArtifactFiles: {
        "JudgeDeskSubmission.deps.json": CSHARP_DEPS_FILE,
        "JudgeDeskSubmission.runtimeconfig.json": CSHARP_RUNTIME_CONFIG,
      },
      buildArgs: prepareDotnetCscArgs,
      validateArtifact: validateDotnetArtifactDirectory,
    });
    return {
      executablePath: artifactDirectory,
      compileStatus: "OK",
      compileError: "",
      compileTime: elapsedMs(compileStart),
      program: {
        kind: "directory-runtime",
        language: "csharp",
        artifactDirectory,
        entrypoint: "JudgeDeskSubmission.dll",
        runtimeKind: "csharp",
        runtimeToolchain: toolchain,
        runtimeComponentId: "dotnet.host",
      },
    };
  } catch (error) {
    fs.rmSync(artifactDirectory, { recursive: true, force: true });
    return compilationFailure(
      artifactDirectory,
      normalizeCompilerError(error),
      compileStart,
    );
  }
}

interface DirectoryCompilerContext {
  workspacePath: string;
  sourcePath: string;
  outputDirectory: string;
  toolchainRoot: string;
}

interface DirectoryCompilerOptions {
  kind: Extract<ToolchainKind, "java" | "csharp">;
  compilerPath: string;
  sourcePath: string;
  stagedSourceName: string;
  outputPath: string;
  jobId?: string;
  limits: CompileLimits;
  pinnedToolchain: Readonly<ResolvedToolchain>;
  generatedFiles?: Readonly<Record<string, string>>;
  generatedArtifactFiles?: Readonly<Record<string, string>>;
  buildArgs(context: DirectoryCompilerContext): string[];
  validateArtifact(directory: string): void;
}

async function runDirectoryCompilerWithLimits(
  options: DirectoryCompilerOptions,
): Promise<void> {
  const workspace = await createExecutorWorkspace();
  const runId = `compile_${crypto.randomUUID().replaceAll("-", "_")}`;
  try {
    attachExecutorRun(options.jobId, runId);
    const compiler = await prepareCompiler(
      workspace,
      options.compilerPath,
      options.kind,
      options.pinnedToolchain,
    );
    const stagedSource = workspace.stage(
      options.sourcePath,
      path.join("inputs", options.stagedSourceName),
    );
    for (const [relativePath, contents] of Object.entries(
      options.generatedFiles ?? {},
    )) {
      workspace.relative(relativePath);
      const destination = path.join(workspace.path, relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, contents, {
        encoding: "utf8",
        flag: "wx",
      });
    }
    const stagedOutput = path.join(workspace.path, "compiled-output");
    fs.mkdirSync(stagedOutput);
    if (!compiler.root) {
      throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
    }
    const environment = {
      ...buildCompilerEnvironment(compiler.executablePath),
      ...buildCompilerAdapterEnvironment(
        options.kind,
        workspace.path,
        compiler.root,
        compiler.executablePath,
      ),
      ...compiler.environment,
    };
    const result = await runReservedExecutor(
      options.jobId,
      buildCompilerExecutorRunSpec({
        runId,
        workspaceId: workspace.id,
        executableId: compiler.executableId,
        args: [
          ...compiler.argumentPrefix,
          ...options.buildArgs({
            workspacePath: workspace.path,
            sourcePath: stagedSource,
            outputDirectory: stagedOutput,
            toolchainRoot: compiler.root,
          }),
        ],
        environment,
        toolchain: compiler.toolchain,
        localToolchain: compiler.localToolchain,
        timeoutMs: options.limits.timeoutMs,
        memoryBytes:
          options.limits.memoryBytes ?? resolveCompilerMemoryLimitBytes(),
        maxGeneratedFileBytes: options.limits.maxGeneratedFileBytes,
      }),
    );
    const diagnostics = readCompilerDiagnostics(workspace.path);
    assertCompilerSucceeded(result, diagnostics);
    for (const [relativePath, contents] of Object.entries(
      options.generatedArtifactFiles ?? {},
    )) {
      const normalized = path.join("compiled-output", relativePath);
      workspace.relative(normalized);
      fs.writeFileSync(path.join(workspace.path, normalized), contents, {
        encoding: "utf8",
        flag: "wx",
      });
    }
    const artifact = inspectRegularDirectory(stagedOutput, {
      maxFiles: 512,
      maxBytes: options.limits.maxGeneratedFileBytes,
    });
    if (artifact.files === 0) {
      throw new Error(
        diagnostics.trim() || "Compilation did not produce an artifact.",
      );
    }
    options.validateArtifact(stagedOutput);
    if (fs.existsSync(options.outputPath)) {
      throw new Error("Compiler artifact destination already exists.");
    }
    fs.cpSync(stagedOutput, options.outputPath, {
      recursive: true,
      dereference: false,
      force: false,
      errorOnExist: true,
    });
  } finally {
    detachExecutorRun(options.jobId, runId);
    workspace.dispose();
  }
}

export function resolveJavaEntrypoint(
  directory: string,
  candidate: string = "Main",
): string {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  if (
    entries.some((entry) => entry.isFile() && entry.name === `${candidate}.class`)
  ) {
    return candidate;
  }
  if (entries.some((entry) => entry.isFile() && entry.name === "Main.class")) {
    return "Main";
  }
  const firstClass = entries.find(
    (entry) => entry.isFile() && entry.name.endsWith(".class"),
  );
  if (firstClass) {
    return path.basename(firstClass.name, ".class");
  }
  throw new Error(
    `JAVA_ENTRYPOINT_INVALID: source must declare public class ${candidate} or Main without a package`,
  );
}

export function validateJavaClassDirectory(
  directory: string,
  candidate: string = "Main",
): void {
  resolveJavaEntrypoint(directory, candidate);
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  if (
    entries.some((entry) =>
      !entry.isFile()
      || !/^[A-Za-z_$][A-Za-z0-9_$]*\.class$/.test(entry.name)
    )
  ) {
    throw new Error(
      "JAVA_ARTIFACT_INVALID: packaged classes and nested output directories are not supported",
    );
  }
}

export function validateDotnetArtifactDirectory(directory: string): void {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files = new Set(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name),
  );
  if (
    entries.some((entry) => !entry.isFile())
    || !files.has("JudgeDeskSubmission.dll")
    || !files.has("JudgeDeskSubmission.deps.json")
    || !files.has("JudgeDeskSubmission.runtimeconfig.json")
    || [...files].some((file) =>
      !/^JudgeDeskSubmission\.(?:dll|deps\.json|runtimeconfig\.json)$/.test(
        file,
      )
    )
  ) {
    throw new Error("DOTNET_ARTIFACT_INVALID");
  }
}

const DOTNET_SDK_VERSION = "10.0.302";
const DOTNET_RUNTIME_VERSION = "10.0.10";

export function buildDotnetCscArgs(
  context: DirectoryCompilerContext,
): string[] {
  const compilerAssembly = path.join(
    context.toolchainRoot,
    "sdk",
    DOTNET_SDK_VERSION,
    "Roslyn",
    "bincore",
    "csc.dll",
  );
  const referenceDirectory = path.join(
    context.toolchainRoot,
    "packs",
    "Microsoft.NETCore.App.Ref",
    DOTNET_RUNTIME_VERSION,
    "ref",
    "net10.0",
  );
  if (!fs.statSync(compilerAssembly, { throwIfNoEntry: false })?.isFile()) {
    throw new Error("DOTNET_COMPILER_LAYOUT_INVALID");
  }
  if (
    !fs.statSync(referenceDirectory, { throwIfNoEntry: false })?.isDirectory()
  ) {
    throw new Error("DOTNET_REFERENCE_PACK_INVALID");
  }
  const references = fs
    .readdirSync(referenceDirectory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() && /^[A-Za-z0-9_.-]+\.dll$/.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  if (
    references.length < 100
    || references.length > 256
    || !references.includes("System.Runtime.dll")
    || !references.includes("System.Console.dll")
  ) {
    throw new Error("DOTNET_REFERENCE_PACK_INVALID");
  }
  return [
    "exec",
    compilerAssembly,
    "/noconfig",
    "/nostdlib+",
    "/target:exe",
    "/optimize+",
    "/debug-",
    "/deterministic+",
    "/langversion:14.0",
    "/nullable:disable",
    "/utf8output",
    `/pathmap:${context.workspacePath}=/_/`,
    `/lib:${referenceDirectory}`,
    `/out:${path.join(context.outputDirectory, "JudgeDeskSubmission.dll")}`,
    ...references.map((reference) => `/reference:${reference}`),
    context.sourcePath,
  ];
}

function prepareDotnetCscArgs(
  context: DirectoryCompilerContext,
): string[] {
  const [command, compilerAssembly, ...compilerArguments] =
    buildDotnetCscArgs(context);
  const responseFileName = "csc.rsp";
  fs.writeFileSync(
    path.join(context.workspacePath, responseFileName),
    `${compilerArguments.map(encodeCscResponseArgument).join("\n")}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  return [command, compilerAssembly, `@${responseFileName}`];
}

function encodeCscResponseArgument(value: string): string {
  if (!value.includes('"') && !/[\s#]/.test(value)) return value;
  if (value.includes('"')) {
    throw new Error("DOTNET_COMPILER_ARGUMENT_INVALID");
  }
  return `"${value}"`;
}

const CSHARP_RUNTIME_CONFIG = `${JSON.stringify({
  runtimeOptions: {
    tfm: "net10.0",
    framework: {
      name: "Microsoft.NETCore.App",
      version: DOTNET_RUNTIME_VERSION,
    },
    rollForward: "Disable",
  },
}, null, 2)}\n`;

const CSHARP_DEPS_FILE = `${JSON.stringify({
  runtimeTarget: {
    name: ".NETCoreApp,Version=v10.0",
    signature: "",
  },
  compilationOptions: {},
  targets: {
    ".NETCoreApp,Version=v10.0": {
      "JudgeDeskSubmission/1.0.0": {
        runtime: {
          "JudgeDeskSubmission.dll": {},
        },
      },
    },
  },
  libraries: {
    "JudgeDeskSubmission/1.0.0": {
      type: "project",
      serviceable: false,
      sha512: "",
    },
  },
}, null, 2)}\n`;

export async function resolveCompilationToolchain(
  kind: ToolchainKind,
): Promise<ResolvedToolchain> {
  const selected = resolveNativeProtectedToolchain(kind);
  if (kind === "python") {
    const managed = resolveManagedToolchain(kind);
    return chooseCompilationToolchain(kind, selected, managed);
  }
  return selected;
}

export function chooseCompilationToolchain(
  kind: ToolchainKind,
  selected: ResolvedToolchain,
  managed: ResolvedToolchain,
): ResolvedToolchain {
  if (kind !== "python") return selected;
  // A cache is only an execution copy of the installed managed package. Once
  // that package is uninstalled, the cache must not silently keep Python
  // submissions runnable while the UI correctly reports "Checker only".
  if (!managed.ready || selected.source !== "managed") return selected;
  // The executor cache is an implementation detail, not a different selected
  // toolchain. Returning it here changes the compile-time path after the first
  // testcase imports Python and makes later runs fail the identity check.
  return managed;
}

export function isWindowsCppExecutionReady(toolchain: ResolvedToolchain): boolean {
  return toolchain.kind === "cpp"
    && isWindowsNativeCompilerExecutionReady(toolchain);
}

export function isWindowsNativeCompilerExecutionReady(
  toolchain: ResolvedToolchain,
): boolean {
  if (toolchain.source === "managed") return true;
  if (
    (toolchain.kind === "cpp" || toolchain.kind === "c")
    && toolchain.ready
    && toolchain.localToolchain
  ) {
    return true;
  }
  return toolchain.kind === "cpp"
    && toolchain.provenance === "certified-local"
    && !!toolchain.certificateId
    && !!toolchain.executionPath
    && !!toolchain.executionId
    && !!toolchain.snapshotDigest
    && !!toolchain.certifiedRoles?.includes("submission")
    && !!toolchain.certifiedRoles.includes("checker");
}

export function buildSubmissionCompilerArgs(
  platform: NodeJS.Platform,
  sourcePath: string,
  outputPath: string,
  language: "cpp" | "c" = "cpp",
  compile?: ProblemCompileConfig,
): string[] {
  return buildNativeCompilationRecipe(
    language,
    platform,
    sourcePath,
    outputPath,
    compile,
  ).args;
}

export async function runCompilerWithLimits(
  compilerPath: string,
  args: string[],
  cwd: string | undefined,
  outputPath: string,
  jobId?: string,
  limits: CompileLimits = DEFAULT_COMPILE_LIMITS,
  kind: ToolchainKind = "cpp",
  adapterEnvironment: Readonly<Record<string, string>> = {},
  pinnedToolchain?: Readonly<ResolvedToolchain>,
): Promise<void> {
  const workspace = await createExecutorWorkspace();
  const runId = `compile_${crypto.randomUUID().replaceAll("-", "_")}`;
  try {
    attachExecutorRun(jobId, runId);
    const compiler = await prepareCompiler(
      workspace,
      compilerPath,
      kind,
      pinnedToolchain,
    );
    if (kind === "go") {
      if (!pinnedToolchain) {
        throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
      }
      // A package-level Go build cache is both expensive to copy and unsafe to
      // share as writable state between contestants. Keep every cache in this
      // compilation's protected workspace instead.
      fs.mkdirSync(path.join(workspace.path, "go-cache"));
      fs.mkdirSync(path.join(workspace.path, "go-mod-cache"));
      fs.mkdirSync(path.join(workspace.path, "go-tmp"));
    }
    if (kind === "pascal") {
      if (!compiler.root) {
        throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
      }
      compiler.argumentPrefix.push(
        ...buildManagedPascalSupportArgs(process.platform, compiler.root),
      );
    }
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
      ...buildCompilerAdapterEnvironment(
        kind,
        workspace.path,
        compiler.root,
        compiler.executablePath,
      ),
      ...adapterEnvironment,
      ...compiler.environment,
    };
    if (
      process.platform === "win32"
      && compiler.root
      && (kind === "cpp" || kind === "c")
    ) {
      const programDirectory = findGccProgramDirectory(compiler.root, kind);
      // A relocated GCC driver otherwise remembers the source installation prefix and reports
      // "cannot execute cc1plus" inside LPAC. -B and COMPILER_PATH keep every compiler child in
      // the verified read-only toolchain cache and the same Job Object.
      stagedArgs.unshift(`-B${programDirectory}${path.sep}`);
      stagedArgs.unshift(
        ...findGccIncludeDirectories(compiler.root, kind === "cpp")
          .flatMap((directory) => ["-isystem", directory]),
      );
      environment.COMPILER_PATH = [programDirectory, path.dirname(compiler.executablePath)].join(path.delimiter);
      environment.LIBRARY_PATH = findGccLibraryDirectories(compiler.root).join(path.delimiter);
    }
    const result = await runReservedExecutor(jobId, buildCompilerExecutorRunSpec({
      runId,
      workspaceId: workspace.id,
      executableId: compiler.executableId,
      args: stagedArgs,
      environment,
      toolchain: compiler.toolchain,
      localToolchain: compiler.localToolchain,
      timeoutMs: limits.timeoutMs,
      memoryBytes: limits.memoryBytes ?? resolveCompilerMemoryLimitBytes(),
      maxGeneratedFileBytes: limits.maxGeneratedFileBytes,
      maxWorkspaceWriteBytes: limits.maxWorkspaceWriteBytes,
      maxCreatedFiles: limits.maxCreatedFiles,
    }));
    const diagnostics = readCompilerDiagnostics(workspace.path);
    assertCompilerSucceeded(result, diagnostics);
    if (!fs.existsSync(stagedOutput)) throw new Error(diagnostics.trim() || "Compilation did not produce an output file.");
    if (fs.statSync(stagedOutput).size > limits.maxGeneratedFileBytes) throw new Error("GENERATED_FILE_TOO_LARGE");
    fs.copyFileSync(stagedOutput, outputPath);
  } finally {
    detachExecutorRun(jobId, runId);
    workspace.dispose();
  }
}

export async function runCompilerPipelineWithLimits(
  compilerPath: string,
  args: string[],
  cwd: string | undefined,
  outputPath: string,
  jobId?: string,
  limits: CompileLimits = DEFAULT_COMPILE_LIMITS,
  kind: Extract<ToolchainKind, "cpp" | "c"> = "cpp",
  adapterEnvironment: Readonly<Record<string, string>> = {},
  pinnedToolchain?: Readonly<ResolvedToolchain>,
): Promise<void> {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    await runCompilerWithLimits(
      compilerPath,
      args,
      cwd,
      outputPath,
      jobId,
      limits,
      kind,
      adapterEnvironment,
      pinnedToolchain,
    );
    return;
  }

  const objectPath = `${outputPath}.${crypto.randomUUID().slice(0, 8)}.o`;
  const phases = buildCompilerPhases(args, outputPath, objectPath);
  const started = process.hrtime.bigint();
  try {
    await runCompilerWithLimits(
      compilerPath,
      phases.compile,
      cwd,
      objectPath,
      jobId,
      limits,
      kind,
      adapterEnvironment,
      pinnedToolchain,
    );
    const elapsed = elapsedMs(started);
    const remaining = Math.max(1, limits.timeoutMs - Math.ceil(elapsed));
    await runCompilerWithLimits(
      compilerPath,
      phases.link,
      cwd,
      outputPath,
      jobId,
      { ...limits, timeoutMs: remaining },
      kind,
      adapterEnvironment,
      pinnedToolchain,
    );
  } finally {
    fs.rmSync(objectPath, { force: true });
  }
}

export function buildCompilerPhases(
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
    if (
      argument === "-s"
      || argument === "-static"
      || argument === "-static-libgcc"
      || argument === "-static-libstdc++"
      || argument === "-lm"
      || argument.startsWith("-Wl,")
    ) {
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
  return platform === "win32"
    ? {
        PATH: path.win32.dirname(compilerPath),
        // GCC's Windows temp-path conversion does not understand the extended
        // AppContainer LocalState prefix. A relative TMPDIR resolves to the
        // already isolated executor workspace and avoids falling back to the
        // drive root.
        TMPDIR: ".",
      }
    : {};
}

async function prepareCompiler(
  workspace: Awaited<ReturnType<typeof createExecutorWorkspace>>,
  compilerPath: string,
  kind: ToolchainKind,
  pinnedToolchain?: Readonly<ResolvedToolchain>,
): Promise<PreparedCompiler> {
  if (pinnedToolchain) {
    if (
      pinnedToolchain.kind !== kind
      || !pinnedToolchain.ready
      || !sameFile(
        pinnedToolchain.executionPath || pinnedToolchain.executablePath,
        compilerPath,
      )
    ) {
      throw new Error("TOOLCHAIN_CHANGED_DURING_JUDGING");
    }
    if (pinnedToolchain.source === "managed") {
      const prepared = pinnedToolchain.packageDigest
        ? await prepareManagedToolchainComponent(
            kind,
            pinnedToolchain,
            pinnedToolchain.packageComponentId,
            "compiler",
          )
        : await prepareManagedToolchainExecutable(kind, pinnedToolchain);
      return decoratePreparedCompilerForPlatform(kind, {
        ...prepared,
        argumentPrefix: [],
        environment: {},
      });
    }
    if (
      pinnedToolchain.localToolchain
      && (kind === "cpp" || kind === "c")
    ) {
      const derived = deriveLocalToolchain(
        kind,
        compilerPath,
        pinnedToolchain.localToolchain.isolation,
      );
      if (
        !sameFile(derived.identity.rootPath, pinnedToolchain.localToolchain.rootPath)
        || derived.identity.executableRelativePath
          !== pinnedToolchain.localToolchain.executableRelativePath
      ) {
        throw new Error("TOOLCHAIN_CHANGED_DURING_JUDGING");
      }
      const darwin = process.platform === "darwin"
        ? resolveDarwinCompilerSupport(derived.executablePath, kind)
        : null;
      return {
        executableId: derived.executableId,
        executablePath: derived.executablePath,
        root: derived.identity.rootPath,
        argumentPrefix: darwin?.argumentPrefix ?? [],
        environment: darwin?.environment ?? {},
        localToolchain: pinnedToolchain.localToolchain,
        compatibilityHeaderPath: darwin && kind === "cpp"
          ? resolveDarwinCompatibilityHeader(RESOURCE_ROOT)
          : undefined,
      };
    }
  }
  const cached = await findCachedManagedToolchain(kind);
  if (cached && sameFile(cached.executablePath, compilerPath)) {
    return decoratePreparedCompilerForPlatform(kind, {
      executableId: cached.executableId,
      executablePath: cached.executablePath,
      root: cached.root,
      argumentPrefix: [],
      environment: {},
      ...(cached.toolchain ? { toolchain: cached.toolchain } : {}),
    });
  }
  const resolved = resolveToolchain(kind);
  if (resolved.ready && resolved.source === "managed" && sameFile(resolved.executablePath, compilerPath)) {
    const prepared = resolved.packageDigest
      ? await prepareManagedToolchainComponent(
          kind,
          resolved,
          resolved.packageComponentId,
          "compiler",
        )
      : await prepareManagedToolchainExecutable(kind, resolved);
    return decoratePreparedCompilerForPlatform(kind, {
      ...prepared,
      argumentPrefix: [],
      environment: {},
    });
  }
  const realCompiler = fs.realpathSync(compilerPath);
  const health = await executorClient.start();
  if (health.ready) {
    const executorRoot = fs.realpathSync(health.executorRoot);
    const executorToolchainsRoot = fs.realpathSync(
      path.join(executorRoot, "toolchains"),
    );
    if (isDescendant(executorToolchainsRoot, realCompiler)) {
      const relative = path.relative(executorToolchainsRoot, realCompiler);
      const packageName = relative.split(path.sep)[0];
      const packageRoot = path.join(executorToolchainsRoot, packageName);
      const payloadRoot = path.join(packageRoot, "payload");
      const compilerRoot = fs.existsSync(payloadRoot)
        && isDescendantOrEqual(payloadRoot, realCompiler)
        ? fs.realpathSync(payloadRoot)
        : packageRoot;
      return decoratePreparedCompilerForPlatform(kind, {
        executableId: path.relative(executorRoot, realCompiler).replaceAll("\\", "/"),
        executablePath: realCompiler,
        root: compilerRoot,
        argumentPrefix: [],
        environment: {},
      });
    }
  }
  const managedRoot = fs.realpathSync(getToolchainsDir());
  if (isDescendant(managedRoot, realCompiler)) {
    return decoratePreparedCompilerForPlatform(kind, {
      ...await importManagedToolchain(
        kind,
        realCompiler,
        getExecutableVersion(realCompiler, kind),
      ),
      argumentPrefix: [],
      environment: {},
    });
  }
  if (!isExecutorTestHarness(realCompiler)) {
    throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
  }
  const name = stagedCompilerName(realCompiler);
  const staged = workspace.stage(realCompiler, name, true);
  return {
    executableId: workspace.relative(name),
    executablePath: staged,
    argumentPrefix: [],
    environment: {},
  };
}

function isExecutorTestHarness(executablePath: string): boolean {
  return path.basename(executablePath).toLowerCase().startsWith(
    "judgedesk-executor-",
  );
}

function decoratePreparedCompilerForPlatform(
  kind: ToolchainKind,
  compiler: PreparedCompiler,
): PreparedCompiler {
  if (
    process.platform !== "darwin"
    || (kind !== "rust" && kind !== "pascal")
  ) {
    return compiler;
  }
  const support = resolveDarwinManagedLinkerSupport();
  return {
    ...compiler,
    argumentPrefix: kind === "rust"
      ? [
          "-C",
          `linker=${support.compilerPath}`,
          "-C",
          "link-arg=-isysroot",
          "-C",
          `link-arg=${support.sdkDirectory}`,
          ...compiler.argumentPrefix,
        ]
      : [
          `-XR${support.sdkDirectory}`,
          `-FD${path.dirname(support.compilerPath)}`,
          ...compiler.argumentPrefix,
        ],
    environment: {
      ...compiler.environment,
      ...support.environment,
      // FPC's Darwin linker script resolves cat/rm through PATH. Seatbelt still
      // permits only the exact managed-FPC utilities declared by the native
      // executor, so adding the immutable system directories does not broaden
      // the process-exec allowlist.
      PATH: kind === "pascal"
        ? [path.dirname(support.compilerPath), "/usr/bin", "/bin"].join(
            path.delimiter,
          )
        : path.dirname(support.compilerPath),
    },
  };
}

function resolveDarwinManagedLinkerSupport(): {
  compilerPath: string;
  sdkDirectory: string;
  environment: Record<string, string>;
} {
  const compilerPath = findSelectedDarwinCompiler("c");
  if (!compilerPath) {
    throw new Error(
      "PLATFORM_LINKER_UNAVAILABLE: install Apple Command Line Tools",
    );
  }
  const sdkDirectory = findDarwinSdkDirectory(compilerPath);
  if (!sdkDirectory) {
    throw new Error(
      "PLATFORM_LINKER_UNAVAILABLE: the selected macOS SDK was not found",
    );
  }
  const support = resolveDarwinCompilerSupport(compilerPath, "c");
  return {
    compilerPath: fs.realpathSync(compilerPath),
    sdkDirectory,
    environment: support.environment,
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

export function resolveDarwinCompilerSupport(
  compilerPath: string,
  kind: Extract<ToolchainKind, "cpp" | "c"> = "cpp",
): {
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
      kind === "cpp" ? "--driver-mode=g++" : "--driver-mode=gcc",
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

function findGccProgramDirectory(
  root: string,
  kind: Extract<ToolchainKind, "cpp" | "c"> = "cpp",
): string {
  const cacheKey = `${kind}:${root}`;
  const cached = gccProgramDirectoryCache.get(cacheKey);
  if (cached) return cached;
  const frontend = kind === "cpp" ? "cc1plus.exe" : "cc1.exe";
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      if (entry.isFile() && entry.name.toLowerCase() === frontend) {
        gccProgramDirectoryCache.set(cacheKey, directory);
        return directory;
      }
    }
  }
  throw new Error(
    `TOOLCHAIN_NOT_SANDBOX_COMPATIBLE: ${frontend} was not found in the managed GCC cache`,
  );
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

export function findGccIncludeDirectories(
  root: string,
  includeCpp = true,
): string[] {
  const cacheKey = `${includeCpp ? "cpp" : "c"}:${root}`;
  const cached = gccIncludeDirectoryCache.get(cacheKey);
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
      } else if (entry.name.toLowerCase() === "windows.h") {
        const relativeHeader = path.relative(root, entryPath).replaceAll("\\", "/").toLowerCase();
        if (
          relativeHeader === "include/windows.h"
          || /^[^/]+-w64-mingw32\/include\/windows\.h$/.test(relativeHeader)
        ) {
          systemIncludes.add(directory);
        }
      }
    }
  }
  if (
    (includeCpp && !cppRoot)
    || gccIncludes.size === 0
    || systemIncludes.size === 0
  ) {
    throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE: managed GCC headers were not found");
  }
  const backward = cppRoot ? path.join(cppRoot, "backward") : "";
  const result = [
    ...(cppRoot && includeCpp ? [cppRoot] : []),
    ...(includeCpp ? [...cppTargets] : []),
    ...(includeCpp && fs.existsSync(backward) ? [backward] : []),
    ...gccIncludes,
    ...fixedIncludes,
    ...systemIncludes,
  ];
  gccIncludeDirectoryCache.set(cacheKey, result);
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
    if (
      argument.startsWith("-o")
      && argument.length > 2
      && samePath(argument.slice(2), outputPath)
    ) {
      return `-o${stagedOutput}`;
    }
    if (!path.isAbsolute(argument) || !fs.existsSync(argument)) return argument;
    const canonical = fs.realpathSync(argument);
    const existing = staged.get(canonical);
    if (existing) return existing;
    const metadata = fs.lstatSync(canonical);
    if (metadata.isSymbolicLink()) throw new Error("Compiler inputs cannot be symlinks.");
    const ext = path.extname(canonical);
    const rawBase = path.basename(canonical, ext);
    const safeBase = safeName(rawBase).slice(0, 64).replace(/[. ]+$/, "") || "input";
    const safeExt = ext ? `.${safeName(ext.slice(1)).replace(/[. ]+$/, "")}` : "";
    const destination = path.join(
      workspacePath,
      "inputs",
      `${index}_${safeBase}${safeExt}`,
    );
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

function readCompilerDiagnostics(workspacePath: string): string {
  const stderr = readPreview(
    path.join(workspacePath, "compiler.stderr"),
    MAX_COMPILER_DIAGNOSTIC_BYTES,
  ).trim();
  const remainingBytes = Math.max(
    0,
    MAX_COMPILER_DIAGNOSTIC_BYTES - Buffer.byteLength(stderr),
  );
  const stdout = remainingBytes > 0
    ? readPreview(
        path.join(workspacePath, "compiler.stdout"),
        remainingBytes,
      ).trim()
    : "";
  return [stderr, stdout].filter(Boolean).join("\n");
}

function compilationFailure(executablePath: string, error: string, started: bigint): CompilationResult {
  return { executablePath, compileStatus: "CE", compileError: error, compileTime: elapsedMs(started) };
}

export function normalizeCompilerError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("GENERATED_FILE_TOO_LARGE")) return "GENERATED_FILE_TOO_LARGE";
  if (message.includes("COMPILER_TIMEOUT")) return "COMPILER_TIMEOUT";
  return message.trim() || "Compilation failed";
}

export function safeName(value: string | undefined | null): string {
  return (
    (value || "")
      .replaceAll(/[^A-Za-z0-9_.-]/g, "_")
      .slice(0, 96)
      .replace(/[. ]+$/, "") || "artifact"
  );
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
