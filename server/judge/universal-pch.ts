import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getAppDataDir } from "../toolchains/storage.js";
import { RESOURCE_ROOT } from "../runtime.js";
import type { ResolvedToolchain } from "../toolchains/types.js";
import { getExecutableVersion } from "../toolchains/resolver.js";
import { runCompilerWithLimits } from "./compiler.js";
import { getCompileFlags } from "../../shared/compile-config.js";
import type { ExecutorWorkspace } from "../executor/workspace.js";

export function computeCompilerHash(
  canonicalPath: string,
  size: number,
  mtimeMs: number,
  version: string,
  compilerFlags: readonly string[] = getCompileFlags(undefined, "cpp"),
  toolchainDigest = "",
): string {
  const normalizedPath = process.platform === "win32"
    ? canonicalPath.toLowerCase()
    : canonicalPath;
  const payload = [
    "cpp-pch-v2",
    normalizedPath,
    size.toString(),
    Math.round(mtimeMs).toString(),
    version,
    process.platform,
    process.arch,
    JSON.stringify(compilerFlags),
    toolchainDigest,
  ].join(":");
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

export function findToolchainStdcxxBitsDir(toolchainRoot: string): string | null {
  const searchBases = [
    path.join(toolchainRoot, "include", "c++"),
    path.join(toolchainRoot, "x86_64-w64-mingw32", "include", "c++"),
    path.join(toolchainRoot, "lib", "gcc"),
  ];

  for (const base of searchBases) {
    if (!fs.existsSync(base)) continue;
    try {
      const entries = fs.readdirSync(base, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidateDir = path.join(base, entry.name);
        // Check direct bits
        const directBits = path.join(candidateDir, "bits");
        if (fs.existsSync(path.join(directBits, "stdc++.h"))) {
          return directBits;
        }
        // Check arch-specific bits
        const archBits = path.join(candidateDir, "x86_64-w64-mingw32", "bits");
        if (fs.existsSync(path.join(archBits, "stdc++.h"))) {
          return archBits;
        }
        // Check version sub-directory inside lib/gcc/<arch>/<version>/include/c++
        const nestedCxx = path.join(candidateDir, "include", "c++");
        if (fs.existsSync(nestedCxx)) {
          const nested = findToolchainStdcxxBitsDir(candidateDir);
          if (nested) return nested;
        }
      }
    } catch {}
  }
  return null;
}

export function getPchDirectoryForToolchain(
  toolchain?: Readonly<ResolvedToolchain>,
  compilerFlags: readonly string[] = getCompileFlags(undefined, "cpp"),
): string | null {
  if (!toolchain || toolchain.kind !== "cpp" || !toolchain.executablePath) {
    return null;
  }
  try {
    const canonicalExe = fs.realpathSync(toolchain.executionPath || toolchain.executablePath);
    if (!fs.existsSync(canonicalExe)) return null;
    const stats = fs.statSync(canonicalExe);
    const version = toolchain.version || getExecutableVersion(canonicalExe, "cpp") || "";
    const hash = computeCompilerHash(canonicalExe, stats.size, stats.mtimeMs, version, compilerFlags, toolchain.snapshotDigest || toolchain.packageDigest);
    const pchDir = path.join(getAppDataDir(), "pch-cache", hash);
    if (isCompletePchCache(pchDir)) {
      return pchDir;
    }
  } catch {}
  return null;
}

function isCompletePchCache(directory: string): boolean {
  const bitsDirectory = path.join(directory, "bits");
  for (const candidate of [directory, bitsDirectory]) {
    const metadata = fs.lstatSync(candidate, { throwIfNoEntry: false });
    if (!metadata?.isDirectory() || metadata.isSymbolicLink()) return false;
  }
  for (const file of ["stdc++.h", "stdc++.h.gch"]) {
    const metadata = fs.lstatSync(path.join(bitsDirectory, file), { throwIfNoEntry: false });
    if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size === 0) return false;
    if (file.endsWith(".gch") && (metadata.size <= 1024 || metadata.size > 512 * 1024 * 1024)) return false;
  }
  return true;
}

/** PCH is an owned compiler input. Copy it into this run's sandbox, never grant AppData access. */
export function stageCppPch(
  workspace: Pick<ExecutorWorkspace, "stage">,
  toolchain: Readonly<ResolvedToolchain>,
  compilerFlags: readonly string[] = getCompileFlags(undefined, "cpp"),
): string | null {
  const directory = getPchDirectoryForToolchain(toolchain, compilerFlags);
  if (!directory) return null;
  const header = workspace.stage(path.join(directory, "bits", "stdc++.h"), "compiler-pch/bits/stdc++.h");
  workspace.stage(path.join(directory, "bits", "stdc++.h.gch"), "compiler-pch/bits/stdc++.h.gch");
  return path.dirname(path.dirname(header));
}

/** Retain semantic flags in order; omit only JudgeDesk's source/output and platform plumbing. */
export function getPchCompilerFlags(
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string[] | null {
  // Checkers/interactors provide problem-local and testlib include roots.
  // Preserve their textual-header path rather than guessing compatibility.
  if (args.some((argument) => argument.startsWith("-I"))) return null;
  const languageIndex = args.indexOf("-x");
  if (languageIndex < 0 || args[languageIndex + 1] !== "c++") return null;
  const flags: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "-x" || argument === "-o") { index += 1; continue; }
    if (!argument.startsWith("-")) continue;
    if (argument === "-c" || argument === "-s" || argument === "-static" || argument === "-lm"
      || argument.startsWith("-Wl,")
      || (platform === "darwin" && (argument === "-fsanitize=integer-divide-by-zero"
        || argument === "-fsanitize-trap=integer-divide-by-zero"))) continue;
    flags.push(argument);
  }
  return flags;
}

