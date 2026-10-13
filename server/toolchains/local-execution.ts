import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ExecutorLocalIsolation,
  ExecutorLocalToolchainIdentity,
  ExecutorRunResult,
} from "../executor/protocol.js";
import { createExecutorWorkspace, type ExecutorWorkspace } from "../executor/workspace.js";
import {
  buildCheckerExecutorRunSpec,
  buildCompilerExecutorRunSpec,
  buildSubmissionExecutorRunSpec,
} from "../judge/execution-request.js";
import type { ResolvedToolchain, ToolchainKind } from "./types.js";
import {
  localProbeFailureSnapshot,
  localProbeRegistry,
  LocalProbeCleanupUnconfirmedError,
  type LocalCompatibilityProbeSnapshot,
} from "./local-probe-registry.js";
import { runLocalProbePhase } from "./local-probe-run.js";
export type {
  LocalCompatibilityProbeStatus,
  LocalCompatibilityProbeSnapshot,
} from "./local-probe-registry.js";

const LOCAL_ROOT_MAX_BYTES = 4_096;
const LOCAL_EXECUTABLE_RELATIVE_MAX_BYTES = 1_024;
const LOCAL_PROBE_MEMORY_BYTES = 512 * 1024 * 1024;
const LOCAL_COMPILER_PROBE_TIMEOUT_MS = 12_000;
const LOCAL_PYTHON_PROBE_TIMEOUT_MS = 5_000;
const LOCAL_PROGRAM_PROBE_TIMEOUT_MS = 5_000;

export type LocallyExecutableKind = Extract<ToolchainKind, "cpp" | "c" | "python">;

export interface DerivedLocalToolchain {
  executablePath: string;
  executableId: string;
  identity: ExecutorLocalToolchainIdentity;
  fingerprint: string;
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
  signal?: AbortSignal,
) => Promise<void>;

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
): CachedLocalExecutionResolution {
  let strict: DerivedLocalToolchain;
  try {
    strict = deriveLocalToolchain(kind, executablePath, "strict");
  } catch (error) {
    const probe = localProbeFailureSnapshot(error);
    return {
      ready: false,
      probe,
      diagnostic: probe.diagnostic,
    };
  }
  const cached = localProbeRegistry.get(kind, strict);
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
  const diagnostic = cached?.status === "incompatible"
    ? cached.diagnostic || "The strict native-executor compatibility probe failed."
    : "The strict native-executor compatibility probe has not completed.";
  return { ready: false, derived: strict, probe, diagnostic };
}

/**
 * Starts at most one bounded native-executor probe for this executable image.
 * Snapshot failure is fulfilled; uncertain cleanup rejects and remains owned
 * by the registry until shutdown/recovery can prove drain.
 */
export function scheduleLocalCompatibilityProbe(
  kind: LocallyExecutableKind,
  executablePath: string,
  runner: LocalCompatibilityProbeRunner = runNativeLocalCompatibilityProbe,
  signal?: AbortSignal,
): Promise<LocalCompatibilityProbeSnapshot> {
  if (signal?.aborted) {
    return Promise.resolve(localProbeFailureSnapshot(new Error("Compatibility probe aborted")));
  }
  let derived: DerivedLocalToolchain;
  try {
    derived = deriveLocalToolchain(kind, executablePath, "strict");
  } catch (error) {
    return Promise.resolve(localProbeFailureSnapshot(error));
  }
  return localProbeRegistry.schedule(kind, derived, runner, signal);
}

export function clearLocalCompatibilityProbeCache(): void {
  localProbeRegistry.clear();
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
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw new Error("Compatibility probe aborted");
  }
  if (kind === "python") {
    await probeLocalPython(derived, signal);
    return;
  }
  await probeLocalCompiler(kind, derived, signal);
}

