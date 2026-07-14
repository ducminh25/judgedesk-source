import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { RESOURCE_ROOT } from "../runtime.js";
import { sandbox } from "../sandbox.js";
import type { ProblemResult } from "../types.js";
import { isStandardChecker } from "./standard-checkers.js";
import { resolveToolchain } from "../toolchains/resolver.js";

export interface CompiledChecker {
  path: string | null;
  error?: string;
}

interface ResolveCheckerOptions {
  checkerType: string;
  problemName: string;
  problemDirectory: string;
  tempDirectory: string;
}

interface CompileSubmissionOptions {
  language: string;
  contestantName: string;
  problemName: string;
  submissionPath: string;
  tempDirectory: string;
}

export interface CompilationResult {
  executablePath: string;
  compileStatus: ProblemResult["compileStatus"];
  compileError: string;
  compileTime: number;
}

export function resolveChecker({
  checkerType,
  problemName,
  problemDirectory,
  tempDirectory,
}: ResolveCheckerOptions): CompiledChecker {
  if (isStandardChecker(checkerType)) {
    return { path: null };
  }

  if (checkerType.toLowerCase().endsWith(".cpp")) {
    return compileCustomChecker(
      checkerType,
      problemName,
      problemDirectory,
      tempDirectory,
    );
  }

  if (checkerType.toLowerCase().endsWith(".exe")) {
    if (os.platform() !== "win32") {
      return {
        path: null,
        error: "Precompiled Windows checker executables cannot run on macOS.",
      };
    }
    const checkerPath = path.join(problemDirectory, checkerType);
    return fs.existsSync(checkerPath)
      ? { path: checkerPath }
      : { path: null, error: `Custom checker ${checkerType} not found.` };
  }

  return {
    path: null,
    error: `Unsupported checker type '${checkerType}'.`,
  };
}

export function compileSubmission({
  language,
  contestantName,
  problemName,
  submissionPath,
  tempDirectory,
}: CompileSubmissionOptions): CompilationResult {
  if (language !== "cpp") {
    const resolvedPy = resolveToolchain("python");
    if (!resolvedPy.ready) {
      return {
        executablePath: "",
        compileStatus: "CE",
        compileError: "TOOLCHAIN_PYTHON_MISSING",
        compileTime: 0,
      };
    }
    return {
      executablePath: resolvedPy.executablePath,
      compileStatus: "OK",
      compileError: "",
      compileTime: 0,
    };
  }

  const executablePath = path.join(
    tempDirectory,
    `${contestantName}_${problemName}.out`,
  );
  const compileStart = process.hrtime.bigint();
  try {
    if (sandbox.mode !== "none") {
      sandbox.runCommand([
        "cp",
        sandbox.toPath(submissionPath),
        "/tmp/compile.cpp",
      ]);
      const compileResult = sandbox.runCommand(
        [
          "g++",
          "-std=c++14",
          "-pipe",
          "-O2",
          "-s",
          "-static",
          "-lm",
          "-x",
          "c++",
          "/tmp/compile.cpp",
          "-o",
          "/tmp/compile.out",
        ],
        { stdio: "pipe" },
      );
      if (compileResult.status !== 0) {
        throw new Error(
          compileResult.stderr
            ? compileResult.stderr.toString()
            : "Compilation failed",
        );
      }
      sandbox.runCommand([
        "cp",
        "/tmp/compile.out",
        sandbox.toPath(executablePath),
      ]);
      sandbox.runCommand(["rm", "-f", "/tmp/compile.cpp", "/tmp/compile.out"]);
    } else {
      const resolvedCpp = resolveToolchain("cpp");
      if (!resolvedCpp.ready) {
        throw new Error("TOOLCHAIN_CPP_MISSING");
      }
      runCompiler(
        resolvedCpp.executablePath,
        buildSubmissionCompilerArgs(
          os.platform(),
          submissionPath,
          executablePath,
        ),
        tempDirectory,
      );
    }

    return {
      executablePath,
      compileStatus: "OK",
      compileError: "",
      compileTime: Number(process.hrtime.bigint() - compileStart) / 1_000_000,
    };
  } catch (error: any) {
    return {
      executablePath,
      compileStatus: "CE",
      compileError: error.stderr ? error.stderr.toString() : error.message,
      compileTime: 0,
    };
  }
}

function compileCustomChecker(
  checkerType: string,
  problemName: string,
  problemDirectory: string,
  tempDirectory: string,
): CompiledChecker {
  const checkerSourcePath = path.join(problemDirectory, checkerType);
  if (!fs.existsSync(checkerSourcePath)) {
    return { path: null, error: `Custom checker ${checkerType} not found.` };
  }

  const checkerBinaryPath = path.join(
    tempDirectory,
    `checker_${problemName}_${checkerType.replace(/\./g, "_")}.out`,
  );
  try {
    const bundledTestlibPath = path.join(RESOURCE_ROOT, "judgers", "testlib.h");
    if (!fs.existsSync(bundledTestlibPath)) {
      return { path: null, error: "Bundled testlib.h was not found." };
    }

    if (sandbox.mode !== "none") {
      sandbox.runCommand([
        "cp",
        sandbox.toPath(checkerSourcePath),
        "/tmp/checker.cpp",
      ]);
      sandbox.runCommand([
        "cp",
        sandbox.toPath(bundledTestlibPath),
        "/tmp/testlib.h",
      ]);
      const compileResult = sandbox.runCommand(
        [
          "g++",
          "-std=c++14",
          "-O2",
          "/tmp/checker.cpp",
          "-o",
          "/tmp/checker.out",
        ],
        { stdio: "ignore" },
      );
      if (compileResult.status !== 0)
        throw new Error("Checker compilation inside sandbox failed");
      sandbox.runCommand([
        "cp",
        "/tmp/checker.out",
        sandbox.toPath(checkerBinaryPath),
      ]);
      sandbox.runCommand([
        "rm",
        "-f",
        "/tmp/checker.cpp",
        "/tmp/checker.out",
        "/tmp/testlib.h",
      ]);
    } else {
      const resolvedCpp = resolveToolchain("cpp");
      if (!resolvedCpp.ready) {
        return { path: null, error: "TOOLCHAIN_CPP_MISSING" };
      }
      runCompiler(resolvedCpp.executablePath, [
        "-std=c++14",
        "-O2",
        "-I",
        path.dirname(bundledTestlibPath),
        checkerSourcePath,
        "-o",
        checkerBinaryPath,
      ]);
    }
    return { path: checkerBinaryPath };
  } catch (error: any) {
    return { path: null, error: error.message };
  }
}

export function buildSubmissionCompilerArgs(
  platform: NodeJS.Platform,
  sourcePath: string,
  outputPath: string,
): string[] {
  const args = ["-std=c++14", "-pipe", "-O2", "-s"];
  if (platform !== "darwin") args.push("-static");
  args.push("-lm", "-x", "c++");
  if (platform === "win32") args.push("-Wl,--stack,66060288");
  args.push(sourcePath, "-o", outputPath);
  return args;
}

function runCompiler(gppPath: string, args: string[], cwd?: string): void {
  const result = spawnSync(gppPath, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(result.stderr || "Compilation failed") as Error & {
      stderr?: string;
    };
    error.stderr = result.stderr;
    throw error;
  }
}
