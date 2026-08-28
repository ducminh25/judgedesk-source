/**
 * Headless Scratch Execution Adapter for JudgeDesk.
 *
 * Implements automated headless judging for Scratch projects (.sb3, .sb2, .sb, project.json).
 *
 * I/O Contract:
 * - Standard Input: Handled via Scratch's `ask () and wait` blocks (line-by-line & tokenized).
 * - Standard Output: Emitted via Scratch's `say ()` (with newline) and `think ()` (without newline).
 * - Turbo Mode: Enabled by default for high-speed execution.
 */

import path from "node:path";
import type { ExecutorToolchainIdentity } from "../executor/protocol.js";
import {
  prepareManagedToolchainComponent,
  type ExecutorWorkspace,
} from "../executor/workspace.js";
import type { ResolvedToolchain } from "../toolchains/types.js";

export interface IsolatedScratchLaunch {
  executableId: string;
  args: string[];
  environment: Record<string, string>;
  toolchain?: ExecutorToolchainIdentity;
}

export async function prepareIsolatedScratchScript(
  workspace: ExecutorWorkspace,
  sourcePath: string,
  stagedName: string,
  pinnedToolchain: Readonly<ResolvedToolchain>,
): Promise<IsolatedScratchLaunch> {
  if (
    pinnedToolchain.kind !== "scratch"
    || !pinnedToolchain.ready
    || pinnedToolchain.source !== "managed"
  ) {
    throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
  }
  const runtime = await prepareManagedToolchainComponent(
    "scratch",
    pinnedToolchain,
    pinnedToolchain.packageComponentId,
    "submission-runtime",
  );
  workspace.stage(sourcePath, stagedName);
  return {
    executableId: runtime.executableId,
    args: [
      stagedName,
    ],
    environment: {
      JUDGEDESK_SCRATCH_ISOLATED: "1",
      TURBO_MODE: "1",
      PATH: path.dirname(runtime.executablePath),
    },
    ...(runtime.toolchain ? { toolchain: runtime.toolchain } : {}),
  };
}
