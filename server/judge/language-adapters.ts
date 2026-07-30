import path from "node:path";
import type { SubmissionLanguage } from "../types.js";
import type { ToolchainKind } from "../toolchains/types.js";
import { buildCertifiedWindowsCppSubmissionArgs } from "../toolchains/cpp-certification-policy.js";

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
  splitDarwinClangPhases: boolean;
  timeoutMs: number;
  maxGeneratedFileBytes: number;
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
      ),
      environment: {},
      splitDarwinClangPhases: platform === "darwin",
      timeoutMs: 15_000,
      maxGeneratedFileBytes: 32 * MIB,
    };
  }
  if (language === "pascal") {
    return {
      language,
      toolchainKind: "pascal",
      args: [
        "-O2",
        "-Xs",
        "-Sg",
        ...(platform === "win32" ? ["-Cs66060288"] : []),
        `-o${outputPath}`,
        sourcePath,
      ],
      environment: {},
      splitDarwinClangPhases: false,
      timeoutMs: 20_000,
      maxGeneratedFileBytes: 32 * MIB,
    };
  }
  if (language === "go") {
    return {
      language,
      toolchainKind: "go",
      args: [
        "build",
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
      splitDarwinClangPhases: false,
      timeoutMs: 30_000,
      maxGeneratedFileBytes: 64 * MIB,
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
    splitDarwinClangPhases: false,
    timeoutMs: 30_000,
    maxGeneratedFileBytes: 64 * MIB,
  };
}

export function buildCompilerAdapterEnvironment(
  kind: ToolchainKind,
  workspacePath: string,
): Record<string, string> {
  if (kind === "go") {
    return {
      GOCACHE: path.join(workspacePath, "go-cache"),
      GOMODCACHE: path.join(workspacePath, "go-mod-cache"),
    };
  }
  if (kind === "csharp") {
    return {
      DOTNET_CLI_HOME: path.join(workspacePath, "dotnet-home"),
      NUGET_PACKAGES: path.join(workspacePath, "nuget-packages"),
      DOTNET_CLI_TELEMETRY_OPTOUT: "1",
      DOTNET_NOLOGO: "1",
      DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
    };
  }
  return {};
}

function buildGnuOrAppleClangArgs(
  platform: NodeJS.Platform,
  sourcePath: string,
  outputPath: string,
  language: Extract<NativeCompiledLanguage, "cpp" | "c">,
): string[] {
  if (platform === "win32" && language === "cpp") {
    return buildCertifiedWindowsCppSubmissionArgs(sourcePath, outputPath);
  }
  const args = [
    language === "cpp" ? "-std=c++14" : "-std=c11",
    "-pipe",
    "-O2",
  ];
  if (language === "cpp") args.push("-fno-finite-loops");
  if (platform === "darwin") {
    args.push(
      "-fsanitize=integer-divide-by-zero",
      "-fsanitize-trap=integer-divide-by-zero",
    );
  } else {
    if (platform === "win32") {
      args.push(
        "-fsanitize=integer-divide-by-zero",
        "-fsanitize-undefined-trap-on-error",
      );
    }
    args.push("-s", "-static", "-lm");
  }
  args.push("-x", language === "cpp" ? "c++" : "c");
  if (platform === "win32") args.push("-Wl,--stack,66060288");
  args.push(sourcePath, "-o", outputPath);
  return args;
}
