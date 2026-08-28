import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { executorClient } from "../executor/client.js";
import {
  createExecutorWorkspace,
  importExecutorArtifact,
} from "../executor/workspace.js";
import { runReservedExecutor } from "../jobs.js";
import { getRegisteredLanguageProfile } from "../languages/registry.js";
import { compileSubmission, resolveCompilationToolchain } from "../judge/compiler.js";
import { buildSubmissionExecutorRunSpec } from "../judge/execution-request.js";
import { prepareIsolatedPythonScript } from "../judge/python-runtime.js";
import { prepareDirectoryRuntimeProgram } from "../judge/managed-runtime.js";
import { prepareIsolatedNodeScript } from "../judge/node-runtime.js";
import { createRunWorkspace } from "../judge/run-workspace.js";
import type { ToolchainKind } from "./types.js";

const DEFAULT_PROBE_MEMORY_BYTES = 128 * 1024 * 1024;
const DEFAULT_PROBE_TIME_LIMIT_MS = 3_000;
const PROBE_TOKEN_MARKER = "JUDGEDESK_PROBE_OK";

export interface ToolchainDiagnosticResult {
  success: boolean;
  profileId: string;
  language: string;
  sourceMode?: string;
  version?: string;
  phase: "configuration" | "compilation" | "execution";
  compileTimeMs?: number;
  executionTimeMs?: number;
  peakMemoryKb?: number;
  stdout?: string;
  error?: string;
}

function getProbeSource(kind: ToolchainKind): { fileName: string; sourceCode: string } {
  switch (kind) {
    case "cpp":
      return {
        fileName: "probe.cpp",
        sourceCode: `#include <iostream>\nint main() { std::cout << "${PROBE_TOKEN_MARKER}" << std::endl; return 0; }\n`,
      };
    case "c":
      return {
        fileName: "probe.c",
        sourceCode: `#include <stdio.h>\nint main(void) { puts("${PROBE_TOKEN_MARKER}"); return 0; }\n`,
      };
    case "python":
      return {
        fileName: "probe.py",
        sourceCode: `print("${PROBE_TOKEN_MARKER}")\n`,
      };
    case "pascal":
      return {
        fileName: "probe.pas",
        sourceCode: `program Probe;\nbegin\n  writeln('${PROBE_TOKEN_MARKER}');\nend.\n`,
      };
    case "java":
      return {
        fileName: "Main.java",
        sourceCode: `public class Main {\n  public static void main(String[] args) {\n    System.out.println("${PROBE_TOKEN_MARKER}");\n  }\n}\n`,
      };
    default:
      return {
        fileName: "probe.txt",
        sourceCode: `${PROBE_TOKEN_MARKER}\n`,
      };
  }
}

