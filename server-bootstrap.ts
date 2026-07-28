import { awaitBackendStartupGate } from "./server/platform/backend-startup-gate.js";

async function bootstrap(): Promise<void> {
  await awaitBackendStartupGate();
  await import("./server.js");
}

void bootstrap().catch((error) => {
  console.error(
    `[Tauri Shell] Backend bootstrap failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(70);
});
