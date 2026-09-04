import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validatePythonCheckerSource } from "./python-checker.js";
import {
  CHECKER_COMPILE_LIMITS,
  getBundledTestlibSource,
  buildCustomCheckerCompilerArgs,
  stageProblemHeaders,
} from "./checker-compiler.js";
import type { ResolvedToolchain } from "../toolchains/types.js";
import {
  isWindowsCppExecutionReady,
  normalizeCompilerError,
  resolveCompilationToolchain,
  runCompilerPipelineWithLimits,
  safeName,
} from "./compiler.js";

export interface CompiledInteractor {
  path: string | null;
  runtime?: "native" | "python";
  pythonExecutablePath?: string;
  pythonToolchain?: Readonly<ResolvedToolchain>;
  error?: string;
}

export interface ResolveInteractorOptions {
  interactorName: string;
  problemName: string;
  problemDirectory: string;
  tempDirectory: string;
  jobId?: string;
  cppToolchain?: ResolvedToolchain;
  pythonToolchain?: ResolvedToolchain;
}

const SESSION_INTERACTOR_CACHE_DIR = path.join(
  os.tmpdir(),
  `judgedesk-interactor-cache-${process.pid}`,
);

try {
  fs.mkdirSync(SESSION_INTERACTOR_CACHE_DIR, { recursive: true });
} catch {}

process.on("exit", () => {
  try {
    fs.rmSync(SESSION_INTERACTOR_CACHE_DIR, { recursive: true, force: true });
  } catch {}
});

const HEADER_EXTENSIONS = new Set([".h", ".hpp", ".hxx", ".hh", ".inc", ".inl", ".tpp"]);

function computeCppInteractorDigest(
  sourcePath: string,
  problemDirectory: string,
  cppToolchain: ResolvedToolchain,
): string {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(sourcePath));
  hash.update(getBundledTestlibSource());
  try {
    const entries = fs.readdirSync(problemDirectory).sort();
    for (const entry of entries) {
      const ext = path.extname(entry).toLowerCase();
      if (HEADER_EXTENSIONS.has(ext)) {
        const headerPath = path.join(problemDirectory, entry);
        if (fs.statSync(headerPath).isFile()) {
          hash.update(entry);
          hash.update(fs.readFileSync(headerPath));
        }
      }
    }
  } catch {}
  hash.update(process.platform);
  hash.update(process.arch);
  hash.update(cppToolchain.version || "");
  hash.update(cppToolchain.source || "");
  hash.update(cppToolchain.certificateId || "");
  hash.update(cppToolchain.snapshotDigest || "");
  hash.update(cppToolchain.executionPath || cppToolchain.executablePath || "");
  return hash.digest("hex");
}

const validatedPythonInteractorDigests = new Set<string>();

function computePythonInteractorDigest(interactorPath: string, pythonToolchain: ResolvedToolchain): string {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(interactorPath));
  hash.update(pythonToolchain.version || "");
  hash.update(pythonToolchain.source || "");
  hash.update(pythonToolchain.executionPath || pythonToolchain.executablePath || "");
  return hash.digest("hex");
}

