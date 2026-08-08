import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ExecutorLocalIsolation,
  ExecutorLocalToolchainIdentity,
  ExecutorRunResult,
} from "../executor/protocol.js";
import { createExecutorWorkspace } from "../executor/workspace.js";
import { runReservedExecutor } from "../jobs.js";
import {
  buildCheckerExecutorRunSpec,
  buildCompilerExecutorRunSpec,
  buildSubmissionExecutorRunSpec,
} from "../judge/execution-request.js";
import { loadLocalExecutionPolicy } from "./execution-policy.js";
import type { ResolvedToolchain, ToolchainKind } from "./types.js";

const LOCAL_ROOT_MAX_BYTES = 4_096;
const LOCAL_EXECUTABLE_RELATIVE_MAX_BYTES = 1_024;
const LOCAL_PROBE_MEMORY_BYTES = 512 * 1024 * 1024;
const LOCAL_COMPILER_PROBE_TIMEOUT_MS = 12_000;
const LOCAL_PYTHON_PROBE_TIMEOUT_MS = 5_000;

type LocallyExecutableKind = Extract<ToolchainKind, "cpp" | "c" | "python">;

export interface DerivedLocalToolchain {
  executablePath: string;
  executableId: string;
  identity: ExecutorLocalToolchainIdentity;
  fingerprint: string;
}

export type LocalCompatibilityProbeStatus =
  | "not_started"
  | "checking"
  | "compatible"
  | "incompatible";

export interface LocalCompatibilityProbeSnapshot {
  status: LocalCompatibilityProbeStatus;
  checkedAt?: string;
  diagnostic?: string;
}

export interface CachedLocalExecutionResolution {
  ready: boolean;
  derived?: DerivedLocalToolchain;
  probe: LocalCompatibilityProbeSnapshot;
  diagnostic?: string;
}

export type LocalCompatibilityProbeRunner = (
  kind: LocallyExecutableKind,
  derived: DerivedLocalToolchain,
) => Promise<void>;

interface CachedProbeEntry extends LocalCompatibilityProbeSnapshot {
  promise?: Promise<LocalCompatibilityProbeSnapshot>;
}

const probeCache = new Map<string, CachedProbeEntry>();

/**
 * Derive the exact root/executable pair sent to the native executor. The root is
 * canonical and bounded; the executable is always represented as a normalized
 * descendant path. The native executor repeats all of these checks at launch.
 */
export function deriveLocalToolchain(
  kind: LocallyExecutableKind,
  executablePath: string,
  isolation: ExecutorLocalIsolation = "strict",
): DerivedLocalToolchain {
  if (!isAcceptedLocalAbsolutePath(executablePath, os.platform())) {
    throw new Error("LOCAL_EXECUTABLE_INVALID: expected an absolute local path");
  }

  const lexicalMetadata = fs.lstatSync(executablePath);
  if (!lexicalMetadata.isFile() && !lexicalMetadata.isSymbolicLink()) {
    throw new Error("LOCAL_EXECUTABLE_INVALID: executable is not a regular file");
  }
  const canonicalExecutable = fs.realpathSync(executablePath);
  if (!fs.statSync(canonicalExecutable).isFile()) {
    throw new Error("LOCAL_EXECUTABLE_INVALID: executable is not a regular file");
  }

  const inferredRoot = inferLocalToolchainRoot(
    kind,
    canonicalExecutable,
    os.platform(),
  );
  if (!isAcceptedLocalAbsolutePath(inferredRoot, os.platform())) {
    throw new Error("LOCAL_EXECUTABLE_INVALID: toolchain root is not local");
  }
  const canonicalRoot = fs.realpathSync(inferredRoot);
  if (!fs.statSync(canonicalRoot).isDirectory()) {
    throw new Error("LOCAL_EXECUTABLE_INVALID: toolchain root is not a directory");
  }
  if (path.parse(canonicalRoot).root === canonicalRoot) {
    throw new Error("LOCAL_EXECUTABLE_INVALID: toolchain root is not bounded");
  }

  const relative = path.relative(canonicalRoot, canonicalExecutable);
  if (!isSafeExecutableRelativePath(relative)) {
    throw new Error("LOCAL_EXECUTABLE_INVALID: executable escapes its toolchain root");
  }
  const protocolRelative = relative.replaceAll("\\", "/");
  if (
    Buffer.byteLength(canonicalRoot, "utf8") > LOCAL_ROOT_MAX_BYTES
    || Buffer.byteLength(protocolRelative, "utf8")
      > LOCAL_EXECUTABLE_RELATIVE_MAX_BYTES
  ) {
    throw new Error("LOCAL_EXECUTABLE_INVALID: toolchain path exceeds protocol limits");
  }

  const stat = fs.statSync(canonicalExecutable);
  const fingerprint = crypto
    .createHash("sha256")
    .update(kind)
    .update("\0")
    .update(canonicalRoot)
    .update("\0")
    .update(protocolRelative)
    .update("\0")
    .update(String(stat.dev))
    .update("\0")
    .update(String(stat.ino))
    .update("\0")
    .update(String(stat.size))
    .update("\0")
    .update(String(stat.mtimeMs))
    .digest("hex");
  return {
    executablePath: canonicalExecutable,
    executableId: `local-toolchain/${protocolRelative}`,
    identity: {
      rootPath: canonicalRoot,
      executableRelativePath: protocolRelative,
      isolation,
    },
    fingerprint,
  };
}