async function probeLocalCompiler(
  kind: Extract<LocallyExecutableKind, "cpp" | "c">,
  derived: DerivedLocalToolchain,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw new Error("Compatibility probe aborted");
  }
  await runInLocalProbeWorkspace(signal, async (workspace) => {
    const runId = `local_compiler_probe_${crypto.randomUUID().replaceAll("-", "_")}`;
    const sourceName = kind === "cpp" ? "probe.cpp" : "probe.c";
    const sourcePath = path.join(workspace.path, sourceName);
    const outputName = process.platform === "win32" ? "probe.exe" : "probe.out";
    const outputPath = path.join(
      workspace.path,
      outputName,
    );
    const source = kind === "cpp"
      ? '#include <iostream>\nint main() { int value; if (!(std::cin >> value)) return 2; std::cout << value + 1 << "\\n"; return std::cout ? 0 : 3; }\n'
      : '#include <stdio.h>\nint main(void) { int value; if (scanf("%d", &value) != 1) return 2; return printf("%d\\n", value + 1) < 0 ? 3 : 0; }\n';
    fs.writeFileSync(sourcePath, source, {
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
    const result = await runLocalProbePhase(buildCompilerExecutorRunSpec({
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
    }), signal);
    assertSuccessfulProbe(result, "local compiler");
    const output = fs.lstatSync(outputPath, { throwIfNoEntry: false });
    if (!output?.isFile() || output.size === 0 || output.size > 8 * 1024 * 1024) {
      throw new Error("local compiler probe did not produce a bounded nonempty regular executable");
    }
    fs.writeFileSync(path.join(workspace.path, "probe.input"), "41\n", { flag: "wx" });
    const executableId = workspace.relative(outputName);
    const submission = await runLocalProbePhase(buildSubmissionExecutorRunSpec({
      runId: `${runId}_submission`,
      workspaceId: workspace.id,
      executableId,
      args: [],
      stdinFile: "probe.input",
      environment: {},
      timeLimitMs: LOCAL_PROGRAM_PROBE_TIMEOUT_MS,
      memoryBytes: 256 * 1024 * 1024,
    }), signal);
    assertSuccessfulProbe(submission, "local compiler submission runtime");
    const checker = await runLocalProbePhase(buildCheckerExecutorRunSpec({
      runId: `${runId}_checker`,
      workspaceId: workspace.id,
      executableId,
      args: [],
      stdinFile: "probe.input",
      environment: {},
      runtimeBacked: false,
      timeoutMs: LOCAL_PROGRAM_PROBE_TIMEOUT_MS,
      memoryBytes: 256 * 1024 * 1024,
      stdoutFile: "checker-probe.stdout",
      stderrFile: "checker-probe.stderr",
    }), signal);
    assertSuccessfulProbe(checker, "local compiler checker runtime");
  });
}

async function probeLocalPython(
  derived: DerivedLocalToolchain,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw new Error("Compatibility probe aborted");
  }
  await runInLocalProbeWorkspace(signal, async (workspace) => {
    const environment = buildLocalPythonEnvironment(derived);
    const probeProgram = [
      "import encodings,sys",
      "assert sys.flags.isolated == 1",
      "assert sys.dont_write_bytecode",
    ].join(";");
    const submissionRunId =
      `local_python_probe_${crypto.randomUUID().replaceAll("-", "_")}`;
    const checkerRunId =
      `local_python_checker_probe_${crypto.randomUUID().replaceAll("-", "_")}`;
    const submission = await runLocalProbePhase(buildSubmissionExecutorRunSpec({
      runId: submissionRunId,
      workspaceId: workspace.id,
      executableId: derived.executableId,
      args: ["-I", "-B", "-c", probeProgram],
      environment,
      localToolchain: derived.identity,
      timeLimitMs: LOCAL_PYTHON_PROBE_TIMEOUT_MS,
      memoryBytes: 256 * 1024 * 1024,
    }), signal);
    assertSuccessfulProbe(submission, "local Python submission runtime");

    const checker = await runLocalProbePhase(buildCheckerExecutorRunSpec({
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
    }), signal);
    assertSuccessfulProbe(checker, "local Python checker runtime");
  });
}

async function runInLocalProbeWorkspace(
  signal: AbortSignal | undefined,
  work: (workspace: ExecutorWorkspace) => Promise<void>,
): Promise<void> {
  const workspace = await createExecutorWorkspace();
  let retained = false;
  try {
    if (signal?.aborted) throw new Error("Compatibility probe aborted");
    await work(workspace);
  } catch (error: unknown) {
    retained = error instanceof LocalProbeCleanupUnconfirmedError;
    throw error;
  } finally {
    if (!retained) {
      try {
        workspace.dispose();
      } catch (error: unknown) {
        const diagnostic = localProbeFailureSnapshot(error).diagnostic;
        throw new LocalProbeCleanupUnconfirmedError(`workspace ${workspace.id}: ${diagnostic}`);
      }
    }
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