export async function resolveInteractor(options: ResolveInteractorOptions): Promise<CompiledInteractor> {
  const { interactorName, problemName, problemDirectory, tempDirectory, jobId } = options;
  if (!interactorName) {
    return { path: null, error: "Interactor filename is not specified." };
  }

  const lower = interactorName.toLowerCase();
  if (lower.endsWith(".cpp")) {
    return compileCustomCppInteractor(
      interactorName,
      problemName,
      problemDirectory,
      tempDirectory,
      jobId,
      options.cppToolchain,
    );
  }

  if (lower.endsWith(".py")) {
    const interactorPath = path.join(problemDirectory, interactorName);
    if (!fs.existsSync(interactorPath)) {
      return { path: null, error: `Custom interactor ${interactorName} not found.` };
    }
    const python = options.pythonToolchain ?? await resolveCompilationToolchain("python");
    if (!python.ready) {
      return {
        path: null,
        error: "INTERACTOR_TOOLCHAIN_UNAVAILABLE: cannot run Python interactor; Python is missing",
      };
    }
    if (python.source !== "managed" && !python.localToolchain) {
      return {
        path: null,
        error: "INTERACTOR_TOOLCHAIN_NOT_SANDBOX_COMPATIBLE: select a native-executor compatible Python runtime",
      };
    }
    try {
      const pythonExecutionPath = python.executionPath || python.executablePath;
      const digest = computePythonInteractorDigest(interactorPath, python);
      if (!validatedPythonInteractorDigests.has(digest)) {
        await validatePythonCheckerSource(
          pythonExecutionPath,
          interactorPath,
          python,
          jobId,
        );
        validatedPythonInteractorDigests.add(digest);
      }
      return {
        path: interactorPath,
        runtime: "python",
        pythonExecutablePath: pythonExecutionPath,
        pythonToolchain: python,
      };
    } catch (error) {
      return {
        path: null,
        error: `PYTHON_INTERACTOR_COMPILE_ERROR: ${normalizeCompilerError(error)}`,
      };
    }
  }

  if (lower.endsWith(".exe")) {
    const interactorPath = path.join(problemDirectory, interactorName);
    if (!fs.existsSync(interactorPath)) {
      return { path: null, error: `Custom interactor ${interactorName} not found.` };
    }
    if (process.platform === "win32") {
      return {
        path: interactorPath,
        runtime: "native",
      };
    }
    return {
      path: null,
      error: "Precompiled Windows .exe interactors are not executable on this platform. Please use a .cpp or .py interactor.",
    };
  }

  return {
    path: null,
    error: `Unsupported interactor type: ${interactorName}. Supported: .cpp, .py, .exe`,
  };
}

async function compileCustomCppInteractor(
  interactorFileName: string,
  problemName: string,
  problemDirectory: string,
  tempDirectory: string,
  jobId: string | undefined,
  providedToolchain?: ResolvedToolchain,
): Promise<CompiledInteractor> {
  const sourcePath = path.join(problemDirectory, interactorFileName);
  if (!fs.existsSync(sourcePath)) {
    return { path: null, error: `Interactor source ${interactorFileName} was not found.` };
  }

  const cpp = providedToolchain ?? await resolveCompilationToolchain("cpp");
  if (!cpp.ready) {
    return {
      path: null,
      error: "INTERACTOR_TOOLCHAIN_UNAVAILABLE: cannot compile C++ interactor; G++ is missing",
    };
  }
  if (!isWindowsCppExecutionReady(cpp)) {
    return {
      path: null,
      error: "INTERACTOR_TOOLCHAIN_NOT_EXECUTION_READY: C++ toolchain is missing certified static runtime libraries",
    };
  }

  const digest = computeCppInteractorDigest(sourcePath, problemDirectory, cpp);
  const cachedExecutableName = `${safeName(problemName)}_${digest}${process.platform === "win32" ? ".exe" : ""}`;
  const cachedExecutablePath = path.join(SESSION_INTERACTOR_CACHE_DIR, cachedExecutableName);

  if (fs.existsSync(cachedExecutablePath)) {
    return { path: cachedExecutablePath, runtime: "native" };
  }

  const targetDirectory = fs.mkdtempSync(path.join(tempDirectory, "judgedesk-interactor-"));
  try {
    const includeDirectory = path.join(targetDirectory, "include");
    fs.mkdirSync(includeDirectory, { recursive: true });
    fs.writeFileSync(path.join(includeDirectory, "testlib.h"), getBundledTestlibSource(), "utf8");
    stageProblemHeaders(problemDirectory, includeDirectory);

    const compilerExecutable = cpp.executionPath || cpp.executablePath;
    const destinationPath = path.join(targetDirectory, cachedExecutableName);
    const args = buildCustomCheckerCompilerArgs(
      process.platform,
      includeDirectory,
      sourcePath,
      destinationPath,
    );

    await runCompilerPipelineWithLimits(
      compilerExecutable,
      args,
      targetDirectory,
      destinationPath,
      jobId,
      CHECKER_COMPILE_LIMITS,
      "cpp",
      {},
      cpp,
    );

    if (!fs.existsSync(destinationPath)) {
      return {
        path: null,
        error: "INTERACTOR_COMPILE_ERROR: Compiled interactor executable was not generated.",
      };
    }

    fs.copyFileSync(destinationPath, cachedExecutablePath);
    return { path: cachedExecutablePath, runtime: "native" };
  } catch (error) {
    return { path: null, error: normalizeCompilerError(error) };
  } finally {
    try {
      fs.rmSync(targetDirectory, { recursive: true, force: true });
    } catch {}
  }
}
