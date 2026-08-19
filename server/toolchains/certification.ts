import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  CertifiedPathIdentity,
  ToolchainCertificate,
} from "../languages/contracts.js";
import {
  CPP_LANGUAGE_PROFILE_ID,
} from "../languages/registry.js";
import { createExecutorWorkspace } from "../executor/workspace.js";
import { executorClient } from "../executor/client.js";
import { runReservedExecutor } from "../jobs.js";
import {
  buildCheckerExecutorRunSpec,
  buildCompilerExecutorRunSpec,
  buildSubmissionExecutorRunSpec,
} from "../judge/execution-request.js";
import {
  buildCustomCheckerCompilerArgs,
  buildSubmissionCompilerArgs,
  getBundledTestlibSource,
  runCompilerWithLimits,
} from "../judge/compiler.js";
import { resolveCompilerMemoryLimitBytes } from "../judge/resource-policy.js";
import {
  createToolchainCertificate,
  saveToolchainCertificate,
} from "./certificate-store.js";
import { toolchainMaintenanceGate } from "./maintenance-gate.js";
import {
  getLocalCppCertificationRecipeDigest,
  LOCAL_CPP_PROBE_SUITE_VERSION,
} from "./cpp-certification-policy.js";
import {
  createLocalToolchainSnapshot,
  estimateDirectoryTree,
  removeLocalToolchainSnapshot,
  type LocalToolchainSnapshot,
} from "./snapshot.js";

const MiB = 1024 * 1024;
const IDENTITY_OUTPUT_LIMIT_BYTES = 256 * 1024;
// GCC 9.2.0 from the legacy Themis bundle is a 32-bit PE and fails the current
// Windows AppContainer launch boundary with ERROR_ILLEGAL_DLL_RELOCATION (623).
// Detection may still show it, but certification must never promote it.
const SUPPORTED_GNU_CPP_VERSIONS = new Set(["14.2.0", "16.1.0"]);
const SUPPORTED_GNU_CPP_TARGETS = new Set(["x86_64-w64-mingw32"]);

export interface GnuCppIdentity {
  family: "gcc";
  version: string;
  build: string;
  distributor?: string;
  target: string;
}

export interface LocalCppCertificationPlan {
  profileId: typeof CPP_LANGUAGE_PROFILE_ID;
  mode: "local-snapshot";
  canonicalExecutablePath: string;
  sourceRoot: string;
  relativeExecutablePath: string;
  fileCount: number;
  totalBytes: number;
  maxSupportedSnapshotBytes: number;
}

export interface LocalCppCertificationResult {
  certificate: ToolchainCertificate;
  snapshot: {
    digest: string;
    fileCount: number;
    totalBytes: number;
    created: boolean;
  };
}

