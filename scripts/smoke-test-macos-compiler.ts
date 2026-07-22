import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executorClient } from "../server/executor/client.js";
import { DEFAULT_EXECUTOR_LIMITS } from "../server/executor/protocol.js";
import { createExecutorWorkspace, importExecutorArtifact } from "../server/executor/workspace.js";
import { compileSubmission } from "../server/judge/compiler.js";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The macOS compiler smoke test requires an Apple Silicon host.");
}

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-macos-compiler-"));
const sourcePath = path.join(temporaryDirectory, "hello.cpp");
fs.writeFileSync(
  sourcePath,
  "#include <iostream>\nint main() { std::cout << \"JUDGEDESK_COMPILER_SMOKE\\n\"; }\n",
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
    throw new Error(`macOS compiler smoke failed: ${compilation.compileError}`);
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
    if (run.reason !== "exited" || run.exitCode !== 0 || output.trim() !== "JUDGEDESK_COMPILER_SMOKE") {
      throw new Error(`compiled binary smoke failed: ${JSON.stringify({ run, output })}`);
    }
  } finally {
    workspace.dispose();
  }
  console.log(`Apple Clang compile-and-run smoke passed in ${compilation.compileTime.toFixed(0)} ms.`);
} finally {
  await executorClient.shutdown();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
