import type { ResolvedToolchain } from "../toolchains/types.js";
import {
  isManagedSubmissionToolchainReady,
  isPythonCheckerReady,
  isPythonSubmissionReady,
} from "../toolchains/resolver.js";
import { isWindowsCppExecutionReady } from "./compiler.js";

export interface JudgeToolchainRequirements {
  cppSubmission: boolean;
  cSubmission: boolean;
  pythonSubmission: boolean;
  cppChecker: boolean;
  pythonChecker: boolean;
}

export interface PinnedJudgeToolchains {
  cpp: Readonly<ResolvedToolchain>;
  c: Readonly<ResolvedToolchain>;
  python: Readonly<ResolvedToolchain>;
}

function cppReady(toolchain: Readonly<ResolvedToolchain>, platform: NodeJS.Platform): boolean {
  return toolchain.ready
    && toolchain.kind === "cpp"
    && (platform !== "win32" || isWindowsCppExecutionReady(toolchain));
}

function diagnostic(toolchain: Readonly<ResolvedToolchain>): string {
  return toolchain.diagnosticCode
    || toolchain.diagnostic
    || "compiler/runtime is not ready";
}

export function assertJudgeToolchainPreflight(
  requirements: Readonly<JudgeToolchainRequirements>,
  toolchains: Readonly<PinnedJudgeToolchains>,
  platform: NodeJS.Platform = process.platform,
): void {
  const failures: string[] = [];
  const cppRoles = [
    requirements.cppSubmission ? "C++ submissions" : "",
    requirements.cppChecker ? "C++ checkers" : "",
  ].filter(Boolean);
  if (cppRoles.length > 0 && !cppReady(toolchains.cpp, platform)) {
    failures.push(`${cppRoles.join(" and ")}: ${diagnostic(toolchains.cpp)}`);
  }
  if (
    requirements.cSubmission
    && !(
      toolchains.c.kind === "c"
      && (
        isManagedSubmissionToolchainReady(toolchains.c)
        || (
          platform === "darwin"
          && toolchains.c.ready
          && toolchains.c.provenance === "platform-certified"
        )
      )
    )
  ) {
    failures.push(`C submissions: ${diagnostic(toolchains.c)}`);
  }

  if (requirements.pythonSubmission && !isPythonSubmissionReady(toolchains.python)) {
    failures.push(`Python submissions: ${diagnostic(toolchains.python)}`);
  }
  if (requirements.pythonChecker && !isPythonCheckerReady(toolchains.python)) {
    failures.push(`Python checkers: ${diagnostic(toolchains.python)}`);
  }

  if (failures.length > 0) {
    throw new Error(`TOOLCHAIN_PREFLIGHT_FAILED: ${failures.join("; ")}`);
  }
}