function hashText(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function safeWindowsLocalPath(value: string): void {
  const normalized = value.replaceAll("/", "\\");
  if (normalized.startsWith("\\\\") || normalized.startsWith("\\?\\")) {
    throw new Error("LOCAL_EXECUTABLE_INVALID: network and device paths are not accepted.");
  }
}

async function resolveLocalCppRoot(
  executablePath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<{
  canonicalExecutablePath: string;
  sourceRoot: string;
  relativeExecutablePath: string;
}> {
  if (!path.isAbsolute(executablePath)) {
    throw new Error("LOCAL_EXECUTABLE_INVALID: compiler path must be absolute.");
  }
  if (platform === "win32") safeWindowsLocalPath(executablePath);
  const selectedMetadata = await fs.promises.lstat(executablePath);
  if (!selectedMetadata.isFile() || selectedMetadata.isSymbolicLink()) {
    throw new Error("LOCAL_EXECUTABLE_INVALID: compiler must be a regular non-link file.");
  }
  const canonicalExecutablePath = await fs.promises.realpath(executablePath);
  if (!/^g\+\+(?:\.exe)?$/i.test(path.basename(canonicalExecutablePath))) {
    throw new Error("LOCAL_EXECUTABLE_INVALID: the first certification profile accepts GNU g++ only.");
  }
  const binDirectory = path.dirname(canonicalExecutablePath);
  if (path.basename(binDirectory).toLowerCase() !== "bin") {
    throw new Error("LOCAL_NOT_SANDBOX_COMPATIBLE: expected the compiler under a toolchain bin directory.");
  }
  const sourceRoot = await fs.promises.realpath(path.dirname(binDirectory));
  const relativeExecutablePath = path.relative(sourceRoot, canonicalExecutablePath)
    .replaceAll("\\", "/");
  if (relativeExecutablePath.startsWith("../") || path.isAbsolute(relativeExecutablePath)) {
    throw new Error("LOCAL_NOT_SANDBOX_COMPATIBLE: compiler escaped its toolchain root.");
  }
  return { canonicalExecutablePath, sourceRoot, relativeExecutablePath };
}

export async function planLocalCppCertification(
  executablePath: string,
  options: { platform?: NodeJS.Platform } = {},
): Promise<LocalCppCertificationPlan> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    throw new Error("LOCAL_CERTIFICATION_UNSUPPORTED: local snapshots are initially enabled for Windows GNU C++ only.");
  }
  const root = await resolveLocalCppRoot(executablePath, platform);
  const estimate = await estimateDirectoryTree(root.sourceRoot);
  return {
    profileId: CPP_LANGUAGE_PROFILE_ID,
    mode: "local-snapshot",
    ...root,
    fileCount: estimate.fileCount,
    totalBytes: estimate.totalBytes,
    maxSupportedSnapshotBytes: 8 * 1024 * 1024 * 1024,
  };
}

export function parseGnuCppIdentity(
  versionOutput: string,
  targetOutput: string,
): GnuCppIdentity {
  const build = versionOutput.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
  if (!build || !/(?:g\+\+|gcc)/i.test(build) || /clang/i.test(build)) {
    throw new Error("LOCAL_VERSION_UNSUPPORTED: compiler does not identify as GNU g++.");
  }
  const versions = [...build.matchAll(/\b\d+\.\d+(?:\.\d+){0,2}\b/g)]
    .map((match) => match[0]);
  const version = versions.at(-1);
  if (!version) throw new Error("LOCAL_EXECUTABLE_INVALID: compiler version could not be parsed.");
  const target = targetOutput.trim();
  if (!target || target.length > 256 || /[\0\r\n]/.test(target)) {
    throw new Error("LOCAL_EXECUTABLE_INVALID: compiler target could not be parsed.");
  }
  const builtBy = build.match(/Built by ([^)]+)/i)?.[1]?.trim();
  const distributor = builtBy
    || (build.includes("MinGW.org") ? "MinGW.org" : undefined);
  return {
    family: "gcc",
    version,
    build,
    ...(distributor ? { distributor } : {}),
    target,
  };
}

export function assertSupportedGnuCppIdentity(identity: GnuCppIdentity): void {
  if (!SUPPORTED_GNU_CPP_VERSIONS.has(identity.version)) {
    throw new Error(
      `LOCAL_VERSION_UNSUPPORTED: GNU C++ ${identity.version} is outside JudgeDesk's exact tested versions.`,
    );
  }
  if (!SUPPORTED_GNU_CPP_TARGETS.has(identity.target)) {
    throw new Error(
      `LOCAL_VERSION_UNSUPPORTED: GNU C++ target '${identity.target}' is not certified.`,
    );
  }
}

async function runCompilerIdentityProbe(
  snapshot: LocalToolchainSnapshot,
  args: string[],
): Promise<{ output: string; evidenceDigest: string }> {
  const workspace = await createExecutorWorkspace();
  const runId = `cert_identity_${crypto.randomUUID().replaceAll("-", "_")}`;
  try {
    const result = await runReservedExecutor(undefined, buildCompilerExecutorRunSpec({
      runId,
      workspaceId: workspace.id,
      executableId: snapshot.executableId,
      args,
      environment: { Path: path.dirname(snapshot.executablePath) },
      timeoutMs: 5_000,
      memoryBytes: resolveCompilerMemoryLimitBytes(),
      maxGeneratedFileBytes: MiB,
    }));
    const stdout = readBounded(path.join(workspace.path, "compiler.stdout"));
    const stderr = readBounded(path.join(workspace.path, "compiler.stderr"));
    if (result.reason !== "exited" || result.exitCode !== 0) {
      throw new Error(
        `HEALTH_CHECK_FAILED: compiler identity probe failed (${result.reason}, ${result.exitCode}): ${result.diagnostic || stderr}`,
      );
    }
    const output = stdout || stderr;
    if (!output.trim()) throw new Error("HEALTH_CHECK_FAILED: compiler identity probe returned no output.");
    return {
      output,
      evidenceDigest: hashText(JSON.stringify({ args, result, stdout, stderr })),
    };
  } finally {
    workspace.dispose();
  }
}

