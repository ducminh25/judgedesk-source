import path from "node:path";
import type { ExecutorToolchainIdentity } from "../executor/protocol.js";
import {
  prepareManagedToolchainComponent,
  type ExecutorWorkspace,
} from "../executor/workspace.js";
import type { PreparedSubmissionProgram } from "./prepared-program.js";

export interface ManagedRuntimeLaunch {
  executableId: string;
  args: string[];
  environment: Record<string, string>;
  toolchain: ExecutorToolchainIdentity;
}

type DirectoryRuntimeProgram = Extract<
  PreparedSubmissionProgram,
  { kind: "directory-runtime" }
>;

export async function prepareDirectoryRuntimeProgram(
  workspace: ExecutorWorkspace,
  program: DirectoryRuntimeProgram,
  memoryBytes: number,
): Promise<ManagedRuntimeLaunch> {
  const runtime = await prepareManagedToolchainComponent(
    program.runtimeKind,
    program.runtimeToolchain,
    program.runtimeComponentId,
    "submission-runtime",
  );
  if (!runtime.toolchain) {
    throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
  }
  const artifactDirectory = workspace.stageDirectory(
    program.artifactDirectory,
    "program",
    {
      maxFiles: 512,
      maxBytes: 64 * 1024 * 1024,
    },
  );
  if (program.language === "java") {
    return {
      executableId: runtime.executableId,
      args: buildJavaRuntimeArgs(
        path.relative(workspace.path, artifactDirectory),
        program.entrypoint,
        memoryBytes,
      ),
      environment: {
        JUDGEDESK_JAVA_ISOLATED: "1",
        JAVA_HOME: runtime.root,
        PATH: path.dirname(runtime.executablePath),
      },
      toolchain: runtime.toolchain,
    };
  }
  const relativeArtifactDirectory = path.relative(
    workspace.path,
    artifactDirectory,
  );
  return {
    executableId: runtime.executableId,
    args: [path.join(relativeArtifactDirectory, program.entrypoint)],
    environment: {
      JUDGEDESK_DOTNET_ISOLATED: "1",
      COMPlus_EnableDiagnostics: "0",
      DOTNET_EnableDiagnostics: "0",
      DOTNET_CLI_HOME: workspace.path,
      DOTNET_NOLOGO: "1",
      DOTNET_ROOT: runtime.root,
      DOTNET_CLI_TELEMETRY_OPTOUT: "1",
      DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
      DOTNET_PROCESSOR_COUNT: "1",
      DOTNET_BUNDLE_EXTRACT_BASE_DIR: path.join(
        workspace.path,
        "dotnet-bundle",
      ),
      PATH: path.dirname(runtime.executablePath),
    },
    toolchain: runtime.toolchain,
  };
}

export function buildJavaRuntimeArgs(
  artifactDirectory: string,
  entrypoint: string,
  memoryBytes: number,
): string[] {
  const boundedMemory = Math.max(8 * 1024 * 1024, Math.floor(memoryBytes));
  return [
    "-XX:+UseSerialGC",
    "-XX:ActiveProcessorCount=1",
    "-XX:+ExitOnOutOfMemoryError",
    `-XX:MaxRAM=${boundedMemory}`,
    "-XX:MaxRAMPercentage=65.0",
    "-Dfile.encoding=UTF-8",
    "-Duser.language=en",
    "-Duser.country=US",
    `-Djava.io.tmpdir=${artifactDirectory}`,
    `-Duser.home=${artifactDirectory}`,
    "-cp",
    artifactDirectory,
    entrypoint,
  ];
}
