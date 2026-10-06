import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { waitForToolchainDiscovery } from "../toolchains/discovery.js";
import { resolveNativeProtectedToolchain } from "../toolchains/resolver.js";
import { prepareManagedToolchainComponent } from "../executor/workspace.js";
import { ensureCertifiedLocalCppSessionProbe } from "./certified-local-session-probe.js";
import {
  compileSubmission,
  ensureManagedCCompilerWarmup,
  isWindowsNativeCompilerExecutionReady,
  requiresManagedCCompilerWarmup,
} from "./compiler.js";
import { createRunWorkspace } from "./run-workspace.js";
import { executorClient } from "../executor/client.js";
import { ensureUniversalCppPch } from "./universal-pch.js";
import type { ResolvedToolchain, ToolchainKind } from "../toolchains/types.js";
import { measureDiagnosticPhase } from "../diagnostics.js";

export function nativeCompilerKindsToPrewarm(
  requirements: ReadonlySet<ToolchainKind>,
): Array<Extract<ToolchainKind, "cpp" | "c">> {
  const nativeKinds: Array<Extract<ToolchainKind, "cpp" | "c">> = ["cpp", "c"];
  return nativeKinds.filter((kind) =>
    requirements.has(kind),
  );
}

function isPrewarmToolchainEligible(
  kind: Extract<ToolchainKind, "cpp" | "c">,
  toolchain: Readonly<ResolvedToolchain>,
): boolean {
  if (!toolchain.ready) return false;
  if (process.platform === "win32" && !isWindowsNativeCompilerExecutionReady(toolchain)) {
    console.warn(`[Judge Pre-warm] ${kind.toUpperCase()} toolchain is not execution ready; skipping.`);
    return false;
  }
  if (toolchain.source === "managed" && process.platform === "win32" && toolchain.packageOrigin !== "built-in") {
    try {
      const managedRoot = path.resolve(process.env.LOCALAPPDATA || "", "ThemisV2", "toolchains");
      const canonical = fs.realpathSync(toolchain.executablePath);
      const rel = path.relative(managedRoot, canonical);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        console.warn(`[Judge Pre-warm] Managed ${kind.toUpperCase()} toolchain is outside sandbox root; skipping.`);
        return false;
      }
    } catch {
      console.warn(`[Judge Pre-warm] Failed to resolve managed ${kind.toUpperCase()} toolchain path; skipping.`);
      return false;
    }
  }
  return true;
}

export type PrewarmOutcome =
  | { status: "completed" }
  | { status: "deferred"; reason: string };

export interface PrewarmDependencies {
  waitForToolchainDiscovery?: typeof waitForToolchainDiscovery;
  resolveNativeProtectedToolchain?: typeof resolveNativeProtectedToolchain;
  ensureUniversalCppPch?: typeof ensureUniversalCppPch;
  prepareManagedToolchainComponent?: (...args: Parameters<typeof prepareManagedToolchainComponent>) => Promise<unknown>;
  ensureManagedCCompilerWarmup?: typeof ensureManagedCCompilerWarmup;
  // Retain the injected hook for callers; readiness no longer compiles a generic submission.
  compileSubmission?: typeof compileSubmission;
}

type NativeCompilerKind = Extract<ToolchainKind, "cpp" | "c">;
const prewarmPromises = new Map<NativeCompilerKind, Promise<PrewarmOutcome>>();
let prewarmQueue: Promise<void> = Promise.resolve();