export async function diagnoseLanguageProfile(
  profileId: string,
): Promise<ToolchainDiagnosticResult> {
  const profile = getRegisteredLanguageProfile(profileId);
  if (!profile) {
    return {
      success: false,
      profileId,
      language: "unknown",
      phase: "configuration",
      error: `Language profile '${profileId}' is not registered.`,
    };
  }

  const kind = profile.toolchainKind;
  const toolchain = await resolveCompilationToolchain(kind);

  if (!toolchain.ready) {
    return {
      success: false,
      profileId,
      language: kind,
      sourceMode: toolchain.source,
      version: toolchain.version,
      phase: "configuration",
      error:
        toolchain.diagnostic
        || toolchain.diagnosticCode
        || "Compiler/runtime is not ready or not installed.",
    };
  }

  if (!executorClient.health.ready) {
    return {
      success: false,
      profileId,
      language: kind,
      sourceMode: toolchain.source,
      version: toolchain.version,
      phase: "configuration",
      error: `Native secure runner is unavailable: ${executorClient.health.diagnostics.join("; ")}`,
    };
  }

  const runWorkspace = createRunWorkspace();
  const token = crypto.randomUUID().replaceAll("-", "_");
  const probeInfo = getProbeSource(kind);
  const sourcePath = path.join(runWorkspace.path, probeInfo.fileName);
  fs.writeFileSync(sourcePath, probeInfo.sourceCode, "utf8");

  try {
    const compilation = await compileSubmission({
      language: kind === "pascal" ? "pascal" : kind === "java" ? "java" : kind === "c" ? "c" : kind === "python" ? "python" : "cpp",
      contestantName: `probe_${token}`,
      problemName: "diagnostics",
      submissionPath: sourcePath,
      tempDirectory: runWorkspace.path,
      cppToolchain: kind === "cpp" ? toolchain : undefined,
      cToolchain: kind === "c" ? toolchain : undefined,
      pythonToolchain: kind === "python" ? toolchain : undefined,
      toolchains: { [kind]: toolchain },
    });

    if (compilation.compileStatus !== "OK") {
      return {
        success: false,
        profileId,
        language: kind,
        sourceMode: toolchain.source,
        version: toolchain.version,
        phase: "compilation",
        error: compilation.compileError || "Compilation failed.",
      };
    }

    const executorWorkspace = await createExecutorWorkspace();
    try {
      let launchSpec: {
        executableId: string;
        args: string[];
        environment: Record<string, string>;
        toolchain?: import("../executor/protocol.js").ExecutorToolchainIdentity;
        localToolchain?: import("../executor/protocol.js").ExecutorLocalToolchainIdentity;
      };

      if (compilation.program?.kind === "native") {
        const artifact = await importExecutorArtifact(compilation.program.artifactPath);
        launchSpec = { executableId: artifact.executableId, args: [], environment: {} };
      } else if (compilation.program?.kind === "script-runtime" && compilation.program.language === "python") {
        launchSpec = await prepareIsolatedPythonScript(
          executorWorkspace,
          compilation.program.sourcePath,
          compilation.program.stagedFileName,
          compilation.program.runtimeToolchain.executionPath || compilation.program.runtimeToolchain.executablePath,
          compilation.program.runtimeToolchain,
        );
      } else if (compilation.program?.kind === "directory-runtime") {
        launchSpec = await prepareDirectoryRuntimeProgram(
          executorWorkspace,
          compilation.program,
          DEFAULT_PROBE_MEMORY_BYTES,
        );
      } else if (compilation.program?.kind === "script-runtime" && compilation.program.language === "javascript") {
        launchSpec = await prepareIsolatedNodeScript(
          executorWorkspace,
          compilation.program.sourcePath,
          compilation.program.stagedFileName,
          compilation.program.runtimeToolchain,
        );
      } else if (compilation.executablePath) {
        const artifact = await importExecutorArtifact(compilation.executablePath);
        launchSpec = { executableId: artifact.executableId, args: [], environment: {} };
      } else {
        throw new Error(`Unable to prepare launch spec for ${kind}`);
      }

      const runId = `diag_${token}`;
      const result = await runReservedExecutor(
        undefined,
        buildSubmissionExecutorRunSpec({
          runId,
          workspaceId: executorWorkspace.id,
          executableId: launchSpec.executableId,
          args: launchSpec.args,
          environment: launchSpec.environment,
          toolchain: launchSpec.toolchain,
          localToolchain: launchSpec.localToolchain,
          timeLimitMs: DEFAULT_PROBE_TIME_LIMIT_MS,
          memoryBytes: DEFAULT_PROBE_MEMORY_BYTES,
        }),
      );

      const stdoutPath = path.join(executorWorkspace.path, "stdout.txt");
      const stdout = fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath, "utf8") : "";

      if (
        result.reason === "exited"
        && result.exitCode === 0
        && stdout.includes(PROBE_TOKEN_MARKER)
      ) {
        return {
          success: true,
          profileId,
          language: kind,
          sourceMode: toolchain.source,
          version: toolchain.version,
          phase: "execution",
          compileTimeMs: compilation.compileTime ? Math.round(compilation.compileTime) : undefined,
          executionTimeMs: result.wallTimeUs ? Math.round(result.wallTimeUs / 1000) : 0,
          peakMemoryKb: result.peakMemoryBytes ? Math.round(result.peakMemoryBytes / 1024) : undefined,
          stdout: stdout.trim(),
        };
      }

      return {
        success: false,
        profileId,
        language: kind,
        sourceMode: toolchain.source,
        version: toolchain.version,
        phase: "execution",
        error:
          result.diagnostic
          || `Process failed in sandbox (reason: ${result.reason}, exit code: ${result.exitCode}).`,
      };
    } finally {
      executorWorkspace.dispose();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      profileId,
      language: kind,
      sourceMode: toolchain.source,
      version: toolchain.version,
      phase: "execution",
      error: message,
    };
  } finally {
    runWorkspace.dispose();
  }
}
