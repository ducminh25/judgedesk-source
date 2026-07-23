import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executorClient } from "../server/executor/client.js";
import { DEFAULT_EXECUTOR_LIMITS } from "../server/executor/protocol.js";
import { executorResultToVerdict } from "../server/executor/verdict-mapper.js";
import { createExecutorWorkspace, importExecutorArtifact } from "../server/executor/workspace.js";
import {
  buildSubmissionCompilerArgs,
  compileSubmission,
  resolveCompilationToolchain,
  runCompilerWithLimits,
} from "../server/judge/compiler.js";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The macOS compiler smoke test requires an Apple Silicon host.");
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
  });
  if (compilation.compileStatus !== "OK") {
    const toolchain = await resolveCompilationToolchain("cpp");
    const diagnosticOutput = path.join(temporaryDirectory, "diagnostic.out");
    let verboseError = "toolchain unavailable";
    if (toolchain.ready) {
      try {
        await runCompilerWithLimits(
          toolchain.executablePath,
          ["-v", ...buildSubmissionCompilerArgs("darwin", sourcePath, diagnosticOutput)],
          temporaryDirectory,
          diagnosticOutput,
        );
        verboseError = "verbose retry unexpectedly succeeded";
      } catch (error) {
        verboseError = error instanceof Error ? error.message : String(error);
      }
    }
    throw new Error(`macOS compiler smoke failed: ${compilation.compileError}\nVerbose retry: ${verboseError}`);
  }

  const artifact = await importExecutorArtifact(compilation.executablePath);
  const workspace = await createExecutorWorkspace();
  try {
    const run = await executorClient.run({
      runId: `macos_compiler_smoke_${crypto.randomUUID().replaceAll("-", "_")}`,
      role: "submission",
      workspaceId: workspace.id,
      executableId: artifact.executableId,
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

  const divideByZeroSourcePath = path.join(temporaryDirectory, "integer-divide-by-zero.cpp");
  fs.writeFileSync(
    divideByZeroSourcePath,
    [
      "int main(int argc, char**) {",
      "  volatile int runtimeDivisor = argc - 1;",
      "  return 42 / runtimeDivisor;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  const divideByZeroCompilation = await compileSubmission({
    language: "cpp",
    contestantName: "smoke",
    problemName: "integer_divide_by_zero",
    submissionPath: divideByZeroSourcePath,
    tempDirectory: temporaryDirectory,
  });
  if (divideByZeroCompilation.compileStatus !== "OK") {
    throw new Error(`macOS integer divide-by-zero probe failed to compile: ${divideByZeroCompilation.compileError}`);
  }

  const divideByZeroArtifact = await importExecutorArtifact(divideByZeroCompilation.executablePath);
  const divideByZeroWorkspace = await createExecutorWorkspace();
  try {
    const run = await executorClient.run({
      runId: `macos_divide_by_zero_smoke_${crypto.randomUUID().replaceAll("-", "_")}`,
      role: "submission",
      workspaceId: divideByZeroWorkspace.id,
      executableId: divideByZeroArtifact.executableId,
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
      throw new Error(`integer divide-by-zero did not produce RE: ${JSON.stringify(run)}`);
    }
  } finally {
    divideByZeroWorkspace.dispose();
  }
  console.log("Apple Clang integer divide-by-zero trap smoke passed with RE.");
} finally {
  await executorClient.shutdown();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