/**
 * Cache-only admission check. It never launches a process. Callers that own a
 * background lifecycle (discovery/startup) should call
 * scheduleLocalCompatibilityProbe separately.
 */
export function resolveCachedLocalExecution(
  kind: LocallyExecutableKind,
  executablePath: string,
  allowResourceOnlyLocalExecution = loadLocalExecutionPolicy()
    .allowResourceOnlyLocalExecution,
): CachedLocalExecutionResolution {
  let strict: DerivedLocalToolchain;
  try {
    strict = deriveLocalToolchain(kind, executablePath, "strict");
  } catch (error) {
    return {
      ready: false,
      probe: { status: "incompatible", diagnostic: normalizeError(error) },
      diagnostic: normalizeError(error),
    };
  }
  const cached = probeCache.get(strict.fingerprint);
  const probe: LocalCompatibilityProbeSnapshot = cached
    ? {
        status: cached.status,
        ...(cached.checkedAt ? { checkedAt: cached.checkedAt } : {}),
        ...(cached.diagnostic ? { diagnostic: cached.diagnostic } : {}),
      }
    : { status: "not_started" };

  if (cached?.status === "compatible") {
    return { ready: true, derived: strict, probe };
  }
  if (allowResourceOnlyLocalExecution) {
    return {
      ready: true,
      derived: {
        ...strict,
        identity: { ...strict.identity, isolation: "resource-only" },
      },
      probe,
    };
  }
  const diagnostic = cached?.status === "incompatible"
    ? cached.diagnostic || "The strict native-executor compatibility probe failed."
    : "The strict native-executor compatibility probe has not completed.";
  return { ready: false, derived: strict, probe, diagnostic };
}

/**
 * Starts at most one bounded native-executor probe for this executable image.
 * The returned promise is safe to ignore from a background discovery task.
 */
