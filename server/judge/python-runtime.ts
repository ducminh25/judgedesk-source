import path from "node:path";
import type { ExecutorWorkspace } from "../executor/workspace.js";
import {
  findCachedManagedToolchain,
  importManagedToolchain,
} from "../executor/workspace.js";
import { resolveCompilationToolchain } from "./compiler.js";

export interface PythonLaunch {
  executableId: string;
  args: string[];
  environment: Record<string, string>;
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
    environment: {
      JUDGEDESK_PYTHON_ISOLATED: "1",
      PYTHONNOUSERSITE: "1",
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONHOME: options.pythonHome,
      PATH: options.pythonBinDirectory,
    },
  };
}

export async function prepareIsolatedPythonScript(
  workspace: ExecutorWorkspace,
  sourcePath: string,
  stagedName: string,
  expectedExecutablePath?: string,
): Promise<PythonLaunch> {
  const python = await resolveCompilationToolchain("python");
  if (!python.ready) throw new Error("TOOLCHAIN_PYTHON_MISSING");
  if (expectedExecutablePath && path.resolve(python.executablePath) !== path.resolve(expectedExecutablePath)) {
    throw new Error("TOOLCHAIN_PYTHON_MISSING");
  }
  if (python.source !== "managed") throw new Error("TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");

  const existingCache = await findCachedManagedToolchain("python");
  const cached = existingCache
    ?? await importManagedToolchain("python", python.executablePath, python.version);
  workspace.stage(sourcePath, stagedName);
  return buildIsolatedPythonLaunch({
    executableId: cached.executableId,
    scriptPath: path.join(workspace.path, stagedName),
    pythonHome: cached.root,
    pythonBinDirectory: path.dirname(cached.executablePath),
  });
}
