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
import type {
  ExecutorLocalToolchainIdentity,
  ExecutorToolchainIdentity,
} from "../executor/protocol.js";
import type { ExecutorWorkspace } from "../executor/workspace.js";
import type { ResolvedToolchain } from "../toolchains/types.js";

export interface IsolatedScratchLaunch {
  executableId: string;
  args: string[];
  environment: Record<string, string>;
  toolchain?: ExecutorToolchainIdentity;
  localToolchain?: ExecutorLocalToolchainIdentity;
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
  ) {
    throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
  }
  const executablePath = path.resolve(pinnedToolchain.executablePath);
  const rootPath = path.resolve(
    pinnedToolchain.packageRoot || path.dirname(executablePath),
  );
  const relativePath = path.relative(rootPath, executablePath).replaceAll("\\", "/");
  workspace.stage(sourcePath, stagedName);
  return {
    executableId: `local-toolchain/${relativePath}`,
    args: [
      stagedName,
    ],
    environment: {
      JUDGEDESK_SCRATCH_ISOLATED: "1",
      TURBO_MODE: "1",
      PATH: rootPath,
    },
    localToolchain: {
      rootPath,
      executableRelativePath: relativePath,
      isolation: "resource-only",
    },
  };
}
