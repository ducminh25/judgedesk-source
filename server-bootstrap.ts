import { awaitBackendStartupGate } from "./server/platform/backend-startup-gate.js";

async function bootstrap(): Promise<void> {
  const parentLiveness = await awaitBackendStartupGate();
  parentLiveness.onParentLost((error) => {
    console.error(`[Tauri Shell] Backend parent channel lost: ${error.message}`);
    process.exit(70);
  });
  await import("./server.js");
}

void bootstrap().catch((error) => {
  console.error(
    `[Tauri Shell] Backend bootstrap failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(70);
});