function readBounded(filePath: string): string {
  if (!fs.existsSync(filePath)) return "";
  const metadata = fs.statSync(filePath);
  if (metadata.size > IDENTITY_OUTPUT_LIMIT_BYTES) {
    throw new Error("HEALTH_CHECK_FAILED: certification probe output exceeded its limit.");
  }
  return fs.readFileSync(filePath, "utf8");
}

async function runNativeArtifact(
  binaryPath: string,
  role: "submission" | "checker",
  options: { args?: string[]; stage?: Record<string, string> } = {},
): Promise<{ evidenceDigest: string; stdout: string; stderr: string }> {
  const workspace = await createExecutorWorkspace();
  const runId = `cert_${role}_${crypto.randomUUID().replaceAll("-", "_")}`;
  const artifactName = process.platform === "win32" ? "cert_artifact.exe" : "cert_artifact";
  workspace.stage(binaryPath, artifactName, true);
  const executableId = workspace.relative(artifactName);
  try {
    for (const [name, contents] of Object.entries(options.stage || {})) {
      const source = path.join(workspace.path, `.stage-${crypto.randomUUID()}`);
      fs.writeFileSync(source, contents, "utf8");
      const staged = workspace.stage(source, name);
      fs.rmSync(source, { force: true });
      if (!staged.startsWith(workspace.path)) throw new Error("Certification staging escaped its workspace.");
    }
    const args = (options.args || []).map((argument) =>
      argument.startsWith("workspace:")
        ? path.join(workspace.path, argument.slice("workspace:".length))
        : argument
    );
    const spec = role === "submission"
      ? buildSubmissionExecutorRunSpec({
          runId,
          workspaceId: workspace.id,
          executableId,
          args,
          environment: {},
          timeLimitMs: 2_000,
          memoryBytes: 128 * MiB,
        })
      : buildCheckerExecutorRunSpec({
          runId,
          workspaceId: workspace.id,
          executableId,
          args,
          environment: {},
          runtimeBacked: false,
          timeoutMs: 2_000,
          memoryBytes: 128 * MiB,
        });
    const result = await runReservedExecutor(undefined, spec);
    const stdout = readBounded(path.join(workspace.path, spec.stdoutFile));
    const stderr = readBounded(path.join(workspace.path, spec.stderrFile));
    if (result.reason !== "exited" || result.exitCode !== 0) {
      throw new Error(
        `LOCAL_NOT_SANDBOX_COMPATIBLE: ${role} probe failed (${result.reason}, ${result.exitCode}): ${stderr}`,
      );
    }
    return {
      evidenceDigest: hashText(JSON.stringify({ role, result, stdout, stderr })),
      stdout,
      stderr,
    };
  } finally {
    workspace.dispose();
  }
}

