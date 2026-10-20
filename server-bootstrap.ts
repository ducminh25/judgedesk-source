import { awaitBackendStartupGate } from "./server/platform/backend-startup-gate.js";
import { processApiSessionTokenStore } from "./server/platform/api-session.js";
import {
  migrateLegacyBundledToolchains,
  migrateLegacyExecutionPolicy,
} from "./server/toolchains/migration.js";

async function bootstrap(): Promise<void> {
  // Consume and delete the bearer token before any asynchronous startup work.
  processApiSessionTokenStore.consume(process.env, true);
  const parentLiveness = await awaitBackendStartupGate();
  parentLiveness.onParentLost((error) => {
    console.error(`[Tauri Shell] Backend parent channel lost: ${error.message}`);
    process.exit(70);
  });
  try {
    migrateLegacyBundledToolchains();
    migrateLegacyExecutionPolicy();
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
