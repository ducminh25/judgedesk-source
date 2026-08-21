import { awaitBackendStartupGate } from "./server/platform/backend-startup-gate.js";
import { migrateLegacyBundledToolchains } from "./server/toolchains/migration.js";

async function bootstrap(): Promise<void> {
  const parentLiveness = await awaitBackendStartupGate();
  parentLiveness.onParentLost((error) => {
    console.error(`[Tauri Shell] Backend parent channel lost: ${error.message}`);
    process.exit(70);
  });
  try {
    migrateLegacyBundledToolchains();
  } catch (error) {
    console.error(
      `[Toolchain Migration] Migration warning: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await import("./server.js");
}

void bootstrap().catch((error) => {
  console.error(
    `[Tauri Shell] Backend bootstrap failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(70);
});