export function scheduleLocalCompatibilityProbe(
  kind: LocallyExecutableKind,
  executablePath: string,
  runner: LocalCompatibilityProbeRunner = runNativeLocalCompatibilityProbe,
): Promise<LocalCompatibilityProbeSnapshot> {
  let derived: DerivedLocalToolchain;
  try {
    derived = deriveLocalToolchain(kind, executablePath, "strict");
  } catch (error) {
    return Promise.resolve({
      status: "incompatible",
      checkedAt: new Date().toISOString(),
      diagnostic: normalizeError(error),
    });
  }
  const cached = probeCache.get(derived.fingerprint);
  if (cached?.promise) return cached.promise;
  if (cached?.status === "compatible" || cached?.status === "incompatible") {
    return Promise.resolve({
      status: cached.status,
      ...(cached.checkedAt ? { checkedAt: cached.checkedAt } : {}),
      ...(cached.diagnostic ? { diagnostic: cached.diagnostic } : {}),
    });
  }

  const promise = Promise.resolve()
    .then(() => runner(kind, derived))
    .then<LocalCompatibilityProbeSnapshot>(() => ({
      status: "compatible",
      checkedAt: new Date().toISOString(),
    }))
    .catch((error): LocalCompatibilityProbeSnapshot => ({
      status: "incompatible",
      checkedAt: new Date().toISOString(),
      diagnostic: boundedDiagnostic(normalizeError(error)),
    }))
    .then((result) => {
      probeCache.set(derived.fingerprint, result);
      return result;
    });
  probeCache.set(derived.fingerprint, { status: "checking", promise });
  return promise;
}

export function clearLocalCompatibilityProbeCache(): void {
  probeCache.clear();
}

export function localExecutionFields(
  resolution: CachedLocalExecutionResolution,
): Pick<
  ResolvedToolchain,
  "ready" | "localToolchain" | "localProbe" | "diagnostic" | "diagnosticCode"
> {
  if (resolution.ready && resolution.derived) {
    return {
      ready: true,
      localToolchain: resolution.derived.identity,
      localProbe: resolution.probe,
    };
  }
  return {
    ready: false,
    localProbe: resolution.probe,
    diagnostic: resolution.diagnostic
      || "The local toolchain is not compatible with the native executor.",
    diagnosticCode:
      resolution.probe.status === "not_started"
      || resolution.probe.status === "checking"
        ? "DETECTION_IN_PROGRESS"
        : "LOCAL_NOT_SANDBOX_COMPATIBLE",
  };
}

export function isAcceptedLocalAbsolutePath(
  value: string,
  platform: NodeJS.Platform,
): boolean {
  if (!value || Buffer.byteLength(value, "utf8") > LOCAL_ROOT_MAX_BYTES) {
    return false;
  }
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(value)) return false;
  if (platform === "win32") {
    const normalized = value.replaceAll("/", "\\").toLowerCase();
    return !normalized.startsWith("\\\\")
      && !normalized.startsWith("\\?\\")
      && !normalized.startsWith("\\.\\");
  }
  // These prefixes are the conventional automount points for network homes on
  // macOS. /Volumes is intentionally allowed for offline/portable toolchains.
  return !value.startsWith("/Network/") && !value.startsWith("/net/");
}

export function inferLocalToolchainRoot(
  kind: LocallyExecutableKind,
  canonicalExecutable: string,
  platform: NodeJS.Platform,
): string {
  if (kind === "cpp" || kind === "c") {
    if (platform === "win32") {
      const bin = path.win32.dirname(canonicalExecutable);
      if (path.win32.basename(bin).toLowerCase() !== "bin") {
        throw new Error(
          "LOCAL_EXECUTABLE_INVALID: GCC executable must be inside its bin directory",
        );
      }
      // gcc.exe and g++.exe therefore resolve to the same immutable grant root.
      return path.win32.dirname(bin);
    }
    if (platform === "darwin") {
      const normalized = canonicalExecutable.replaceAll("\\", "/");
      const commandLineTools = "/Library/Developer/CommandLineTools";
      if (
        normalized === commandLineTools
        || normalized.startsWith(`${commandLineTools}/`)
      ) {
        return commandLineTools;
      }
      const marker = "/Contents/Developer/";
      const markerIndex = normalized.indexOf(marker);
      if (markerIndex >= 0) {
        return normalized.slice(0, markerIndex + marker.length - 1);
      }
      throw new Error(
        "LOCAL_EXECUTABLE_INVALID: use Apple Clang from Xcode or Command Line Tools",
      );
    }
    throw new Error("LOCAL_EXECUTABLE_INVALID: unsupported compiler host");
  }

  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const executableDirectory = pathApi.dirname(canonicalExecutable);
  const directoryName = pathApi.basename(executableDirectory).toLowerCase();
  return directoryName === "bin" || directoryName === "scripts"
    ? pathApi.dirname(executableDirectory)
    : executableDirectory;
}

