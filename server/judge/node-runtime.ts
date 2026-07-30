import path from "node:path";
import type { ExecutorToolchainIdentity } from "../executor/protocol.js";
import {
  prepareManagedToolchainComponent,
  type ExecutorWorkspace,
} from "../executor/workspace.js";
import type { ResolvedToolchain } from "../toolchains/types.js";

export interface IsolatedNodeLaunch {
  executableId: string;
  args: string[];
  environment: Record<string, string>;
  toolchain?: ExecutorToolchainIdentity;
}

export async function prepareIsolatedNodeScript(
  workspace: ExecutorWorkspace,
  sourcePath: string,
  stagedName: string,
  pinnedToolchain: Readonly<ResolvedToolchain>,
): Promise<IsolatedNodeLaunch> {
  if (
    pinnedToolchain.kind !== "javascript"
    || !pinnedToolchain.ready
    || pinnedToolchain.source !== "managed"
  ) {
    throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
  }
  const runtime = await prepareManagedToolchainComponent(
    "javascript",
    pinnedToolchain,
    pinnedToolchain.packageComponentId,
    "submission-runtime",
  );
  workspace.stage(sourcePath, stagedName);
  return {
    executableId: runtime.executableId,
    args: [path.join(workspace.path, stagedName)],
    environment: {
      JUDGEDESK_NODE_ISOLATED: "1",
      NODE_DISABLE_COLORS: "1",
      PATH: path.dirname(runtime.executablePath),
    },
    ...(runtime.toolchain ? { toolchain: runtime.toolchain } : {}),
  };
}
