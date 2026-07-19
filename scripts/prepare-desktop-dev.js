import fs from "node:fs";
import path from "node:path";

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
