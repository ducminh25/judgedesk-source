import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { executorClient } from "../executor/client.js";
import * as universalPch from "./universal-pch.js";
import {
  computeCompilerHash,
  ensureUniversalCppPch,
  findToolchainStdcxxBitsDir,
  getPchDirectoryForToolchain,
} from "./universal-pch.js";
import type { ResolvedToolchain } from "../toolchains/types.js";

after(() => executorClient.shutdown());
import type { ExecutorWorkspace } from "../executor/workspace.js";

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

test("findToolchainStdcxxBitsDir finds stdc++.h across standard toolchain layouts", async () => {
  await withTemporaryDirectory((dir) => {
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

test("getPchDirectoryForToolchain safely handles missing or unbuilt PCH", async () => {
  await withTemporaryDirectory((appDir) => {
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

function createCachedCppToolchain(appDir: string): {
  toolchain: ResolvedToolchain;
  pchDir: string;
  headerPath: string;
  pchPath: string;
} {
  const executablePath = path.join(appDir, "dummy_g++.exe");
  fs.writeFileSync(executablePath, "dummy compiler binary");
  const canonicalExe = fs.realpathSync(executablePath);
  const stats = fs.statSync(canonicalExe);
  const toolchain: ResolvedToolchain = {
    kind: "cpp",
    ready: true,
    source: "custom",
    executablePath,
    version: "14.2.0",
    provenance: "unverified-local",
  };
  const hash = computeCompilerHash(canonicalExe, stats.size, stats.mtimeMs, toolchain.version);
  const pchDir = path.join(appDir, "pch-cache", hash);
  const headerPath = path.join(pchDir, "bits", "stdc++.h");
  const pchPath = `${headerPath}.gch`;
  fs.mkdirSync(path.dirname(headerPath), { recursive: true });
  fs.writeFileSync(headerPath, "// stdc++.h content");
  fs.writeFileSync(pchPath, "x".repeat(4096));
  return { toolchain, pchDir, headerPath, pchPath };
}

test("getPchDirectoryForToolchain rejects a cached PCH whose paired header is missing", async () => {
  await withTemporaryDirectory((appDir) => {
    const cached = createCachedCppToolchain(appDir);
    assert.equal(getPchDirectoryForToolchain(cached.toolchain), cached.pchDir);
    fs.rmSync(cached.headerPath);

    assert.equal(getPchDirectoryForToolchain(cached.toolchain), null);
    assert.equal(fs.statSync(cached.pchPath).size, 4096);
  });
});

test("ensureUniversalCppPch cannot reuse an orphaned cached PCH after its header disappears", async () => {
  await withTemporaryDirectory(async (appDir) => {
    const cached = createCachedCppToolchain(appDir);
    assert.equal(await ensureUniversalCppPch(cached.toolchain), cached.pchDir);
    fs.rmSync(cached.headerPath);

    // The invalid dummy compiler cannot rebuild the pair, so preparation must fail cleanly.
    assert.equal(await ensureUniversalCppPch(cached.toolchain), null);
  });
});

test("getPchDirectoryForToolchain requires its paired header to be a regular file", async () => {
  await withTemporaryDirectory((appDir) => {
    const cached = createCachedCppToolchain(appDir);
    fs.rmSync(cached.headerPath);
    fs.mkdirSync(cached.headerPath);

    assert.equal(getPchDirectoryForToolchain(cached.toolchain), null);
  });
});

test("getPchDirectoryForToolchain rejects cached PCH from a replaced compiler binary", async () => {
  await withTemporaryDirectory((appDir) => {
    const cached = createCachedCppToolchain(appDir);
    assert.equal(getPchDirectoryForToolchain(cached.toolchain), cached.pchDir);
    fs.appendFileSync(cached.toolchain.executablePath, " changed compiler");

    assert.equal(getPchDirectoryForToolchain(cached.toolchain), null);
  });
});

test("getPchDirectoryForToolchain rejects cached PCH for a different compiler version", async () => {
  await withTemporaryDirectory((appDir) => {
    const cached = createCachedCppToolchain(appDir);
    assert.equal(getPchDirectoryForToolchain(cached.toolchain), cached.pchDir);

    assert.equal(getPchDirectoryForToolchain({ ...cached.toolchain, version: "14.2.1" }), null);
  });
});

test("computeCompilerHash includes C++ standard and optimization in cache identity", () => {
  const defaultHash = computeCompilerHash("/usr/bin/g++", 1000, 1700000000000, "14.2.0");
  const explicitDefaultHash = computeCompilerHash(
    "/usr/bin/g++", 1000, 1700000000000, "14.2.0", ["-std=c++14", "-O2", "-pipe"],
  );
  const cpp20Hash = computeCompilerHash(
    "/usr/bin/g++", 1000, 1700000000000, "14.2.0", ["-std=c++20", "-O2", "-pipe"],
  );
  const unoptimizedHash = computeCompilerHash(
    "/usr/bin/g++", 1000, 1700000000000, "14.2.0", ["-std=c++14", "-O0", "-pipe"],
  );

  assert.equal(defaultHash, explicitDefaultHash);
  assert.notEqual(defaultHash, cpp20Hash);
  assert.notEqual(defaultHash, unoptimizedHash);
  assert.notEqual(cpp20Hash, unoptimizedHash);
});

test("getPchDirectoryForToolchain cannot reuse C++14 PCH for C++20 compilation", async () => {
  await withTemporaryDirectory((appDir) => {
    const cached = createCachedCppToolchain(appDir);
    assert.equal(getPchDirectoryForToolchain(cached.toolchain), cached.pchDir);

    assert.equal(getPchDirectoryForToolchain(cached.toolchain, ["-std=c++20", "-O2", "-pipe"]), null);
  });
});

test("getPchDirectoryForToolchain cannot reuse optimized PCH for unoptimized compilation", async () => {
  await withTemporaryDirectory((appDir) => {
    const cached = createCachedCppToolchain(appDir);
    assert.equal(getPchDirectoryForToolchain(cached.toolchain), cached.pchDir);

    assert.equal(getPchDirectoryForToolchain(cached.toolchain, ["-std=c++14", "-O0", "-pipe"]), null);
  });
});

test("ensureUniversalCppPch cannot reuse an incompatible C++ standard cache", async () => {
  await withTemporaryDirectory(async (appDir) => {
    const cached = createCachedCppToolchain(appDir);

    assert.equal(await ensureUniversalCppPch(cached.toolchain, ["-std=c++20", "-O2", "-pipe"]), null);
  });
});

test("ensureUniversalCppPch cannot reuse an incompatible optimization cache", async () => {
  await withTemporaryDirectory(async (appDir) => {
    const cached = createCachedCppToolchain(appDir);

    assert.equal(await ensureUniversalCppPch(cached.toolchain, ["-std=c++14", "-O0", "-pipe"]), null);
  });
});

test("getPchDirectoryForToolchain requires cached PCH to be a regular file", async () => {
  await withTemporaryDirectory((appDir) => {
    const cached = createCachedCppToolchain(appDir);
    fs.rmSync(cached.pchPath);
    fs.mkdirSync(cached.pchPath);

    assert.equal(getPchDirectoryForToolchain(cached.toolchain), null);
  });
});

test("getPchDirectoryForToolchain cannot share cached PCH between distinct compiler paths", async () => {
  await withTemporaryDirectory((appDir) => {
    const cached = createCachedCppToolchain(appDir);
    const otherCompilerPath = path.join(appDir, "other_g++.exe");
    fs.copyFileSync(cached.toolchain.executablePath, otherCompilerPath);

    assert.equal(getPchDirectoryForToolchain({ ...cached.toolchain, executablePath: otherCompilerPath }), null);
  });
});

test("PCH lookup uses the certified executable that will actually compile the submission", async () => {
  await withTemporaryDirectory((appDir) => {
    const cached = createCachedCppToolchain(appDir);
    const snapshotExecutable = path.join(appDir, "snapshot_g++.exe");
    fs.writeFileSync(snapshotExecutable, "verified snapshot compiler");
    assert.equal(getPchDirectoryForToolchain({ ...cached.toolchain, executionPath: snapshotExecutable }), null);
  });
});

test("PCH lookup cannot reuse cache after the verified toolchain package changes", async () => {
  await withTemporaryDirectory((appDir) => {
    const cached = createCachedCppToolchain(appDir);
    assert.equal(getPchDirectoryForToolchain({ ...cached.toolchain, packageDigest: "a".repeat(64) }), null);
    assert.equal(getPchDirectoryForToolchain({ ...cached.toolchain, snapshotDigest: "b".repeat(64) }), null);
  });
});

test("PCH generation uses the pinned compiler execution path through the bounded compiler runner", async (t) => {
  t.mock.property(process, "platform", "win32");
  await withTemporaryDirectory(async (appDir) => {
    const cached = createCachedCppToolchain(appDir);
    fs.rmSync(cached.pchDir, { recursive: true });
    const snapshotRoot = path.join(appDir, "snapshot");
    const executionPath = path.join(snapshotRoot, "payload", "bin", "g++.exe");
    const bits = path.join(snapshotRoot, "payload", "include", "c++", "14.2.0", "bits");
    fs.mkdirSync(path.dirname(executionPath), { recursive: true });
    fs.mkdirSync(bits, { recursive: true });
    fs.writeFileSync(executionPath, "snapshot compiler");
    fs.writeFileSync(path.join(bits, "stdc++.h"), "// pinned snapshot header\n");
    const toolchain = { ...cached.toolchain, executionPath, executionRoot: snapshotRoot, snapshotDigest: "b".repeat(64) };
    let usedRunner = false;
    const directory = await ensureUniversalCppPch(toolchain, ["-std=c++14", "-O2", "-pipe"], async (compilerPath, args, cwd, output, jobId, limits, kind, environment, pinned) => {
      usedRunner = true;
      assert.equal(compilerPath, executionPath);
      assert.equal(pinned, toolchain);
      assert.equal(kind, "cpp");
      assert.ok(args.includes("c++-header"));
      assert.ok(limits && limits.timeoutMs <= 45_000);
      assert.ok(limits && limits.maxGeneratedFileBytes >= 86 * 1024 * 1024);
      fs.writeFileSync(output, "x".repeat(4096));
      return { runId: "owned_pch", reason: "exited", exitCode: 0, securitySetupTimeUs: 0, wallTimeUs: 1000, resultCollectionTimeUs: 0, stdoutBytes: 0, stderrBytes: 0 };
    });
    assert.equal(usedRunner, true);
    assert.ok(directory);
    assert.equal(fs.readFileSync(path.join(directory, "bits", "stdc++.h"), "utf8"), "// pinned snapshot header\n");
  });
});

function createStagingWorkspace(directory: string): Pick<ExecutorWorkspace, "stage"> {
  return {
    stage(sourcePath, fileName) {
      const destination = path.join(directory, fileName);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(sourcePath, destination);
      return destination;
    },
  };
}

test("stageCppPch copies the paired header and PCH into the compiler workspace", async () => {
  assert.equal(typeof universalPch.stageCppPch, "function");
  await withTemporaryDirectory((appDir) => {
    const cached = createCachedCppToolchain(appDir);
    const workspacePath = path.join(appDir, "executor-workspace");
    const originalHeader = fs.readFileSync(cached.headerPath);
    const originalPch = fs.readFileSync(cached.pchPath);

    const stagedDirectory = universalPch.stageCppPch(createStagingWorkspace(workspacePath), cached.toolchain);

    assert.equal(stagedDirectory, path.join(workspacePath, "compiler-pch"));
    assert.notEqual(stagedDirectory, cached.pchDir);
    assert.ok(stagedDirectory);
    const stagedHeader = path.join(stagedDirectory, "bits", "stdc++.h");
    const stagedPch = `${stagedHeader}.gch`;
    assert.equal(fs.lstatSync(stagedHeader).isFile(), true);
    assert.equal(fs.lstatSync(stagedPch).isFile(), true);
    assert.deepEqual(fs.readFileSync(stagedHeader), originalHeader);
    assert.deepEqual(fs.readFileSync(stagedPch), originalPch);

    fs.writeFileSync(stagedHeader, "// workspace header changed");
    fs.writeFileSync(stagedPch, "workspace PCH changed");
    assert.deepEqual(fs.readFileSync(cached.headerPath), originalHeader);
    assert.deepEqual(fs.readFileSync(cached.pchPath), originalPch);
  });
});

test("stageCppPch refuses an orphaned PCH without exposing a partial include directory", async () => {
  assert.equal(typeof universalPch.stageCppPch, "function");
  await withTemporaryDirectory((appDir) => {
    const cached = createCachedCppToolchain(appDir);
    const workspacePath = path.join(appDir, "executor-workspace");
    fs.rmSync(cached.headerPath);

    assert.equal(universalPch.stageCppPch(createStagingWorkspace(workspacePath), cached.toolchain), null);
    assert.equal(fs.existsSync(path.join(workspacePath, "compiler-pch")), false);
  });
});

test("stageCppPch refuses a header-only cache without exposing a partial include directory", async () => {
  assert.equal(typeof universalPch.stageCppPch, "function");
  await withTemporaryDirectory((appDir) => {
    const cached = createCachedCppToolchain(appDir);
    const workspacePath = path.join(appDir, "executor-workspace");
    fs.rmSync(cached.pchPath);

    assert.equal(universalPch.stageCppPch(createStagingWorkspace(workspacePath), cached.toolchain), null);
    assert.equal(fs.existsSync(path.join(workspacePath, "compiler-pch")), false);
  });
});

test("stageCppPch refuses a cached PCH built with incompatible flags", async () => {
  assert.equal(typeof universalPch.stageCppPch, "function");
  await withTemporaryDirectory((appDir) => {
    const cached = createCachedCppToolchain(appDir);
    const workspacePath = path.join(appDir, "executor-workspace");

    assert.equal(universalPch.stageCppPch(
      createStagingWorkspace(workspacePath), cached.toolchain, ["-std=c++20", "-O0", "-pipe"],
    ), null);
    assert.equal(fs.existsSync(path.join(workspacePath, "compiler-pch")), false);
  });
});