async function runCompileAndSandboxProbes(
  snapshot: LocalToolchainSnapshot,
): Promise<Array<{ probeId: string; evidenceDigest: string }>> {
  const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), "judgedesk-cpp-cert-"));
  try {
    const submissionSource = path.join(temporary, "submission.cpp");
    const submissionBinary = path.join(temporary, "submission.exe");
    await fs.promises.writeFile(
      submissionSource,
      '#include <iostream>\nint main(){std::cout << "JUDGEDESK_CERT_CPP_OK"; return 0;}\n',
      "utf8",
    );
    await runCompilerWithLimits(
      snapshot.executablePath,
      buildSubmissionCompilerArgs("win32", submissionSource, submissionBinary),
      temporary,
      submissionBinary,
    );
    const submission = await runNativeArtifact(submissionBinary, "submission");
    if (submission.stdout.trim() !== "JUDGEDESK_CERT_CPP_OK") {
      throw new Error("HEALTH_CHECK_FAILED: compiled submission returned unexpected output.");
    }

    const checkerSupport = path.join(temporary, "checker-support");
    await fs.promises.mkdir(checkerSupport);
    await fs.promises.writeFile(
      path.join(checkerSupport, "testlib.h"),
      getBundledTestlibSource(),
      "utf8",
    );
    const checkerSource = path.join(temporary, "checker.cpp");
    const checkerBinary = path.join(temporary, "checker.exe");
    await fs.promises.writeFile(
      checkerSource,
      [
        '#include "testlib.h"',
        "int main(int argc, char** argv){",
        "  registerTestlibCmd(argc, argv);",
        "  long long actual=ouf.readLong(); long long expected=ans.readLong();",
        "  if(actual!=expected) quitf(_wa, \"mismatch\");",
        "  quitf(_ok, \"JUDGEDESK_CERT_CHECKER_OK\");",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await runCompilerWithLimits(
      snapshot.executablePath,
      buildCustomCheckerCompilerArgs(
        "win32",
        checkerSupport,
        checkerSource,
        checkerBinary,
      ),
      temporary,
      checkerBinary,
      undefined,
      { timeoutMs: 30_000, maxGeneratedFileBytes: 32 * MiB, memoryBytes: 768 * MiB },
    );
    const checker = await runNativeArtifact(checkerBinary, "checker", {
      args: [
        "workspace:input.txt",
        "workspace:contestant-output.txt",
        "workspace:answer.txt",
      ],
      stage: {
        "input.txt": "unused\n",
        "contestant-output.txt": "42\n",
        "answer.txt": "42\n",
      },
    });
    return [
      { probeId: "cpp-submission-compile-run", evidenceDigest: submission.evidenceDigest },
      { probeId: "cpp-checker-compile-run", evidenceDigest: checker.evidenceDigest },
    ];
  } finally {
    await fs.promises.rm(temporary, { recursive: true, force: true });
  }
}

async function fileIdentity(filePath: string): Promise<CertifiedPathIdentity> {
  const canonicalPath = await fs.promises.realpath(filePath);
  const before = await fs.promises.stat(canonicalPath, { bigint: true });
  if (!before.isFile()) throw new Error("LOCAL_EXECUTABLE_INVALID: candidate is not a regular file.");
  const digest = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(canonicalPath, { highWaterMark: MiB })) {
    digest.update(chunk as Buffer);
  }
  const after = await fs.promises.stat(canonicalPath, { bigint: true });
  if (
    before.size !== after.size
    || before.mtimeNs !== after.mtimeNs
    || before.dev !== after.dev
    || before.ino !== after.ino
  ) {
    throw new Error("TOOLCHAIN_DRIFTED: compiler changed while it was fingerprinted.");
  }
  return {
    canonicalPath,
    kind: "file",
    fileIdentity: `${after.dev.toString(16)}:${after.ino.toString(16)}`,
    sizeBytes: Number(after.size),
    modifiedAt: new Date(Number(after.mtimeNs / 1_000_000n)).toISOString(),
    sha256: digest.digest("hex"),
  };
}

