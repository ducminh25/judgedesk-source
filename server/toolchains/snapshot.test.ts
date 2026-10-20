import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  cleanupOrphanedLocalSnapshotStaging,
  createLocalToolchainSnapshot,
  estimateDirectoryTree,
  findLocalToolchainSnapshot,
  inspectDirectoryTree,
  verifyLocalToolchainSnapshot,
} from "./snapshot.js";

test("local snapshot hashing is deterministic and detects content changes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-snapshot-tree-"));
  try {
    fs.mkdirSync(path.join(root, "bin"));
    fs.mkdirSync(path.join(root, "lib"));
    fs.writeFileSync(path.join(root, "bin", "compiler.exe"), "compiler-v1");
    fs.writeFileSync(path.join(root, "lib", "runtime.a"), "runtime-v1");
    const first = await inspectDirectoryTree(root);
    const estimate = await estimateDirectoryTree(root);
    const second = await inspectDirectoryTree(root);
    assert.deepEqual(second, first);
    assert.equal(first.fileCount, 2);
    assert.equal(first.totalBytes, 21);
    assert.equal(estimate.fileCount, first.fileCount);
    assert.equal(estimate.totalBytes, first.totalBytes);

    fs.writeFileSync(path.join(root, "lib", "runtime.a"), "runtime-v2");
    const changed = await inspectDirectoryTree(root);
    assert.notEqual(changed.treeDigest, first.treeDigest);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("local snapshot is copied content-addressed and verified before use", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-snapshot-cache-"));
  const source = path.join(temporary, "source");
  const executorRoot = path.join(temporary, "executor");
  try {
    fs.mkdirSync(path.join(source, "bin"), { recursive: true });
    fs.mkdirSync(path.join(source, "include"), { recursive: true });
    const executable = path.join(source, "bin", "g++.exe");
    fs.writeFileSync(executable, "compiler");
    fs.writeFileSync(path.join(source, "include", "header.h"), "header");
    fs.mkdirSync(executorRoot, { recursive: true });

    const snapshot = await createLocalToolchainSnapshot({
      kind: "cpp",
      sourceRoot: source,
      executablePath: executable,
      executorRoot,
    });
    assert.equal(snapshot.created, true);
    assert.equal(snapshot.relativeExecutablePath, "bin/g++.exe");
    assert.equal(snapshot.executableId.startsWith("toolchains/local_cpp_"), true);
    assert.equal(fs.readFileSync(snapshot.executablePath, "utf8"), "compiler");
    const found = findLocalToolchainSnapshot({
      kind: "cpp",
      snapshotDigest: snapshot.treeDigest,
      relativeExecutablePath: snapshot.relativeExecutablePath,
      executorRoot,
    });
    assert.ok(found);
    assert.equal(
      fs.realpathSync.native(found.executablePath),
      fs.realpathSync.native(snapshot.executablePath),
    );

    const reused = await createLocalToolchainSnapshot({
      kind: "cpp",
      sourceRoot: source,
      executablePath: executable,
      executorRoot,
    });
    assert.equal(reused.root, snapshot.root);
    assert.equal(reused.created, false);

    fs.writeFileSync(path.join(snapshot.payloadRoot, "include", "header.h"), "tampered");
    await assert.rejects(
      verifyLocalToolchainSnapshot({
        kind: "cpp",
        snapshotDigest: snapshot.treeDigest,
        executorRoot,
      }),
      /TOOLCHAIN_DRIFTED/,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("snapshot cleanup removes only an old staging directory owned by a dead process", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-snapshot-cleanup-"));
  const executorRoot = path.join(temporary, "executor");
  const toolchainsRoot = path.join(executorRoot, "toolchains");
  try {
    fs.mkdirSync(toolchainsRoot, { recursive: true });
    const deadPid = 2_147_483_000;
    const orphanName = `.local_cpp_pending.${deadPid}.47e953cd-447b-4b58-9b8d-94dfe28d578b.staging`;
    const orphan = path.join(toolchainsRoot, orphanName);
    const unrelated = path.join(toolchainsRoot, ".local_cpp_pending.not-a-pid.staging");
    fs.mkdirSync(orphan);
    fs.mkdirSync(unrelated);
    const canonicalOrphan = fs.realpathSync.native(orphan);
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(orphan, old, old);

    const removed = await cleanupOrphanedLocalSnapshotStaging({ executorRoot });
    assert.deepEqual(removed, [canonicalOrphan]);
    assert.equal(fs.existsSync(orphan), false);
    assert.equal(fs.existsSync(unrelated), true);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("snapshot inspection rejects links and bounded resource overflows", {
  skip: process.platform === "win32" ? "creating symlinks usually requires elevation" : false,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-snapshot-links-"));
  try {
    fs.writeFileSync(path.join(root, "target"), "target");
    fs.symlinkSync("target", path.join(root, "alias"));
    await assert.rejects(inspectDirectoryTree(root), /symbolic link or junction/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot inspection enforces file and byte limits", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-snapshot-limits-"));
  try {
    fs.writeFileSync(path.join(root, "one"), "1234");
    fs.writeFileSync(path.join(root, "two"), "5678");
    await assert.rejects(inspectDirectoryTree(root, { maxFiles: 1 }), /file-count limit/);
    await assert.rejects(inspectDirectoryTree(root, { maxBytes: 7 }), /byte limit/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