export async function executeJudgePrewarm(
  dependencies?: PrewarmDependencies,
  kinds: readonly NativeCompilerKind[] = ["cpp"],
): Promise<PrewarmOutcome> {
  if (kinds.length === 0) return { status: "completed" };
  const waitDiscovery = dependencies?.waitForToolchainDiscovery ?? waitForToolchainDiscovery;
  const resolveToolchain = dependencies?.resolveNativeProtectedToolchain ?? resolveNativeProtectedToolchain;
  const ensurePch = dependencies?.ensureUniversalCppPch ?? ensureUniversalCppPch;
  const prepare = dependencies?.prepareManagedToolchainComponent ?? prepareManagedToolchainComponent;
  const warmManagedC = dependencies?.ensureManagedCCompilerWarmup ?? ensureManagedCCompilerWarmup;
  const prewarmId = `prewarm_${crypto.randomUUID()}`;
  const measure = <T>(phase: string, operation: () => Promise<T>) =>
    measureDiagnosticPhase({ phase, prewarmId, kinds: kinds.join(",") }, operation);

  // 1. Wait for passive toolchain discovery to finish
  const discoverySnapshot = await measure("prewarm-discovery", waitDiscovery);
  if (!discoverySnapshot || discoverySnapshot.status === "failed") {
    console.warn("[Judge Pre-warm] Discovery not ready, deferring pre-warm.");
    return { status: "deferred", reason: "DISCOVERY_NOT_READY" };
  }

  // 2. Ensure native executor client is ready
  const health = await measure("prewarm-executor-start", () => executorClient.start());
  if (!health.ready) {
    console.warn("[Judge Pre-warm] Executor not ready, deferring pre-warm.");
    return { status: "deferred", reason: "EXECUTOR_NOT_READY" };
  }

  const cpp = kinds.includes("cpp") ? resolveToolchain("cpp") : undefined;
  const c = kinds.includes("c") ? resolveToolchain("c") : undefined;
  if (!cpp?.ready && !c?.ready) {
    console.warn("[Judge Pre-warm] No native C/C++ toolchain is ready, deferring pre-warm.");
    return { status: "deferred", reason: "CPP_TOOLCHAIN_NOT_READY" };
  }

  const cppEligible = cpp && isPrewarmToolchainEligible("cpp", cpp);
  const cEligible = c && isPrewarmToolchainEligible("c", c);

  if (cpp && cppEligible) {
    // Universal Step: Ensure bits/stdc++.h PCH is generated and cached for C++.
    if (process.platform !== "darwin") {
      await measure("prewarm-pch", () => ensurePch(cpp));
    }

    // Managed GCC package preparation also authenticates and imports the shared C entrypoint.
    if (cpp.source === "managed") {
      await measure("prewarm-cpp-prepare", () => prepare(
        "cpp",
        cpp,
        cpp.packageComponentId,
        "compiler",
      ));
    }

    if (cpp.provenance === "certified-local" && cpp.certificateId && cpp.snapshotDigest) {
      const workspace = createRunWorkspace();
      try {
        await measure("prewarm-certified-cpp-probe", () => ensureCertifiedLocalCppSessionProbe(cpp, workspace.path));
        console.info("[Judge Pre-warm] Certified local C++ session probe ready.");
      } finally {
        workspace.dispose();
      }
    }

    // The real compilation repeats the same verified import and sandbox setup.
    // A generic no-op compile/link adds latency without validating its status.
  }

  if (c && cEligible) {
    if (c.source === "managed") {
      await measure("prewarm-c-prepare", () => prepare("c", c, c.packageComponentId, "compiler"));
    }
    if (requiresManagedCCompilerWarmup(process.platform, "c", c)) {
      try {
        // Seed the same compatibility cache as the real C compiler, using its
        // selected identity rather than the executor's prepared copy path.
        await measure("prewarm-managed-c-compatibility", () => warmManagedC(c, c.executionPath || c.executablePath));
      } catch {
        // compileSubmission previously converted this optional attempt into an
        // CE result. Keep readiness usable; actual C compilation must retry.
        console.warn("[Judge Pre-warm] Managed C warm-up deferred; submission compilation will retry.");
      }
    }
  }
  return { status: "completed" };
}

export async function startBackgroundJudgePrewarm(
  force = false,
  dependencies?: PrewarmDependencies,
  kinds: readonly NativeCompilerKind[] = ["cpp"],
): Promise<PrewarmOutcome> {
  // Toolchain refresh invalidates every kind, including on-demand C probes.
  if (force) prewarmPromises.clear();
  const pending = kinds.map((kind) => {
    let promise = prewarmPromises.get(kind);
    if (!promise) {
      // Keep native compiler probes sequential and within the memory budget.
      promise = prewarmQueue.then(() => executeJudgePrewarm(dependencies, [kind]));
      // The original promise retains its error for callers and lifecycle drain.
      prewarmQueue = promise.then(() => undefined, () => undefined);
      prewarmPromises.set(kind, promise);
    }
    return promise;
  });
  // Retain ownership of all probes until they finish, even when one fails.
  const outcomes = await Promise.allSettled(pending);
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") throw outcome.reason;
  }
  for (const outcome of outcomes) {
    if (outcome.status === "fulfilled" && outcome.value.status === "deferred") {
      return outcome.value;
    }
  }
  return { status: "completed" };
}

export async function ensureJudgePrewarmReady(
  cppToolchain?: import("../toolchains/types.js").ResolvedToolchain,
  tempDirectory?: string,
  jobId?: string,
  dependencies?: PrewarmDependencies,
  kinds: readonly NativeCompilerKind[] = ["cpp"],
): Promise<void> {
  const active = startBackgroundJudgePrewarm(false, dependencies, kinds);
  await measureDiagnosticPhase({ phase: "judge-prewarm-wait", jobId }, () => active);

  if (
    kinds.includes("cpp")
    && cppToolchain
    && cppToolchain.provenance === "certified-local"
    && tempDirectory
  ) {
    await ensureCertifiedLocalCppSessionProbe(cppToolchain, tempDirectory, jobId);
  }
}

export function resetJudgePrewarmStateForTests(): void {
  prewarmPromises.clear();
  prewarmQueue = Promise.resolve();
}
