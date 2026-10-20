import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  createExecutorWorkspace,
  importExecutorArtifact,
} from "../executor/workspace.js";
import {
  activeJobs,
  attachExecutorRun,
  detachExecutorRun,
  JudgeJobCancelledError,
  runReservedExecutor,
} from "../jobs.js";
import type { ResolvedToolchain } from "../toolchains/types.js";
import { compileSubmission } from "./compiler.js";
import { buildSubmissionExecutorRunSpec } from "./execution-request.js";

const MiB = 1024 * 1024;
const sessionProbePromises = new Map<string, Promise<void>>();

async function runCertifiedLocalCppSessionProbe(
  toolchain: Readonly<ResolvedToolchain>,
  tempDirectory: string,
  jobId?: string,
): Promise<void> {
  if (jobId !== undefined && (!activeJobs.get(jobId) || activeJobs.get(jobId)?.cancel === true)) {
    throw new JudgeJobCancelledError();
  }
  const token = crypto.randomUUID().replaceAll("-", "_");
  const sourcePath = path.join(tempDirectory, `.judgedesk_cpp_session_probe_${token}.cpp`);
  const contestantName = `session_probe_${token}`;
  const problemName = "certified_local_cpp";
  fs.writeFileSync(
    sourcePath,
    '#include <cstdio>\nint main(){std::puts("JUDGEDESK_SESSION_PROBE_OK");}\n',
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  let binaryPath: string | undefined;
  try {
    const compilation = await compileSubmission({
      language: "cpp",
      contestantName,
      problemName,
      submissionPath: sourcePath,
      tempDirectory,
      jobId,
      cppToolchain: toolchain as ResolvedToolchain,
    });
    if (compilation.compileStatus !== "OK") {
      if (
        (jobId !== undefined && (!activeJobs.get(jobId) || activeJobs.get(jobId)?.cancel === true))
        || compilation.compileError === "COMPILATION_CANCELLED"
        || compilation.compileError.includes("JUDGE_CANCELLED")
      ) {
        throw new JudgeJobCancelledError();
      }
      throw new Error(compilation.compileError || "compiler probe failed");
    }
    binaryPath = compilation.executablePath;
    const artifact = await importExecutorArtifact(binaryPath);
    const workspace = await createExecutorWorkspace();
    const runId = `cpp_session_probe_${token}`;
    try {
      attachExecutorRun(jobId, runId);
      const spec = buildSubmissionExecutorRunSpec({
        runId,
        workspaceId: workspace.id,
        executableId: artifact.executableId,
        args: [],
        environment: {},
        timeLimitMs: 2_000,
        memoryBytes: 128 * MiB,
      });
      const result = await runReservedExecutor(jobId, spec);
      if (
        result.reason === "cancelled"
        || (jobId !== undefined && (!activeJobs.get(jobId) || activeJobs.get(jobId)?.cancel === true))
      ) {
        throw new JudgeJobCancelledError();
      }
      const stdoutPath = path.join(workspace.path, spec.stdoutFile);
      const stdout = fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath, "utf8") : "";
      if (
        result.reason !== "exited"
        || result.exitCode !== 0
        || stdout.trim() !== "JUDGEDESK_SESSION_PROBE_OK"
      ) {
        throw new Error(
          `sandbox probe failed (${result.reason}, ${result.exitCode}): ${result.diagnostic || stdout}`,
        );
      }
    } finally {
      detachExecutorRun(jobId, runId);
      workspace.dispose();
    }
  } finally {
    fs.rmSync(sourcePath, { force: true });
    if (binaryPath) fs.rmSync(binaryPath, { force: true });
  }
}

export async function ensureCertifiedLocalCppSessionProbe(
  toolchain: Readonly<ResolvedToolchain>,
  tempDirectory: string,
  jobId?: string,
): Promise<void> {
  if (toolchain.provenance !== "certified-local") return;
  if (!toolchain.certificateId || !toolchain.snapshotDigest) {
    throw new Error("TOOLCHAIN_PREFLIGHT_FAILED: certified local C++ pin is incomplete.");
  }
  if (jobId !== undefined && (!activeJobs.get(jobId) || activeJobs.get(jobId)?.cancel === true)) {
    throw new JudgeJobCancelledError();
  }
  const key = `${toolchain.certificateId}:${toolchain.snapshotDigest}`;
  let probe = sessionProbePromises.get(key);
  if (!probe) {
    probe = runCertifiedLocalCppSessionProbe(toolchain, tempDirectory, jobId);
    sessionProbePromises.set(key, probe);
  }
  try {
    await probe;
  } catch (error) {
    if (sessionProbePromises.get(key) === probe) sessionProbePromises.delete(key);
    if (
      error instanceof JudgeJobCancelledError
      || (jobId !== undefined && (!activeJobs.get(jobId) || activeJobs.get(jobId)?.cancel === true))
    ) {
      throw error instanceof JudgeJobCancelledError ? error : new JudgeJobCancelledError();
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`TOOLCHAIN_PREFLIGHT_FAILED: certified local C++ session probe failed: ${message}`);
  }
}

export function startBackgroundCertifiedLocalProbe(): void {
  void (async () => {
    try {
      const { resolveNativeProtectedToolchain } = await import("../toolchains/resolver.js");
      const cpp = resolveNativeProtectedToolchain("cpp");
      if (cpp.provenance === "certified-local" && cpp.ready && cpp.certificateId && cpp.snapshotDigest) {
        const { createRunWorkspace } = await import("./run-workspace.js");
        const workspace = createRunWorkspace();
        try {
          await ensureCertifiedLocalCppSessionProbe(cpp, workspace.path);
          console.info("[Judge] Background certified local C++ probe ready.");
        } finally {
          workspace.dispose();
        }
      }
    } catch (error) {
      console.warn("[Judge] Background certified local C++ probe idle check deferred:", error);
    }
  })();
}
