import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { waitForToolchainDiscovery } from "../toolchains/discovery.js";
import { resolveNativeProtectedToolchain } from "../toolchains/resolver.js";
import { prepareManagedToolchainComponent } from "../executor/workspace.js";
import { ensureCertifiedLocalCppSessionProbe } from "./certified-local-session-probe.js";
import { compileSubmission, isWindowsNativeCompilerExecutionReady } from "./compiler.js";
import { createRunWorkspace } from "./run-workspace.js";
import { executorClient } from "../executor/client.js";
import { ensureUniversalCppPch } from "./universal-pch.js";
import type { ResolvedToolchain, ToolchainKind } from "../toolchains/types.js";

export function nativeCompilerKindsToPrewarm(
  requirements: ReadonlySet<ToolchainKind>,
): Array<Extract<ToolchainKind, "cpp" | "c">> {
  const nativeKinds: Array<Extract<ToolchainKind, "cpp" | "c">> = ["cpp", "c"];
  return nativeKinds.filter((kind) =>
    requirements.has(kind),
  );
}

const execFileAsync = promisify(execFile);

function findStdcxxBitsDir(packageRoot: string): string | null {
  const cxxDir = path.join(packageRoot, "include", "c++");
  if (!fs.existsSync(cxxDir)) return null;
  try {
    const entries = fs.readdirSync(cxxDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const versionDir = path.join(cxxDir, entry.name);
        const candidateArch = path.join(versionDir, "x86_64-w64-mingw32", "bits");
        if (fs.existsSync(path.join(candidateArch, "stdc++.h"))) {
          return candidateArch;
        }
        const candidateDirect = path.join(versionDir, "bits");
        if (fs.existsSync(path.join(candidateDirect, "stdc++.h"))) {
          return candidateDirect;
        }
      }
    }
  } catch {}
  return null;
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

async function ensureStdcxxPch(packageRoot: string, gccPath: string): Promise<void> {
  const bitsDir = findStdcxxBitsDir(packageRoot);
  if (!bitsDir) return;
  const headerPath = path.join(bitsDir, "stdc++.h");
  const gchPath = path.join(bitsDir, "stdc++.h.gch");
  if (fs.existsSync(gchPath)) return;

  try {
    const started = performance.now();
    await execFileAsync(
      gccPath,
      ["-std=c++14", "-O2", "-pipe", "-x", "c++-header", headerPath, "-o", gchPath],
      {
        windowsHide: true,
        timeout: 25_000,
        env: {
          ...process.env,
          TMPDIR: bitsDir,
        },
      },
    );
    console.info(`[Judge Pre-warm] Generated stdc++.h.gch in ${(performance.now() - started).toFixed(1)} ms`);
  } catch (error) {
    console.warn("[Judge Pre-warm] PCH generation skipped:", error instanceof Error ? error.message : String(error));
  }
}

export type PrewarmOutcome =
  | { status: "completed" }
  | { status: "deferred"; reason: string };

export interface PrewarmDependencies {
  waitForToolchainDiscovery?: typeof waitForToolchainDiscovery;
  resolveNativeProtectedToolchain?: typeof resolveNativeProtectedToolchain;
  ensureUniversalCppPch?: typeof ensureUniversalCppPch;
  compileSubmission?: typeof compileSubmission;
}

let prewarmPromise: Promise<PrewarmOutcome> | null = null;

