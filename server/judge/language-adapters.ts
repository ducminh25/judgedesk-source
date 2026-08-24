import fs from "node:fs";
import path from "node:path";
import { getCompileFlags } from "../../shared/compile-config.js";
import type { ProblemCompileConfig, SubmissionLanguage } from "../types.js";
import type { ToolchainKind } from "../toolchains/types.js";

export type NativeCompiledLanguage =
  | "cpp"
  | "c"
  | "pascal"
  | "go"
  | "rust";

export interface NativeCompilationRecipe {
  language: NativeCompiledLanguage;
  toolchainKind: ToolchainKind;
  args: string[];
  environment: Record<string, string>;
  splitCompilerPhases: boolean;
  timeoutMs: number;
  maxGeneratedFileBytes: number;
  maxWorkspaceWriteBytes?: number;
  maxCreatedFiles?: number;
}

const MIB = 1024 * 1024;

export function isNativeCompiledLanguage(
  language: SubmissionLanguage,
): language is NativeCompiledLanguage {
  return language === "cpp"
    || language === "c"
    || language === "pascal"
    || language === "go"
    || language === "rust";
}

export function buildNativeCompilationRecipe(
  language: NativeCompiledLanguage,
  platform: NodeJS.Platform,
  sourcePath: string,
  outputPath: string,
  compileConfig?: ProblemCompileConfig,
): NativeCompilationRecipe {
  if (language === "cpp" || language === "c") {
    return {
      language,
      toolchainKind: language,
      args: buildGnuOrAppleClangArgs(
        platform,
        sourcePath,
        outputPath,
        language,
        compileConfig,
      ),
      environment: {},
      // Windows MinGW GCC needs an explicit object path to prevent GCC's legacy
      // temp-path conversion from attempting to write an intermediate object at
      // the drive root. macOS Apple Clang compiles and links in a single unified step.
      splitCompilerPhases: platform === "win32",
      timeoutMs: 60_000,
      maxGeneratedFileBytes: 32 * MIB,
    };
  }
  if (language === "pascal") {
    return {
      language,
      toolchainKind: "pascal",
      args: [
        "-O2",
        "-XS",
        "-Sg",
        // Windows AppContainer maps system DLLs at randomized addresses. FPC
        // otherwise emits a fixed-base executable with stripped relocations,
        // which Windows rejects with ERROR_ILLEGAL_DLL_RELOCATION (623).
        ...(platform === "win32" ? ["-WR"] : []),
        // Keep the relocation table but strip linker symbols. Besides matching
        // a release build, this avoids a recurring Microsoft Defender ML false
        // positive on small FPC executables that use -WR.
        ...(platform === "win32" ? ["-Xs"] : []),
        ...(platform === "win32" ? ["-Cs66060288"] : []),
        `-o${outputPath}`,
        sourcePath,
      ],
      environment: {},
      splitCompilerPhases: false,
      // FPC itself is fast, but its first managed invocation can overlap the
      // installer/antivirus scan on lower-end classroom machines.
      timeoutMs: 45_000,
      maxGeneratedFileBytes: 32 * MIB,
    };
  }
  if (language === "go") {
    return {
      language,
      toolchainKind: "go",
      args: [
        "build",
        "-p=4",
        "-trimpath",
        "-buildvcs=false",
        "-ldflags=-s -w",
        "-o",
        outputPath,
        sourcePath,
      ],
      environment: {
        CGO_ENABLED: "0",
        GO111MODULE: "off",
        GOTOOLCHAIN: "local",
      },
      splitCompilerPhases: false,
      // A cold, isolated standard-library cache is intentional. The larger
      // watchdog avoids rejecting a healthy first compile on modest hardware;
      // it is a compiler limit, not the contestant's runtime limit.
      timeoutMs: 60_000,
      maxGeneratedFileBytes: 64 * MIB,
      // Go 1.26 compiles portions of its standard library into GOCACHE on the
      // first isolated build. Bound that ephemeral cache independently from
      // the much smaller executable artifact.
      maxWorkspaceWriteBytes: 256 * MIB,
      maxCreatedFiles: 4_096,
    };
  }
  return {
    language,
    toolchainKind: "rust",
    args: [
      "--edition=2021",
      "-C",
      "opt-level=2",
      "-C",
      "debuginfo=0",
      "-C",
      "strip=symbols",
      sourcePath,
      "-o",
      outputPath,
    ],
    environment: {
      RUST_BACKTRACE: "0",
    },
    splitCompilerPhases: false,
    timeoutMs: 30_000,
    maxGeneratedFileBytes: 64 * MIB,
  };
}

