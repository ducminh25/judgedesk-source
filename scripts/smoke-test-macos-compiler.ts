import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executorClient } from "../server/executor/client.js";
import { DEFAULT_EXECUTOR_LIMITS } from "../server/executor/protocol.js";
import { executorResultToVerdict } from "../server/executor/verdict-mapper.js";
import { createExecutorWorkspace } from "../server/executor/workspace.js";
import {
  buildSubmissionCompilerArgs,
  compileSubmission,
  runCompilerWithLimits,
} from "../server/judge/compiler.js";
import {
  findSelectedDarwinCompiler,
  verifyLocalToolchainCandidate,
} from "../server/toolchains/resolver.js";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The macOS compiler smoke test requires an Apple Silicon host.");
}

const compilerPath = findSelectedDarwinCompiler("cpp");
if (!compilerPath) {
  throw new Error("Apple Clang was not found in the selected Xcode or Command Line Tools installation.");
}
const toolchainReadinessTimeoutMs = 15_000;
const toolchainReadinessPollIntervalMs = 100;
const readinessDeadline = Date.now() + toolchainReadinessTimeoutMs;
let cppToolchain = verifyLocalToolchainCandidate("cpp", compilerPath);
while (
  !cppToolchain.ready
  && cppToolchain.diagnosticCode === "DETECTION_IN_PROGRESS"
  && Date.now() < readinessDeadline
) {
  await new Promise((resolve) => setTimeout(resolve, toolchainReadinessPollIntervalMs));
  cppToolchain = verifyLocalToolchainCandidate("cpp", compilerPath);
}
if (!cppToolchain.ready) {
  throw new Error(
    `Apple Clang did not pass JudgeDesk policy: ${cppToolchain.diagnosticCode ?? "UNKNOWN"}: ${cppToolchain.diagnostic ?? cppToolchain.version}`,
  );
}
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-macos-compiler-"));
const sourcePath = path.join(temporaryDirectory, "hello.cpp");
fs.writeFileSync(
  sourcePath,
  [
    "#include <bits/stdc++.h>",
    "int main() {",
    "  std::vector<int> values{3, 1, 2};",
    "  std::sort(values.begin(), values.end());",
    "  std::cout << \"JUDGEDESK_COMPILER_SMOKE:\" << std::accumulate(values.begin(), values.end(), 0) << '\\n';",
    "}",
    "",
  ].join("\n"),
  "utf8",
);

try {
  const compilation = await compileSubmission({
    language: "cpp",
    contestantName: "smoke",
    problemName: "compiler",
    submissionPath: sourcePath,
    tempDirectory: temporaryDirectory,
    toolchains: { cpp: cppToolchain },
  });
  if (compilation.compileStatus !== "OK") {
    const diagnosticOutput = path.join(temporaryDirectory, "diagnostic.out");
    let verboseError: string;
    try {
      await runCompilerWithLimits(
        cppToolchain.executionPath || cppToolchain.executablePath,
        ["-v", ...buildSubmissionCompilerArgs("darwin", sourcePath, diagnosticOutput)],
        temporaryDirectory,
        diagnosticOutput,
        undefined,
        undefined,
        "cpp",
        {},
        cppToolchain,
      );
      verboseError = "verbose retry unexpectedly succeeded";
    } catch (error) {
      verboseError = error instanceof Error ? error.message : String(error);
    }
    throw new Error(`macOS compiler smoke failed: ${compilation.compileError}\nVerbose retry: ${verboseError}`);
  }

  const workspace = await createExecutorWorkspace();
  const submissionExe = "submission";
  workspace.stage(compilation.executablePath, submissionExe, true);
  try {
    const run = await executorClient.run({
      runId: `macos_compiler_smoke_${crypto.randomUUID().replaceAll("-", "_")}`,
      role: "submission",
      workspaceId: workspace.id,
      executableId: workspace.relative(submissionExe),
      args: [],
      stdoutFile: "stdout.txt",
      stderrFile: "stderr.txt",
      environment: {},
      limits: {
        ...DEFAULT_EXECUTOR_LIMITS.submission,
        wallTimeMs: 2_000,
        memoryBytes: 128 * 1024 * 1024,
      },
    });
    const output = fs.readFileSync(path.join(workspace.path, "stdout.txt"), "utf8");
    if (run.reason !== "exited" || run.exitCode !== 0 || output.trim() !== "JUDGEDESK_COMPILER_SMOKE:6") {
      throw new Error(`compiled binary smoke failed: ${JSON.stringify({ run, output })}`);
    }
  } finally {
    workspace.dispose();
  }
  console.log(`Apple Clang compile-and-run smoke passed in ${compilation.compileTime.toFixed(0)} ms.`);

  const runtimeAbortSourcePath = path.join(temporaryDirectory, "runtime-abort.cpp");
  fs.writeFileSync(
    runtimeAbortSourcePath,
    [
      "#include <cstdlib>",
      "int main() {",
      "  std::abort();",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  const runtimeAbortCompilation = await compileSubmission({
    language: "cpp",
    contestantName: "smoke",
    problemName: "runtime_abort",
    submissionPath: runtimeAbortSourcePath,
    tempDirectory: temporaryDirectory,
    toolchains: { cpp: cppToolchain },
  });
  if (runtimeAbortCompilation.compileStatus !== "OK") {
    throw new Error(`macOS runtime-abort probe failed to compile: ${runtimeAbortCompilation.compileError}`);
  }

  const runtimeAbortWorkspace = await createExecutorWorkspace();
  runtimeAbortWorkspace.stage(runtimeAbortCompilation.executablePath, submissionExe, true);
  try {
    const run = await executorClient.run({
      runId: `macos_runtime_abort_smoke_${crypto.randomUUID().replaceAll("-", "_")}`,
      role: "submission",
      workspaceId: runtimeAbortWorkspace.id,
      executableId: runtimeAbortWorkspace.relative(submissionExe),
      args: [],
      stdoutFile: "stdout.txt",
      stderrFile: "stderr.txt",
      environment: {},
      limits: {
        ...DEFAULT_EXECUTOR_LIMITS.submission,
        wallTimeMs: 2_000,
        memoryBytes: 128 * 1024 * 1024,
      },
    });
    if (executorResultToVerdict(run) !== "RE") {
      throw new Error(`std::abort did not produce RE: ${JSON.stringify(run)}`);
    }
  } finally {
    runtimeAbortWorkspace.dispose();
  }
  console.log("Apple Clang runtime-abort smoke passed with RE.");
} finally {
  await executorClient.shutdown();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
