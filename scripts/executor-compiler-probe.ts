import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { executorClient } from "../server/executor/client.js";
import { DEFAULT_EXECUTOR_LIMITS } from "../server/executor/protocol.js";
import { createExecutorWorkspace } from "../server/executor/workspace.js";

const health = await executorClient.start();
if (!health.ready) throw new Error(health.diagnostics.join("; "));
const helper = path.join(process.cwd(), "src-tauri/binaries/judgedesk-executor-x86_64-pc-windows-msvc.exe");
const cc1plus = findFile(path.join(health.executorRoot, "toolchains"), "cc1plus.exe");
if (!cc1plus) throw new Error("Managed cc1plus.exe was not found; run one managed C++ compile first.");

try {
  console.log("nested helper:", await nestedProbe(helper));
  console.log("nested cc1plus:", await nestedProbe(cc1plus));
  console.log("top-level cc1plus:", await topLevelProbe(cc1plus));
} finally {
  await executorClient.shutdown();
}

async function nestedProbe(child: string) {
  const workspace = await createExecutorWorkspace();
  try {
    workspace.stage(helper, "probe.exe", true);
    const result = await executorClient.run({
      runId: id("nested"),
      role: "compiler",
      workspaceId: workspace.id,
      executableId: workspace.relative("probe.exe"),
      args: ["--test-spawn-child", child, "--version"],
      stdoutFile: "stdout.txt",
      stderrFile: "stderr.txt",
      environment: { PATH: `${path.dirname(cc1plus)};${path.dirname(helper)}` },
      limits: compilerLimits(),
    });
    return { result, stdout: fs.readFileSync(path.join(workspace.path, "stdout.txt"), "utf8") };
  } finally {
    workspace.dispose();
  }
}

async function topLevelProbe(executable: string) {
  const workspace = await createExecutorWorkspace();
  try {
    const result = await executorClient.run({
      runId: id("top"),
      role: "compiler",
      workspaceId: workspace.id,
      executableId: path.relative(health.executorRoot, executable).replaceAll("\\", "/"),
      args: ["--version"],
      stdoutFile: "stdout.txt",
      stderrFile: "stderr.txt",
      environment: { PATH: path.dirname(executable) },
      limits: compilerLimits(),
    });
    return {
      result,
      stdout: fs.readFileSync(path.join(workspace.path, "stdout.txt"), "utf8"),
      stderr: fs.readFileSync(path.join(workspace.path, "stderr.txt"), "utf8"),
    };
  } finally {
    workspace.dispose();
  }
}

function compilerLimits() {
  return {
    ...DEFAULT_EXECUTOR_LIMITS.compiler,
    wallTimeMs: 5000,
    memoryBytes: 512 * 1024 * 1024,
  };
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "_")}`;
}

function findFile(root: string, name: string): string | null {
  if (!fs.existsSync(root)) return null;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return entryPath;
    }
  }
  return null;
}