export async function certifyLocalCppToolchain(
  executablePath: string,
): Promise<LocalCppCertificationResult> {
  if (process.platform !== "win32") {
    throw new Error("LOCAL_CERTIFICATION_UNSUPPORTED: Windows GNU C++ certification is not available on this host.");
  }
  const lease = toolchainMaintenanceGate.tryAcquire(`certify-${crypto.randomUUID()}`);
  if (!lease) {
    throw new Error("TOOLCHAIN_MUTATION_BLOCKED: judging or another toolchain operation is active.");
  }
  let snapshot: LocalToolchainSnapshot | undefined;
  let certificateSaved = false;
  try {
    const root = await resolveLocalCppRoot(executablePath, "win32");
    snapshot = await createLocalToolchainSnapshot({
      kind: "cpp",
      sourceRoot: root.sourceRoot,
      executablePath: root.canonicalExecutablePath,
    });
    const health = await executorClient.start();
    if (
      !health.ready
      || health.mode !== "windows-lpac-job"
      || !health.networkBlocked
      || !health.filesystemIsolated
      || !health.processTreeControlled
    ) {
      throw new Error(
        `LOCAL_NOT_SANDBOX_COMPATIBLE: ${health.diagnostics.join("; ") || "secure runner proof is incomplete"}`,
      );
    }
    const versionProbe = await runCompilerIdentityProbe(snapshot, ["--version"]);
    const targetProbe = await runCompilerIdentityProbe(snapshot, ["-dumpmachine"]);
    const identity = parseGnuCppIdentity(versionProbe.output, targetProbe.output);
    assertSupportedGnuCppIdentity(identity);
    const originalExecutable = await fileIdentity(root.canonicalExecutablePath);
    const snapshotExecutable = await fileIdentity(snapshot.executablePath);
    if (originalExecutable.sha256 !== snapshotExecutable.sha256) {
      throw new Error("TOOLCHAIN_DRIFTED: local compiler changed after its snapshot was created.");
    }
    const recipe = getLocalCppCertificationRecipeDigest();
    const candidateFingerprint = hashText(JSON.stringify({
      executable: originalExecutable,
      identity,
      profile: { id: CPP_LANGUAGE_PROFILE_ID, version: 1 },
      recipe,
      snapshotDigest: snapshot.treeDigest,
    }));
    const compileProbes = await runCompileAndSandboxProbes(snapshot);
    const completedAt = new Date().toISOString();
    const certificate = createToolchainCertificate({
      profile: { id: CPP_LANGUAGE_PROFILE_ID, version: 1 },
      certifiedRoles: ["submission", "checker"],
      candidateFingerprint,
      host: {
        platform: "win32",
        architecture: os.arch() === "arm64" ? "arm64" : "x64",
        osVersion: os.release(),
        osBuild: os.version(),
      },
      toolchain: {
        executable: originalExecutable,
        ...identity,
      },
      helperExecutables: [],
      supportRoots: [{
        canonicalPath: root.sourceRoot,
        kind: "directory",
        sizeBytes: snapshot.totalBytes,
        treeDigest: snapshot.treeDigest,
      }],
      dependencyClosureDigest: snapshot.treeDigest,
      recipeDigest: recipe,
      deployment: {
        kind: "local-snapshot",
        snapshotDigest: snapshot.treeDigest,
      },
      executorVersion: health.executorVersion,
      sandboxPolicyVersion: `${health.mode}.v1`,
      probeSuiteVersion: LOCAL_CPP_PROBE_SUITE_VERSION,
      probes: [
        {
          probeId: "snapshot-integrity",
          result: "passed",
          evidenceDigest: snapshot.treeDigest,
          completedAt,
        },
        {
          probeId: "compiler-identity",
          result: "passed",
          evidenceDigest: hashText(
            `${versionProbe.evidenceDigest}:${targetProbe.evidenceDigest}`,
          ),
          completedAt,
        },
        {
          probeId: "executor-security-boundary",
          result: "passed",
          evidenceDigest: hashText(JSON.stringify({
            mode: health.mode,
            executorVersion: health.executorVersion,
            networkBlocked: health.networkBlocked,
            filesystemIsolated: health.filesystemIsolated,
            processTreeControlled: health.processTreeControlled,
          })),
          completedAt,
        },
        ...compileProbes.map((probe) => ({
          ...probe,
          result: "passed" as const,
          completedAt,
        })),
      ],
      issuedAt: completedAt,
    });
    saveToolchainCertificate(certificate);
    certificateSaved = true;
    return {
      certificate,
      snapshot: {
        digest: snapshot.treeDigest,
        fileCount: snapshot.fileCount,
        totalBytes: snapshot.totalBytes,
        created: snapshot.created === true,
      },
    };
  } finally {
    if (snapshot?.created && !certificateSaved) {
      await removeLocalToolchainSnapshot({
        kind: "cpp",
        snapshotDigest: snapshot.treeDigest,
      }).catch(() => undefined);
    }
    lease.finish();
  }
}
