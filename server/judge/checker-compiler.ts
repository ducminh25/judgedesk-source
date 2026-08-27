import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isBuiltInChecker } from "./standard-checkers.js";
import { validatePythonCheckerSource } from "./python-checker.js";
import { buildCertifiedWindowsCppCheckerArgs } from "../toolchains/cpp-certification-policy.js";
import type { ResolvedToolchain } from "../toolchains/types.js";
import {
  isWindowsCppExecutionReady,
  normalizeCompilerError,
  resolveCompilationToolchain,
  runCompilerPipelineWithLimits,
  safeName,
  type CompileLimits,
} from "./compiler.js";

declare const __JUDGEDESK_TESTLIB__: string;

// A freshly installed Full distribution can still be under antivirus scan when
// the first static C++ checker is compiled. This watchdog is not a contestant
// runtime limit; keep it bounded but leave enough headroom for modest school
// hardware and cold managed-toolchain files.
export const CHECKER_COMPILE_TIMEOUT_MS = 60_000;
export const CHECKER_COMPILE_MEMORY_LIMIT_BYTES = 768 * 1024 * 1024;

export const CHECKER_COMPILE_LIMITS: CompileLimits = {
  timeoutMs: CHECKER_COMPILE_TIMEOUT_MS,
  maxGeneratedFileBytes: 32 * 1024 * 1024,
  memoryBytes: CHECKER_COMPILE_MEMORY_LIMIT_BYTES,
};

export interface CompiledChecker {
  path: string | null;
  runtime?: "native" | "python";
  pythonExecutablePath?: string;
  pythonToolchain?: Readonly<ResolvedToolchain>;
  error?: string;
}

export interface ResolveCheckerOptions {
  checkerType: string;
  problemName: string;
  problemDirectory: string;
  tempDirectory: string;
  jobId?: string;
  cppToolchain?: ResolvedToolchain;
  pythonToolchain?: ResolvedToolchain;
}

export function getBundledTestlibSource(): string {
  if (typeof __JUDGEDESK_TESTLIB__ !== "undefined" && __JUDGEDESK_TESTLIB__.length > 0) return __JUDGEDESK_TESTLIB__;
  const developmentPath = path.join(process.cwd(), "judgers", "testlib.h");
  if (fs.existsSync(developmentPath)) return fs.readFileSync(developmentPath, "utf8");
  throw new Error("Bundled testlib.h was not found.");
}

export function buildCustomCheckerCompilerArgs(
  platform: NodeJS.Platform,
  includeDirectory: string,
  sourcePath: string,
  outputPath: string,
): string[] {
  if (platform === "win32") {
    return buildCertifiedWindowsCppCheckerArgs(
      includeDirectory,
      sourcePath,
      outputPath,
    );
  }
  const args = ["-std=c++14", "-pipe", "-O2", "-I", includeDirectory];
  if (platform !== "darwin") args.push("-s", "-static", "-lm");
  args.push("-x", "c++");
  args.push(sourcePath, "-o", outputPath);
  return args;
}

const HEADER_EXTENSIONS = new Set([".h", ".hpp", ".hxx", ".hh", ".inc", ".inl", ".tpp"]);

export function stageProblemHeaders(
  problemDirectory: string,
  targetDirectory: string,
): void {
  try {
    const entries = fs.readdirSync(problemDirectory);
    for (const entry of entries) {
      const ext = path.extname(entry).toLowerCase();
      if (HEADER_EXTENSIONS.has(ext)) {
        const sourcePath = path.join(problemDirectory, entry);
        try {
          if (fs.statSync(sourcePath).isFile()) {
            fs.copyFileSync(sourcePath, path.join(targetDirectory, entry));
          }
        } catch {}
      }
    }
  } catch {}
}