function isSafeExecutableRelativePath(value: string): boolean {
  if (!value || path.isAbsolute(value)) return false;
  return value
    .split(/[\\/]/)
    .every((component) => !!component && component !== "." && component !== "..");
}

async function runNativeLocalCompatibilityProbe(
  kind: LocallyExecutableKind,
  derived: DerivedLocalToolchain,
): Promise<void> {
  if (kind === "python") {
    await probeLocalPython(derived);
    return;
  }
  await probeLocalCompiler(kind, derived);
}

async function probeLocalCompiler(
  kind: Extract<LocallyExecutableKind, "cpp" | "c">,
  derived: DerivedLocalToolchain,
): Promise<void> {
  const workspace = await createExecutorWorkspace();
  const runId = `local_compiler_probe_${crypto.randomUUID().replaceAll("-", "_")}`;
  try {
    const sourceName = kind === "cpp" ? "probe.cpp" : "probe.c";
    const sourcePath = path.join(workspace.path, sourceName);
    const outputPath = path.join(
      workspace.path,
      process.platform === "win32" ? "probe.exe" : "probe.out",
    );
    fs.writeFileSync(sourcePath, "int main(void) { return 0; }\n", {
      encoding: "utf8",
      flag: "wx",
    });
    const support = process.platform === "darwin"
      ? resolveDarwinProbeSupport(derived.executablePath, kind)
      : { argumentPrefix: [] as string[], environment: {} as Record<string, string> };
    const args = [
      ...support.argumentPrefix,
      kind === "cpp" ? "-std=c++14" : "-std=c11",
      "-O0",
      "-pipe",
      "-x",
      kind === "cpp" ? "c++" : "c",
      sourcePath,
      "-o",
      outputPath,
    ];
    if (process.platform === "win32") {
      args.splice(support.argumentPrefix.length + 3, 0, "-static");
    }
    const result = await runReservedExecutor(undefined, buildCompilerExecutorRunSpec({
      runId,
      workspaceId: workspace.id,
      executableId: derived.executableId,
      args,
      environment: {
        ...buildLocalCompilerEnvironment(derived.executablePath),
        ...support.environment,
      },
      localToolchain: derived.identity,
      timeoutMs: LOCAL_COMPILER_PROBE_TIMEOUT_MS,
      memoryBytes: LOCAL_PROBE_MEMORY_BYTES,
      maxGeneratedFileBytes: 8 * 1024 * 1024,
      maxWorkspaceWriteBytes: 16 * 1024 * 1024,
      maxCreatedFiles: 64,
    }));
    assertSuccessfulProbe(result, "local compiler");
    if (!fs.statSync(outputPath, { throwIfNoEntry: false })?.isFile()) {
      throw new Error("local compiler probe did not produce an executable");
    }
  } finally {
    workspace.dispose();
  }
}

async function probeLocalPython(derived: DerivedLocalToolchain): Promise<void> {
  const workspace = await createExecutorWorkspace();
  const environment = buildLocalPythonEnvironment(derived);
  const probeProgram = [
    "import encodings,sys",
    "assert sys.flags.isolated == 1",
    "assert sys.dont_write_bytecode",
  ].join(";");
  try {
    const submissionRunId =
      `local_python_probe_${crypto.randomUUID().replaceAll("-", "_")}`;
    const submission = await runReservedExecutor(
      undefined,
      buildSubmissionExecutorRunSpec({
        runId: submissionRunId,
        workspaceId: workspace.id,
        executableId: derived.executableId,
        args: ["-I", "-B", "-c", probeProgram],
        environment,
        localToolchain: derived.identity,
        timeLimitMs: LOCAL_PYTHON_PROBE_TIMEOUT_MS,
        memoryBytes: 256 * 1024 * 1024,
      }),
    );
    assertSuccessfulProbe(submission, "local Python submission runtime");

    const checkerRunId =
      `local_python_checker_probe_${crypto.randomUUID().replaceAll("-", "_")}`;
    const checker = await runReservedExecutor(
      undefined,
      buildCheckerExecutorRunSpec({
        runId: checkerRunId,
        workspaceId: workspace.id,
        executableId: derived.executableId,
        args: ["-I", "-B", "-c", probeProgram],
        environment,
        localToolchain: derived.identity,
        runtimeBacked: true,
        timeoutMs: LOCAL_PYTHON_PROBE_TIMEOUT_MS,
        memoryBytes: 256 * 1024 * 1024,
        stdoutFile: "checker-probe.stdout",
        stderrFile: "checker-probe.stderr",
      }),
    );
    assertSuccessfulProbe(checker, "local Python checker runtime");
  } finally {
    workspace.dispose();
  }
}

