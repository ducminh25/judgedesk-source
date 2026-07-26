import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executorClient } from "../server/executor/client.js";
import { DEFAULT_EXECUTOR_LIMITS } from "../server/executor/protocol.js";
import {
  createExecutorWorkspace,
  purgeCachedManagedToolchain,
} from "../server/executor/workspace.js";
import { prepareIsolatedPythonScript } from "../server/judge/python-runtime.js";
import { installToolchain } from "../server/toolchains/installer.js";
import { loadOfficialManifest } from "../server/toolchains/manifest.js";
import { resolveManagedToolchain } from "../server/toolchains/resolver.js";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The managed Python smoke test requires Apple Silicon macOS.");
}

let installedForSmoke = false;
let managed = resolveManagedToolchain("python");
if (!managed.ready && process.env.JUDGEDESK_SMOKE_INSTALL_MANAGED_PYTHON === "1") {
  const manifest = await loadOfficialManifest({ forceRefresh: true });
  const descriptor = manifest.find((entry) =>
    entry.kind === "python" && entry.platform === "darwin" && entry.arch === "arm64"
  );
  if (!descriptor) throw new Error("The official manifest has no Apple Silicon Python package.");
  await installToolchain(descriptor);
  installedForSmoke = true;
  managed = resolveManagedToolchain("python");
}
if (!managed.ready) {
  throw new Error("Managed Python is not installed for the macOS smoke test.");
}

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-python-smoke-"));
const sourcePath = path.join(temporaryDirectory, "submission.py");
fs.writeFileSync(sourcePath, "import math\nprint(f'JUDGEDESK_PYTHON_SMOKE:{math.factorial(6)}')\n", "utf8");
const workspace = await createExecutorWorkspace();

try {
  const launch = await prepareIsolatedPythonScript(workspace, sourcePath, "submission.py");
  const health = executorClient.health;
  const cachedExecutable = fs.realpathSync(path.join(health.executorRoot, launch.executableId));
  const relativeExecutable = path.relative(fs.realpathSync(health.executorRoot), cachedExecutable);
  if (relativeExecutable.startsWith("..") || path.isAbsolute(relativeExecutable)) {
    throw new Error(`Managed Python cache escaped the executor root: ${cachedExecutable}`);
  }

  const result = await executorClient.run({
    runId: `python_smoke_${crypto.randomUUID().replaceAll("-", "_")}`,
    role: "submission",
    workspaceId: workspace.id,
    executableId: launch.executableId,
    args: launch.args,
    stdoutFile: "stdout.txt",
    stderrFile: "stderr.txt",
    environment: launch.environment,
    limits: {
      ...DEFAULT_EXECUTOR_LIMITS.submission,
      wallTimeMs: 2_000,
      memoryBytes: 128 * 1024 * 1024,
    },
  });
  const stdout = fs.readFileSync(path.join(workspace.path, "stdout.txt"), "utf8").trim();
  const stderr = fs.readFileSync(path.join(workspace.path, "stderr.txt"), "utf8").trim();
  if (result.reason !== "exited" || result.exitCode !== 0 || stdout !== "JUDGEDESK_PYTHON_SMOKE:720") {
    throw new Error(`Managed Python smoke failed: ${JSON.stringify({ result, stdout, stderr })}`);
  }
  console.log(`Managed Python compile-and-run smoke passed via ${cachedExecutable}.`);
} finally {
  workspace.dispose();
  if (installedForSmoke) await purgeCachedManagedToolchain("python");
  await executorClient.shutdown();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
