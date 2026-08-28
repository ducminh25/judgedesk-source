import type {
  ResolvedToolchain,
  ToolchainKind,
} from "../toolchains/types.js";
import {
  isManagedSubmissionToolchainReady,
  isPythonCheckerReady,
  isPythonSubmissionReady,
} from "../toolchains/resolver.js";
import {
  isWindowsCppExecutionReady,
  isWindowsNativeCompilerExecutionReady,
} from "./compiler.js";

export interface JudgeToolchainRequirements {
  submissions: Set<ToolchainKind>;
  checkers: Set<ToolchainKind>;
}

export type PinnedJudgeToolchains = Readonly<
  Record<ToolchainKind, Readonly<ResolvedToolchain>>
>;

const LANGUAGE_LABELS: Readonly<Record<ToolchainKind, string>> = {
  cpp: "C++",
  c: "C",
  python: "Python",
  pascal: "Pascal",
  go: "Go",
  java: "Java",
  rust: "Rust",
  javascript: "JavaScript",
  csharp: "C#",
  scratch: "Scratch",
};

function cppReady(
  toolchain: Readonly<ResolvedToolchain>,
  platform: NodeJS.Platform,
): boolean {
  return toolchain.ready
    && toolchain.kind === "cpp"
    && (platform !== "win32" || isWindowsCppExecutionReady(toolchain));
}

function cReady(
  toolchain: Readonly<ResolvedToolchain>,
  platform: NodeJS.Platform,
): boolean {
  return toolchain.kind === "c"
    && toolchain.ready
    && (platform !== "win32" || isWindowsNativeCompilerExecutionReady(toolchain));
}

function submissionReady(
  kind: ToolchainKind,
  toolchain: Readonly<ResolvedToolchain>,
  platform: NodeJS.Platform,
): boolean {
  if (kind === "cpp") return cppReady(toolchain, platform);
  if (kind === "c") return cReady(toolchain, platform);
  if (kind === "python") return isPythonSubmissionReady(toolchain);
  return toolchain.kind === kind
    && isManagedSubmissionToolchainReady(toolchain);
}

function checkerReady(
  kind: ToolchainKind,
  toolchain: Readonly<ResolvedToolchain>,
  platform: NodeJS.Platform,
): boolean {
  if (kind === "cpp") return cppReady(toolchain, platform);
  if (kind === "python") return isPythonCheckerReady(toolchain);
  return false;
}

function diagnostic(toolchain: Readonly<ResolvedToolchain>): string {
  return toolchain.diagnosticCode
    || toolchain.diagnostic
    || "compiler/runtime is not ready";
}

export function assertJudgeToolchainPreflight(
  requirements: Readonly<JudgeToolchainRequirements>,
  toolchains: PinnedJudgeToolchains,
  platform: NodeJS.Platform = process.platform,
): void {
  const failures: string[] = [];
  for (const kind of requirements.submissions) {
    const toolchain = toolchains[kind];
    if (!submissionReady(kind, toolchain, platform)) {
      failures.push(
        `${LANGUAGE_LABELS[kind]} submissions: ${diagnostic(toolchain)}`,
      );
    }
  }
  for (const kind of requirements.checkers) {
    const toolchain = toolchains[kind];
    if (!checkerReady(kind, toolchain, platform)) {
      failures.push(
        `${LANGUAGE_LABELS[kind]} checkers: ${diagnostic(toolchain)}`,
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(`TOOLCHAIN_PREFLIGHT_FAILED: ${failures.join("; ")}`);
  }
}
