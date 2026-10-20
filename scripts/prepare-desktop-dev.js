import fs from "node:fs";
import path from "node:path";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function sidecarIsUnlocked(sidecarPath) {
  let descriptor;
  try {
    if (fs.existsSync(sidecarPath)) descriptor = fs.openSync(sidecarPath, "r+");
    return true;
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

async function stopOrphanedBackend(debugSidecar, statePath) {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return;
  }

  const validState = Number.isInteger(state.parentPid)
    && state.parentPid > 0
    && Number.isInteger(state.port)
    && state.port > 0
    && state.port <= 65_535;
  if (!validState || processIsRunning(state.parentPid)) return;

  console.log(`[Desktop Dev] Stopping orphaned backend on port ${state.port}...`);
  try {
    const headers = typeof state.token === "string" && state.token.length === 64
      ? { "X-JudgeDesk-Session": state.token }
      : {};
    await fetch(`http://127.0.0.1:${state.port}/api/shutdown`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    // The orphan may already be gone. The lock probe below is authoritative.
  }

  for (let attempt = 0; attempt < 25 && !sidecarIsUnlocked(debugSidecar); attempt += 1) {
    await wait(100);
  }
  if (sidecarIsUnlocked(debugSidecar)) fs.rmSync(statePath, { force: true });
}

// Windows does not allow Tauri to replace a sidecar executable while an older
// dev session is still running it. Probe write access up front so we can give a
// useful error instead of tauri-build panicking with "Access is denied".
const rustCoreEnv = process.env.JUDGEDESK_PURE_RUST_CORE?.trim().toLowerCase();
const useNodeSidecarRollback = rustCoreEnv === "0" || rustCoreEnv === "false";

if (process.platform === "win32") {
  const debugDir = path.resolve(process.cwd(), "src-tauri", "target", "debug");
  const debugExecutor = path.join(debugDir, "judgedesk-executor.exe");
  const stagedExecutor = path.resolve(
    process.cwd(),
    "src-tauri",
    "binaries",
    "judgedesk-executor-x86_64-pc-windows-msvc.exe",
  );
  const debugSidecar = path.join(debugDir, "server.exe");
  const stagedSidecar = path.resolve(
    process.cwd(),
    "src-tauri",
    "binaries",
    "server-x86_64-pc-windows-msvc.exe",
  );
  const statePath = path.join(debugDir, "judgedesk-backend-state.json");

  await stopOrphanedBackend(useNodeSidecarRollback ? debugSidecar : debugExecutor, statePath);

  const binariesToProbe = useNodeSidecarRollback
    ? [debugExecutor, debugSidecar]
    : [debugExecutor];

  for (const binaryPath of binariesToProbe) {
    let descriptor;
    try {
      if (fs.existsSync(binaryPath)) {
        descriptor = fs.openSync(binaryPath, "r+");
      }
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? error.code
        : "UNKNOWN";

      console.error("\n[Desktop Dev] JudgeDesk debug backend or native executor is still running.");
      console.error(
        "Close the existing JudgeDesk window and stop its previous terminal with Ctrl+C, then run npm run test:desktop again.",
      );
      console.error(`Locked file: ${binaryPath}`);
      console.error(`Windows error: ${code}`);
      process.exit(1);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  if (fs.existsSync(stagedExecutor) && fs.existsSync(debugDir)) {
    fs.copyFileSync(stagedExecutor, debugExecutor);
  }
  if (useNodeSidecarRollback && fs.existsSync(stagedSidecar) && fs.existsSync(debugDir)) {
    fs.copyFileSync(stagedSidecar, debugSidecar);
  }
}

