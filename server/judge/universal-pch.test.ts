import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  computeCompilerHash,
  ensureUniversalCppPch,
  findToolchainStdcxxBitsDir,
  getPchDirectoryForToolchain,
} from "./universal-pch.js";
import type { ResolvedToolchain } from "../toolchains/types.js";

async function withTemporaryDirectory(
  run: (directory: string) => Promise<void> | void,
): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-pch-test-"));
  const previousAppData = process.env.THEMIS_APP_DATA_DIR;
  process.env.THEMIS_APP_DATA_DIR = directory;
  try {
    await run(directory);
  } finally {
    if (previousAppData === undefined) delete process.env.THEMIS_APP_DATA_DIR;
    else process.env.THEMIS_APP_DATA_DIR = previousAppData;
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {}
  }
}

test("computeCompilerHash generates stable, sensitive 16-hex digests", () => {
  const hash1 = computeCompilerHash("/usr/bin/g++", 1000, 1700000000000, "14.2.0");
  const hash2 = computeCompilerHash("/usr/bin/g++", 1000, 1700000000000, "14.2.0");
  assert.equal(hash1, hash2);
  assert.equal(hash1.length, 16);

  // Different size
  const hashSize = computeCompilerHash("/usr/bin/g++", 1001, 1700000000000, "14.2.0");
  assert.notEqual(hash1, hashSize);

  // Different mtime
  const hashMtime = computeCompilerHash("/usr/bin/g++", 1000, 1700000005000, "14.2.0");
  assert.notEqual(hash1, hashMtime);

  // Different version
  const hashVersion = computeCompilerHash("/usr/bin/g++", 1000, 1700000000000, "14.2.1");
  assert.notEqual(hash1, hashVersion);
});

test("findToolchainStdcxxBitsDir finds stdc++.h across standard toolchain layouts", () => {
  withTemporaryDirectory((dir) => {
    // Layout 1: include/c++/14.2.0/bits/stdc++.h
    const layout1 = path.join(dir, "toolchain1");
    const bits1 = path.join(layout1, "include", "c++", "14.2.0", "bits");
    fs.mkdirSync(bits1, { recursive: true });
    fs.writeFileSync(path.join(bits1, "stdc++.h"), "// test header");

    const found1 = findToolchainStdcxxBitsDir(layout1);
    assert.equal(found1, bits1);

    // Layout 2: include/c++/14.2.0/x86_64-w64-mingw32/bits/stdc++.h
    const layout2 = path.join(dir, "toolchain2");
    const bits2 = path.join(layout2, "include", "c++", "14.2.0", "x86_64-w64-mingw32", "bits");
    fs.mkdirSync(bits2, { recursive: true });
    fs.writeFileSync(path.join(bits2, "stdc++.h"), "// arch header");

    const found2 = findToolchainStdcxxBitsDir(layout2);
    assert.equal(found2, bits2);

    // Layout 3: Missing
    const layout3 = path.join(dir, "toolchain3");
    fs.mkdirSync(layout3, { recursive: true });
    assert.equal(findToolchainStdcxxBitsDir(layout3), null);
  });
});

test("getPchDirectoryForToolchain safely handles missing or unbuilt PCH", () => {
  withTemporaryDirectory((appDir) => {
    // Non-cpp toolchain
    const pyToolchain = {
      kind: "python" as const,
      ready: true,
      source: "managed" as const,
      executablePath: process.execPath,
      version: "3.12.0",
      provenance: "managed" as const,
    } as unknown as ResolvedToolchain;
    assert.equal(getPchDirectoryForToolchain(pyToolchain), null);

    // Fake cpp toolchain with non-existent executable
    const fakeCpp = {
      kind: "cpp" as const,
      ready: true,
      source: "custom" as const,
      executablePath: path.join(appDir, "nonexistent_g++.exe"),
      version: "14.2.0",
      provenance: "unverified-local" as const,
    } as unknown as ResolvedToolchain;
    assert.equal(getPchDirectoryForToolchain(fakeCpp), null);

    // Valid executable but no PCH built yet
    const dummyExe = path.join(appDir, "dummy_g++.exe");
    fs.writeFileSync(dummyExe, "dummy compiler binary");
    const cppToolchain = {
      kind: "cpp" as const,
      ready: true,
      source: "custom" as const,
      executablePath: dummyExe,
      version: "14.2.0",
      provenance: "unverified-local" as const,
    } as ResolvedToolchain;
    assert.equal(getPchDirectoryForToolchain(cppToolchain), null);

    // Create valid PCH in cache
    const canonicalDummy = fs.realpathSync(dummyExe);
    const stats = fs.statSync(canonicalDummy);
    const hash = computeCompilerHash(canonicalDummy, stats.size, stats.mtimeMs, "14.2.0");
    const pchDir = path.join(appDir, "pch-cache", hash);
    const bitsDir = path.join(pchDir, "bits");
    fs.mkdirSync(bitsDir, { recursive: true });
    fs.writeFileSync(path.join(bitsDir, "stdc++.h"), "// stdc++.h content");
    fs.writeFileSync(path.join(bitsDir, "stdc++.h.gch"), "x".repeat(2048)); // > 1024 bytes

    const resolvedPch = getPchDirectoryForToolchain(cppToolchain);
    assert.equal(resolvedPch, pchDir);
  });
});

test("ensureUniversalCppPch reuses intact cached PCH without recompilation", async () => {
  await withTemporaryDirectory(async (appDir) => {
    const dummyExe = path.join(appDir, "dummy_g++.exe");
    fs.writeFileSync(dummyExe, "dummy compiler binary");
    const canonicalExe = fs.realpathSync(dummyExe);
    const stats = fs.statSync(canonicalExe);
    const hash = computeCompilerHash(canonicalExe, stats.size, stats.mtimeMs, "14.2.0");

    const pchDir = path.join(appDir, "pch-cache", hash);
    const bitsDir = path.join(pchDir, "bits");
    fs.mkdirSync(bitsDir, { recursive: true });
    fs.writeFileSync(path.join(bitsDir, "stdc++.h"), "// stdc++.h content");
    fs.writeFileSync(path.join(bitsDir, "stdc++.h.gch"), "x".repeat(4096));

    const cppToolchain = {
      kind: "cpp" as const,
      ready: true,
      source: "custom" as const,
      executablePath: dummyExe,
      version: "14.2.0",
      provenance: "unverified-local" as const,
    } as ResolvedToolchain;

    const result = await ensureUniversalCppPch(cppToolchain);
    assert.equal(result, pchDir);
    // Verification that file is intact and unchanged
    assert.equal(fs.statSync(path.join(bitsDir, "stdc++.h.gch")).size, 4096);
  });
});

test("ensureUniversalCppPch gracefully returns null when compiler fails", async () => {
  await withTemporaryDirectory(async (appDir) => {
    // A dummy script/binary that fails execution
    const isWin = process.platform === "win32";
    const failingExe = path.join(appDir, isWin ? "failing_g++.cmd" : "failing_g++.sh");
    if (isWin) {
      fs.writeFileSync(failingExe, "@echo off\r\nexit /b 1\r\n");
    } else {
      fs.writeFileSync(failingExe, "#!/bin/sh\nexit 1\n");
      fs.chmodSync(failingExe, 0o755);
    }

    const cppToolchain = {
      kind: "cpp" as const,
      ready: true,
      source: "custom" as const,
      executablePath: failingExe,
      version: "14.2.0",
      provenance: "unverified-local" as const,
    } as ResolvedToolchain;

    const result = await ensureUniversalCppPch(cppToolchain);
    // Should fail gracefully and return null
    assert.equal(result, null);
  });
});