export function buildLocalPythonEnvironment(
  derived: Pick<DerivedLocalToolchain, "executablePath" | "identity">,
): Record<string, string> {
  return {
    JUDGEDESK_PYTHON_ISOLATED: "1",
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONHOME: derived.identity.rootPath,
    PATH: path.dirname(derived.executablePath),
  };
}

function buildLocalCompilerEnvironment(
  compilerPath: string,
): Record<string, string> {
  return process.platform === "win32"
    ? { PATH: path.dirname(compilerPath), TMPDIR: "." }
    : {};
}

function resolveDarwinProbeSupport(
  compilerPath: string,
  kind: Extract<LocallyExecutableKind, "cpp" | "c">,
): { argumentPrefix: string[]; environment: Record<string, string> } {
  const compiler = fs.realpathSync(compilerPath);
  const developerRoot = inferLocalToolchainRoot(kind, compiler, "darwin");
  const commandLineTools = "/Library/Developer/CommandLineTools";
  const toolchainRoot = findAncestor(compiler, (candidate) =>
    path.basename(candidate).endsWith(".xctoolchain")
  ) ?? (isDescendantOrEqual(commandLineTools, compiler)
    ? fs.realpathSync(commandLineTools)
    : null);
  if (!toolchainRoot) {
    throw new Error("Apple Clang toolchain root was not found");
  }
  const resourceBase = path.join(toolchainRoot, "usr", "lib", "clang");
  const resourceDirectory = fs.readdirSync(resourceBase, { withFileTypes: true })
    .filter((entry) =>
      entry.isDirectory()
      && fs.existsSync(path.join(resourceBase, entry.name, "include"))
    )
    .map((entry) => path.join(resourceBase, entry.name))
    .sort((left, right) =>
      left.localeCompare(right, undefined, { numeric: true })
    )
    .at(-1);
  const sdkDirectory = [
    path.join(
      developerRoot,
      "Platforms",
      "MacOSX.platform",
      "Developer",
      "SDKs",
      "MacOSX.sdk",
    ),
    path.join(developerRoot, "SDKs", "MacOSX.sdk"),
  ].find((candidate) => fs.existsSync(candidate));
  if (!resourceDirectory || !sdkDirectory) {
    throw new Error("Apple Clang resource directory or macOS SDK was not found");
  }
  return {
    argumentPrefix: [
      kind === "cpp" ? "--driver-mode=g++" : "--driver-mode=gcc",
      "-fintegrated-cc1",
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

function findAncestor(
  candidate: string,
  matches: (value: string) => boolean,
): string | null {
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
  return relative === ""
    || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertSuccessfulProbe(result: ExecutorRunResult, label: string): void {
  if (result.reason !== "exited" || result.exitCode !== 0) {
    throw new Error(
      [
        `${label} probe failed`,
        result.reason,
        result.diagnostic,
        result.signalOrStatus,
      ].filter(Boolean).join(": "),
    );
  }
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedDiagnostic(value: string): string {
  return value.length <= 320 ? value : `${value.slice(0, 317)}...`;
}
