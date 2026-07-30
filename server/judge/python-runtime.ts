import path from "node:path";
import type { ExecutorWorkspace } from "../executor/workspace.js";
import {
  prepareManagedToolchainExecutable,
} from "../executor/workspace.js";
import type { ExecutorToolchainIdentity } from "../executor/protocol.js";
import { resolveCompilationToolchain } from "./compiler.js";

export interface PythonLaunch {
  executableId: string;
  args: string[];
  environment: Record<string, string>;
  toolchain?: ExecutorToolchainIdentity;
}

export interface IsolatedPythonRuntime {
  executableId: string;
  executablePath: string;
  environment: Record<string, string>;
  toolchain?: ExecutorToolchainIdentity;
}

interface IsolatedPythonLaunchOptions {
  executableId: string;
  scriptPath: string;
  pythonHome: string;
  pythonBinDirectory: string;
}

export function buildIsolatedPythonLaunch(
  options: IsolatedPythonLaunchOptions,
): PythonLaunch {
  return {
    executableId: options.executableId,
    args: ["-I", "-B", options.scriptPath],
    environment: buildIsolatedPythonEnvironment(
      options.pythonHome,
      options.pythonBinDirectory,
    ),
  };
}

function buildIsolatedPythonEnvironment(
  pythonHome: string,
  pythonBinDirectory: string,
): Record<string, string> {
  return {
    JUDGEDESK_PYTHON_ISOLATED: "1",
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONHOME: pythonHome,
    PATH: pythonBinDirectory,
  };
}

export async function prepareIsolatedPythonScript(
  workspace: ExecutorWorkspace,
  sourcePath: string,
  stagedName: string,
  expectedExecutablePath?: string,
): Promise<PythonLaunch> {
  const runtime = await prepareIsolatedPythonRuntime(expectedExecutablePath);
  workspace.stage(sourcePath, stagedName);
  return {
    executableId: runtime.executableId,
    args: ["-I", "-B", path.join(workspace.path, stagedName)],
    environment: runtime.environment,
    ...(runtime.toolchain ? { toolchain: runtime.toolchain } : {}),
  };
}

export async function prepareIsolatedPythonRuntime(
  expectedExecutablePath?: string,
): Promise<IsolatedPythonRuntime> {
  const python = await resolveCompilationToolchain("python");
  if (!python.ready) throw new Error("TOOLCHAIN_PYTHON_MISSING");
  if (expectedExecutablePath && path.resolve(python.executablePath) !== path.resolve(expectedExecutablePath)) {
    throw new Error("TOOLCHAIN_PYTHON_MISSING");
  }
  if (python.source !== "managed") throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");

  const cached = await prepareManagedToolchainExecutable("python", python);
  return {
    executableId: cached.executableId,
    executablePath: cached.executablePath,
    environment: buildIsolatedPythonEnvironment(
      cached.root,
      path.dirname(cached.executablePath),
    ),
    ...(cached.toolchain ? { toolchain: cached.toolchain } : {}),
  };
}
