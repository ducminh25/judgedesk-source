import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getAppDataDir } from "../toolchains/storage.js";
import { RESOURCE_ROOT } from "../runtime.js";
import type { ResolvedToolchain } from "../toolchains/types.js";
import { getExecutableVersion } from "../toolchains/resolver.js";
import { resolveDarwinCompilerSupport } from "./compiler.js";

const execFileAsync = promisify(execFile);

export function computeCompilerHash(
  canonicalPath: string,
  size: number,
  mtimeMs: number,
  version: string,
): string {
  const normalizedPath = process.platform === "win32"
    ? canonicalPath.toLowerCase()
    : canonicalPath;
  const payload = [
    normalizedPath,
    size.toString(),
    Math.round(mtimeMs).toString(),
    version,
    process.platform,
    process.arch,
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
  toolchain?: ResolvedToolchain,
): string | null {
  if (!toolchain || toolchain.kind !== "cpp" || !toolchain.executablePath) {
    return null;
  }
  try {
    const canonicalExe = fs.realpathSync(toolchain.executablePath);
    if (!fs.existsSync(canonicalExe)) return null;
    const stats = fs.statSync(canonicalExe);
    const version = toolchain.version || getExecutableVersion(canonicalExe, "cpp") || "";
    const hash = computeCompilerHash(canonicalExe, stats.size, stats.mtimeMs, version);
    const pchDir = path.join(getAppDataDir(), "pch-cache", hash);
    const pchFile = path.join(pchDir, "bits", "stdc++.h.gch");
    if (fs.existsSync(pchFile) && fs.statSync(pchFile).size > 1024) {
      return pchDir;
    }
  } catch {}
  return null;
}

export async function ensureUniversalCppPch(
  toolchain: ResolvedToolchain,
): Promise<string | null> {
  if (toolchain.kind !== "cpp" || !toolchain.executablePath) {
    return null;
  }
  if (!fs.existsSync(toolchain.executablePath)) {
    return null;
  }

  const canonicalExe = fs.realpathSync(toolchain.executablePath);
  const stats = fs.statSync(canonicalExe);
  const version = toolchain.version || getExecutableVersion(canonicalExe, "cpp") || "";
  const hash = computeCompilerHash(canonicalExe, stats.size, stats.mtimeMs, version);
  const pchDir = path.join(getAppDataDir(), "pch-cache", hash);
  const pchFile = path.join(pchDir, "bits", "stdc++.h.gch");

  // If already compiled and intact (> 1 KB), reuse cache
  if (fs.existsSync(pchFile) && fs.statSync(pchFile).size > 1024) {
    return pchDir;
  }

  // Determine toolchain root
  const inferredRoot = toolchain.packageRoot
    || toolchain.localToolchain?.rootPath
    || path.dirname(path.dirname(canonicalExe));

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

  // Fallback to JudgeDesk bundled compatibility header
  if (!sourceHeaderPath) {
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
    if (process.platform === "darwin") {
      const darwin = resolveDarwinCompilerSupport(canonicalExe, "cpp");
      await execFileAsync(
        canonicalExe,
        [
          ...darwin.argumentPrefix,
          "-std=c++14",
          "-O2",
          "-x",
          "c++-header",
          stagedHeader,
          "-o",
          tmpPchFile,
        ],
        {
          timeout: 45_000,
          env: {
            ...process.env,
            ...darwin.environment,
            TMPDIR: tmpBitsDir,
          },
        },
      );
    } else {
      await execFileAsync(
        canonicalExe,
        [
          "-std=c++14",
          "-O2",
          "-pipe",
          "-x",
          "c++-header",
          stagedHeader,
          "-o",
          tmpPchFile,
        ],
        {
          windowsHide: true,
          timeout: 45_000,
          env: {
            ...process.env,
            TMPDIR: tmpBitsDir,
          },
        },
      );
    }

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