export async function executeJudgePrewarm(
  dependencies?: PrewarmDependencies,
): Promise<PrewarmOutcome> {
  const waitDiscovery = dependencies?.waitForToolchainDiscovery ?? waitForToolchainDiscovery;
  const resolveToolchain = dependencies?.resolveNativeProtectedToolchain ?? resolveNativeProtectedToolchain;
  const ensurePch = dependencies?.ensureUniversalCppPch ?? ensureUniversalCppPch;
  const compile = dependencies?.compileSubmission ?? compileSubmission;

  // 1. Wait for passive toolchain discovery to finish
  const discoverySnapshot = await waitDiscovery();
  if (!discoverySnapshot || discoverySnapshot.status === "failed") {
    console.warn("[Judge Pre-warm] Discovery not ready, deferring pre-warm.");
    return { status: "deferred", reason: "DISCOVERY_NOT_READY" };
  }

  // 2. Ensure native executor client is ready
  const health = await executorClient.start();
  if (!health.ready) {
    console.warn("[Judge Pre-warm] Executor not ready, deferring pre-warm.");
    return { status: "deferred", reason: "EXECUTOR_NOT_READY" };
  }

  const cpp = resolveToolchain("cpp");
  const c = resolveToolchain("c");
  if (!cpp.ready && !c.ready) {
    console.warn("[Judge Pre-warm] No native C/C++ toolchain is ready, deferring pre-warm.");
    return { status: "deferred", reason: "CPP_TOOLCHAIN_NOT_READY" };
  }

  const cppEligible = isPrewarmToolchainEligible("cpp", cpp);
  const cEligible = isPrewarmToolchainEligible("c", c);

  if (cppEligible) {
    // Universal Step: Ensure bits/stdc++.h PCH is generated and cached for C++.
    await ensurePch(cpp);

    // Managed GCC package preparation also authenticates and imports the shared C entrypoint.
    if (cpp.source === "managed") {
      const prepared = await prepareManagedToolchainComponent(
        "cpp",
        cpp,
        cpp.packageComponentId,
        "compiler",
      );

      if (cpp.packageRoot) {
        await ensureStdcxxPch(cpp.packageRoot, cpp.executablePath);
      }
      if (prepared.root && prepared.root !== cpp.packageRoot) {
        const bitsDir = findStdcxxBitsDir(prepared.root);
        if (bitsDir) {
          const destGch = path.join(bitsDir, "stdc++.h.gch");
          if (!fs.existsSync(destGch) && cpp.packageRoot) {
            const srcBitsDir = findStdcxxBitsDir(cpp.packageRoot);
            if (srcBitsDir) {
              const srcGch = path.join(srcBitsDir, "stdc++.h.gch");
              if (fs.existsSync(srcGch)) {
                try {
                  fs.copyFileSync(srcGch, destGch);
                } catch {}
              }
            }
          }
        }
      }
    }

    if (cpp.provenance === "certified-local" && cpp.certificateId && cpp.snapshotDigest) {
      const workspace = createRunWorkspace();
      try {
        await ensureCertifiedLocalCppSessionProbe(cpp, workspace.path);
        console.info("[Judge Pre-warm] Certified local C++ session probe ready.");
      } finally {
        workspace.dispose();
      }
    }

    const workspace = createRunWorkspace();
    try {
      const sourcePath = path.join(workspace.path, ".prewarm_noop.cpp");
      fs.writeFileSync(sourcePath, "int main(){return 0;}\n", "utf8");
      const compilation = await compile({
        language: "cpp",
        contestantName: "system_prewarm",
        problemName: "prewarm",
        submissionPath: sourcePath,
        tempDirectory: workspace.path,
        cppToolchain: cpp,
      });
      console.info(
        `[Judge Pre-warm] C++ warm-up probe completed in ${compilation.compileTime} ms (Status: ${compilation.compileStatus})`,
      );
    } finally {
      workspace.dispose();
    }
  }

  if (cEligible) {
    if (c.source === "managed") {
      await prepareManagedToolchainComponent("c", c, c.packageComponentId, "compiler");
    }
    const workspace = createRunWorkspace();
    try {
      const sourcePath = path.join(workspace.path, ".prewarm_noop.c");
      fs.writeFileSync(sourcePath, "int main(void){return 0;}\n", "utf8");
      const compilation = await compile({
        language: "c",
        contestantName: "system_prewarm",
        problemName: "prewarm",
        submissionPath: sourcePath,
        tempDirectory: workspace.path,
        cToolchain: c,
      });
      console.info(
        `[Judge Pre-warm] C warm-up probe completed in ${compilation.compileTime} ms (Status: ${compilation.compileStatus})`,
      );
    } finally {
      workspace.dispose();
    }
  }
  return { status: "completed" };
}

export function startBackgroundJudgePrewarm(
  force = false,
  dependencies?: PrewarmDependencies,
): Promise<PrewarmOutcome> {
  if (!prewarmPromise || force) {
    prewarmPromise = executeJudgePrewarm(dependencies);
  }
  return prewarmPromise;
}

export async function ensureJudgePrewarmReady(
  cppToolchain?: import("../toolchains/types.js").ResolvedToolchain,
  tempDirectory?: string,
  jobId?: string,
  dependencies?: PrewarmDependencies,
): Promise<void> {
  const active = startBackgroundJudgePrewarm(false, dependencies);
  await active;

  if (
    cppToolchain
    && cppToolchain.provenance === "certified-local"
    && tempDirectory
  ) {
    await ensureCertifiedLocalCppSessionProbe(cppToolchain, tempDirectory, jobId);
  }
}

export function resetJudgePrewarmStateForTests(): void {
  prewarmPromise = null;
}
