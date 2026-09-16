import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { waitForToolchainDiscovery } from "../toolchains/discovery.js";
import { resolveNativeProtectedToolchain } from "../toolchains/resolver.js";
import { prepareManagedToolchainComponent } from "../executor/workspace.js";
import { ensureCertifiedLocalCppSessionProbe } from "./certified-local-session-probe.js";
import { compileSubmission } from "./compiler.js";
import { createRunWorkspace } from "./run-workspace.js";
import { executorClient } from "../executor/client.js";
import { ensureUniversalCppPch } from "./universal-pch.js";

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

let prewarmPromise: Promise<void> | null = null;

async function executeJudgePrewarm(): Promise<void> {
  try {
    // 1. Wait for passive toolchain discovery to finish
    await waitForToolchainDiscovery();

    // 2. Ensure native executor client is ready
    const health = await executorClient.start();
    if (!health.ready) {
      console.warn("[Judge Pre-warm] Executor not ready, deferring pre-warm.");
      return;
    }

    const cpp = resolveNativeProtectedToolchain("cpp");
    if (!cpp.ready) {
      console.warn("[Judge Pre-warm] C++ toolchain not ready, deferring pre-warm.");
      return;
    }

    // Universal Step: Ensure bits/stdc++.h PCH is generated and cached for any ready C++ toolchain
    await ensureUniversalCppPch(cpp);

    // Case A: Managed GCC package (Standard on Windows)
    if (cpp.source === "managed") {
      const prepared = await prepareManagedToolchainComponent(
        "cpp",
        cpp,
        cpp.packageComponentId,
        "compiler",
      );

      // Ensure PCH is available in the root and destination
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

    // Case B: Certified Local C++ (MinGW/Clang local path)
    if (cpp.provenance === "certified-local" && cpp.certificateId && cpp.snapshotDigest) {
      const workspace = createRunWorkspace();
      try {
        await ensureCertifiedLocalCppSessionProbe(cpp, workspace.path);
        console.info("[Judge Pre-warm] Certified local C++ session probe ready.");
      } finally {
        workspace.dispose();
      }
    }

    // Warm-up no-op compilation probe for all ready C++ toolchains (managed, local, or certified)
    const workspace = createRunWorkspace();
    try {
      const sourcePath = path.join(workspace.path, ".prewarm_noop.cpp");
      fs.writeFileSync(sourcePath, "int main(){return 0;}\n", "utf8");
      const compilation = await compileSubmission({
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
  } catch (error) {
    console.warn("[Judge Pre-warm] Background pre-warm error:", error instanceof Error ? error.message : String(error));
  }
}

export function startBackgroundJudgePrewarm(force = false): Promise<void> {
  if (!prewarmPromise || force) {
    prewarmPromise = executeJudgePrewarm();
  }
  return prewarmPromise;
}

export async function ensureJudgePrewarmReady(
  cppToolchain?: import("../toolchains/types.js").ResolvedToolchain,
  tempDirectory?: string,
  jobId?: string,
): Promise<void> {
  const active = startBackgroundJudgePrewarm();
  try {
    await active;
  } catch (error) {
    console.warn("[Judge Pre-warm] ensureJudgePrewarmReady deferral:", error);
  }

  if (
    cppToolchain
    && cppToolchain.provenance === "certified-local"
    && tempDirectory
  ) {
    await ensureCertifiedLocalCppSessionProbe(cppToolchain, tempDirectory, jobId);
  }
}