export function buildCompilerAdapterEnvironment(
  kind: ToolchainKind,
  workspacePath: string,
  toolchainRoot?: string,
  executablePath?: string,
): Record<string, string> {
  if (kind === "go") {
    return {
      GOCACHE: path.join(workspacePath, "go-cache"),
      GOMODCACHE: path.join(workspacePath, "go-mod-cache"),
      GOTMPDIR: path.join(workspacePath, "go-tmp"),
      GOMAXPROCS: "4",
      ...(toolchainRoot ? { GOROOT: toolchainRoot } : {}),
      ...(executablePath ? { PATH: path.dirname(executablePath) } : {}),
    };
  }
  if (kind === "java") {
    return {
      ...(toolchainRoot ? { JAVA_HOME: toolchainRoot } : {}),
      ...(executablePath ? { PATH: path.dirname(executablePath) } : {}),
    };
  }
  if (kind === "rust") {
    return {
      ...(executablePath ? { PATH: path.dirname(executablePath) } : {}),
    };
  }
  if (kind === "csharp") {
    return {
      DOTNET_CLI_HOME: path.join(workspacePath, "dotnet-home"),
      NUGET_PACKAGES: path.join(workspacePath, "nuget-packages"),
      DOTNET_CLI_TELEMETRY_OPTOUT: "1",
      DOTNET_NOLOGO: "1",
      DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
      DOTNET_MULTILEVEL_LOOKUP: "0",
      MSBUILDDISABLENODEREUSE: "1",
      ...(toolchainRoot ? { DOTNET_ROOT: toolchainRoot } : {}),
      ...(executablePath ? { PATH: path.dirname(executablePath) } : {}),
    };
  }
  return {};
}

export function buildJavaCompilationArgs(
  sourcePath: string,
  outputDirectory: string,
): string[] {
  // Themis invokes javac with only the source file. JudgeDesk additionally
  // directs class artifacts into its protected output directory so they can
  // be validated and moved atomically without exposing compiler work files.
  return ["-d", outputDirectory, sourcePath];
}

export function resolveJavaSubmissionStaging(
  submissionPath: string,
  fallbackBaseName?: string,
): {
  stagedSourceName: string;
  entrypointCandidate: string;
} {
  const fallback = fallbackBaseName
    || path.basename(submissionPath, path.extname(submissionPath))
    || "Main";

  try {
    const rawContent = fs.readFileSync(submissionPath, "utf8");
    const stripped = rawContent
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/.*$/gm, " ")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""');

    const publicClassMatch = stripped.match(
      /\bpublic\s+(?:final\s+|abstract\s+|sealed\s+|non-sealed\s+)*(?:class|interface|enum|record)\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
    );
    if (publicClassMatch && publicClassMatch[1]) {
      const publicName = publicClassMatch[1];
      return {
        stagedSourceName: `${publicName}.java`,
        entrypointCandidate: publicName,
      };
    }

    const mainClassMatch = stripped.match(
      /\b(?:class|record)\s+(Main)\b/,
    );
    if (mainClassMatch && mainClassMatch[1]) {
      return {
        stagedSourceName: `${fallback}.java`,
        entrypointCandidate: "Main",
      };
    }
  } catch {
    // Fallback if unreadable
  }

  return {
    stagedSourceName: `${fallback}.java`,
    entrypointCandidate: fallback,
  };
}

export function buildManagedPascalSupportArgs(
  platform: NodeJS.Platform,
  toolchainRoot: string,
): string[] {
  const binDirectory = path.join(toolchainRoot, "bin");
  const target = platform === "win32"
    ? "x86_64-win64"
    : "aarch64-darwin";
  return [
    "-n",
    platform === "win32" ? "-Px86_64" : "-Paarch64",
    platform === "win32" ? "-Twin64" : "-Tdarwin",
    `-Fu${path.join(toolchainRoot, "units", target, "*")}`,
    `-Fu${path.join(toolchainRoot, "units", target, "rtl")}`,
    ...(platform === "win32" ? [`-FD${binDirectory}`, "-XPx86_64-win64-"] : []),
  ];
}

function buildGnuOrAppleClangArgs(
  platform: NodeJS.Platform,
  sourcePath: string,
  outputPath: string,
  language: Extract<NativeCompiledLanguage, "cpp" | "c">,
  compileConfig?: ProblemCompileConfig,
): string[] {
  const args = getCompileFlags(compileConfig, language);
  if (platform === "darwin") {
    // Apple Clang cannot link the static/stack/math flags below. The protected
    // bits/stdc++.h compatibility include is injected by prepareCompiler.
  } else {
    args.push("-static");
  }
  args.push("-x", language === "cpp" ? "c++" : "c");
  if (platform === "win32") args.push("-Wl,--stack,66060288");
  args.push(sourcePath, "-o", outputPath);
  // Static-library order matters: keep libm after the source/object and only
  // add it for C. C++ drivers supply their standard math dependencies, while
  // macOS provides libm through libSystem.
  if (platform !== "darwin" && language === "c") args.push("-lm");
  return args;
}
