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
    await fetch(`http://127.0.0.1:${state.port}/api/shutdown`, {
      method: "POST",
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
if (process.platform === "win32") {
  const debugSidecar = path.resolve(
    process.cwd(),
    "src-tauri",
    "target",
    "debug",
    "server.exe",
  );
  const statePath = path.join(path.dirname(debugSidecar), "judgedesk-backend-state.json");

  await stopOrphanedBackend(debugSidecar, statePath);

  let descriptor;
  try {
    if (fs.existsSync(debugSidecar)) {
      descriptor = fs.openSync(debugSidecar, "r+");
    }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? error.code
      : "UNKNOWN";

    console.error("\n[Desktop Dev] JudgeDesk debug backend is still running.");
    console.error(
      "Close the existing JudgeDesk window and stop its previous terminal with Ctrl+C, then run npm run test:desktop again.",
    );
    console.error(`Locked file: ${debugSidecar}`);
    console.error(`Windows error: ${code}`);
    process.exit(1);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