export async function compileCustomChecker(
  checkerType: string,
  problemName: string,
  problemDirectory: string,
  tempDirectory: string,
  jobId?: string,
  pinnedCppToolchain?: ResolvedToolchain,
): Promise<CompiledChecker> {
  const checkerSourcePath = path.join(problemDirectory, checkerType);
  if (!fs.existsSync(checkerSourcePath)) return { path: null, error: `Custom checker ${checkerType} not found.` };
  const checkerBinaryPath = path.join(tempDirectory, `checker_${safeName(problemName)}_${safeName(checkerType)}.out`);
  const checkerSupportDirectory = path.join(tempDirectory, `checker-support-${crypto.randomUUID()}`);
  const bundledTestlibPath = path.join(checkerSupportDirectory, "testlib.h");
  try {
    fs.mkdirSync(checkerSupportDirectory, { recursive: true });
    fs.writeFileSync(bundledTestlibPath, getBundledTestlibSource(), "utf8");
    stageProblemHeaders(problemDirectory, checkerSupportDirectory);
    const cpp = pinnedCppToolchain ?? await resolveCompilationToolchain("cpp");
    if (!cpp.ready) return { path: null, error: "TOOLCHAIN_CPP_MISSING" };
    if (process.platform === "win32" && !isWindowsCppExecutionReady(cpp)) {
      return { path: null, error: "TOOLCHAIN_NOT_SANDBOX_COMPATIBLE" };
    }
    const compilerPath = cpp.executionPath || cpp.executablePath;
    await runCompilerPipelineWithLimits(
      compilerPath,
      buildCustomCheckerCompilerArgs(
        os.platform(),
        checkerSupportDirectory,
        checkerSourcePath,
        checkerBinaryPath,
      ),
      tempDirectory,
      checkerBinaryPath,
      jobId,
      CHECKER_COMPILE_LIMITS,
      "cpp",
      {},
      cpp,
    );
    return { path: checkerBinaryPath, runtime: "native" };
  } catch (error) {
    return { path: null, error: normalizeCompilerError(error) };
  } finally {
    fs.rmSync(checkerSupportDirectory, { recursive: true, force: true });
  }
}

export async function resolveChecker(options: ResolveCheckerOptions): Promise<CompiledChecker> {
  const { checkerType, problemName, problemDirectory, tempDirectory, jobId } = options;
  if (isBuiltInChecker(checkerType)) return { path: null };
  if (checkerType.toLowerCase().endsWith(".cpp")) {
    return compileCustomChecker(
      checkerType,
      problemName,
      problemDirectory,
      tempDirectory,
      jobId,
      options.cppToolchain,
    );
  }
  if (checkerType.toLowerCase().endsWith(".py")) {
    const checkerPath = path.join(problemDirectory, checkerType);
    if (!fs.existsSync(checkerPath)) {
      return { path: null, error: `Custom checker ${checkerType} not found.` };
    }
    const python = options.pythonToolchain ?? await resolveCompilationToolchain("python");
    if (!python.ready) {
      return {
        path: null,
        error: "CHECKER_TOOLCHAIN_UNAVAILABLE: cannot compile Python checker; Python is missing",
      };
    }
    if (python.source !== "managed" && !python.localToolchain) {
      return {
        path: null,
        error:
          "CHECKER_TOOLCHAIN_NOT_SANDBOX_COMPATIBLE: select a native-executor compatible Python runtime",
      };
    }
    try {
      const pythonExecutionPath = python.executionPath || python.executablePath;
      await validatePythonCheckerSource(
        pythonExecutionPath,
        checkerPath,
        python,
        jobId,
      );
      return {
        path: checkerPath,
        runtime: "python",
        pythonExecutablePath: pythonExecutionPath,
        pythonToolchain: python,
      };
    } catch (error) {
      return {
        path: null,
        error: `PYTHON_CHECKER_COMPILE_ERROR: ${normalizeCompilerError(error)}`,
      };
    }
  }
  if (checkerType.toLowerCase().endsWith(".exe")) {
    const checkerPath = path.join(problemDirectory, checkerType);
    if (!fs.existsSync(checkerPath)) {
      return { path: null, error: `Custom checker ${checkerType} not found.` };
    }
    if (process.platform === "win32") {
      return {
        path: checkerPath,
        runtime: "native",
      };
    }
    return {
      path: null,
      error: "Precompiled Windows .exe checkers are not executable on this platform. Please use a .cpp or .py checker.",
    };
  }
  return { path: null, error: `Unsupported checker type '${checkerType}'.` };
}