export async function ensureUniversalCppPch(
  toolchain: Readonly<ResolvedToolchain>,
  compilerFlags: readonly string[] = getCompileFlags(undefined, "cpp"),
  runCompiler: typeof runCompilerWithLimits = runCompilerWithLimits,
): Promise<string | null> {
  if (toolchain.kind !== "cpp" || !toolchain.executablePath) {
    return null;
  }
  const executablePath = toolchain.executionPath || toolchain.executablePath;
  if (!fs.existsSync(executablePath)) {
    return null;
  }

  const canonicalExe = fs.realpathSync(executablePath);
  const stats = fs.statSync(canonicalExe);
  const version = toolchain.version || getExecutableVersion(canonicalExe, "cpp") || "";
  const hash = computeCompilerHash(canonicalExe, stats.size, stats.mtimeMs, version, compilerFlags, toolchain.snapshotDigest || toolchain.packageDigest);
  const pchDir = path.join(getAppDataDir(), "pch-cache", hash);

  // A PCH is usable only with its matching header and compiler flags.
  if (isCompletePchCache(pchDir)) {
    return pchDir;
  }

  // Determine toolchain root
  const inferredRoot = (toolchain.executionRoot && toolchain.snapshotDigest
    ? path.join(toolchain.executionRoot, "payload") : toolchain.executionRoot)
    || (toolchain.executionPath ? path.dirname(path.dirname(canonicalExe))
      : toolchain.packageRoot || toolchain.localToolchain?.rootPath || path.dirname(path.dirname(canonicalExe)));

  // Determine source stdc++.h
  let sourceHeaderPath: string | null = null;
  if (process.platform !== "darwin") {
    const foundBits = findToolchainStdcxxBitsDir(inferredRoot);
    if (foundBits) {
      const candidateHeader = path.join(foundBits, "stdc++.h");
      if (fs.existsSync(candidateHeader)) {
        sourceHeaderPath = candidateHeader;
      }
    }
  }

  // Only Apple Clang uses the packaged compatibility umbrella. Do not replace
  // a configured GCC header with a different library's header when discovery fails.
  if (!sourceHeaderPath && process.platform === "darwin") {
    const bundled = path.join(
      RESOURCE_ROOT,
      "compiler-compat",
      "include",
      "bits",
      "stdc++.h",
    );
    if (fs.existsSync(bundled)) {
      sourceHeaderPath = bundled;
    }
  }

  if (!sourceHeaderPath) {
    console.warn("[PCH] No stdc++.h source found for C++ compiler:", canonicalExe);
    return null;
  }

  // Work in a temporary directory to avoid sharing violations or partial files
  const tmpDir = path.join(
    getAppDataDir(),
    "pch-cache",
    ".tmp",
    `${hash}_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
  );
  const tmpBitsDir = path.join(tmpDir, "bits");
  fs.mkdirSync(tmpBitsDir, { recursive: true });

  const stagedHeader = path.join(tmpBitsDir, "stdc++.h");
  const tmpPchFile = path.join(tmpBitsDir, "stdc++.h.gch");
  fs.copyFileSync(sourceHeaderPath, stagedHeader);

  const started = performance.now();
  try {
    // Reuse the verified compiler runner, including GCC relocation, AppContainer/
    // Seatbelt and Job limits. Only this owned header gets the larger output cap;
    // submission compilation retains its existing 32 MiB artifact budget.
    await runCompiler(
      executablePath,
      [...compilerFlags, "-x", "c++-header", stagedHeader, "-o", tmpPchFile],
      tmpDir,
      tmpPchFile,
      undefined,
      { timeoutMs: 45_000, maxGeneratedFileBytes: 128 * 1024 * 1024 },
      "cpp",
      {},
      toolchain,
    );

    if (!fs.existsSync(tmpPchFile) || fs.statSync(tmpPchFile).size <= 1024) {
      throw new Error("PCH generation produced an empty or missing .gch file");
    }

    // Write metadata
    fs.writeFileSync(
      path.join(tmpDir, "metadata.json"),
      JSON.stringify(
        {
          executablePath: canonicalExe,
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          version,
          platform: process.platform,
          arch: process.arch,
          compilerFlags,
          toolchainDigest: toolchain.snapshotDigest || toolchain.packageDigest,
          createdAt: new Date().toISOString(),
          compileDurationMs: Math.round(performance.now() - started),
          pchSizeBytes: fs.statSync(tmpPchFile).size,
        },
        null,
        2,
      ),
      "utf8",
    );

    // Promote tmpDir to final pchDir
    fs.mkdirSync(path.dirname(pchDir), { recursive: true });
    if (fs.existsSync(pchDir)) {
      try {
        fs.rmSync(pchDir, { recursive: true, force: true });
      } catch {}
    }
    fs.renameSync(tmpDir, pchDir);

    console.info(
      `[PCH] Successfully generated bits/stdc++.h.gch in ${(
        performance.now() - started
      ).toFixed(1)} ms for ${path.basename(canonicalExe)}`,
    );
    return pchDir;
  } catch (error) {
    console.warn(
      `[PCH] Generation skipped or failed for ${canonicalExe}:`,
      error instanceof Error ? error.message : String(error),
    );
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
    return null;
  }
}
