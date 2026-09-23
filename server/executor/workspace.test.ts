import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getDescriptorForHost } from "../toolchains/manifest.js";
import type { ResolvedToolchain } from "../toolchains/types.js";
import { executorClient } from "./client.js";
import {
  cloneRegularDirectory,
  createExecutorWorkspace,
  executorRelativeCanonicalPath,
  inspectRegularDirectory,
  managedCacheMarker,
  managedToolchainSourceRoot,
  prepareManagedToolchainExecutable,
  sweepStaleQuarantines,
} from "./workspace.js";

test("managed cache markers bind receipt-backed copies to the package digest", () => {
  const firstDigest = "a".repeat(64);
  const secondDigest = "b".repeat(64);
  assert.equal(
    managedCacheMarker("python-test", "3.12.13", firstDigest),
    `4-receipt-digest\npython-test\n3.12.13\n${firstDigest}\n`,
  );
  assert.notEqual(
    managedCacheMarker("python-test", "3.12.13", firstDigest),
    managedCacheMarker("python-test", "3.12.13", secondDigest),
  );
  assert.equal(
    managedCacheMarker("python-test", "3.12.13"),
    "4-receipt-digest\npython-test\n3.12.13\nlegacy\n",
  );
  assert.throws(
    () => managedCacheMarker("python-test", "3.12.13", "ABC"),
    /lowercase SHA-256/,
  );
});

test("executor toolchain IDs canonicalize an aliased executor root", (t) => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "judgedesk-executor-alias-"),
  );
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const canonicalRoot = path.join(temporaryRoot, "private-root");
  const executablePath = path.join(
    canonicalRoot,
    "toolchains",
    "python-test",
    "bin",
    process.platform === "win32" ? "python.exe" : "python3",
  );
  fs.mkdirSync(path.dirname(executablePath), { recursive: true });
  fs.writeFileSync(executablePath, "runtime");
  const aliasedRoot = path.join(temporaryRoot, "root-alias");
  try {
    fs.symlinkSync(
      canonicalRoot,
      aliasedRoot,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch {
    t.skip("creating a directory alias requires additional privileges");
    return;
  }

  assert.equal(
    executorRelativeCanonicalPath(
      aliasedRoot,
      path.join(
        fs.realpathSync(canonicalRoot),
        "toolchains",
        "python-test",
        "bin",
        path.basename(executablePath),
      ),
    ),
    `toolchains/python-test/bin/${path.basename(executablePath)}`,
  );
});

test("a catalog symlink resolves against its explicit managed package root", (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "judgedesk-managed-symlink-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  const versionedExecutable = path.join(bin, "python3.12");
  const catalogEntrypoint = path.join(bin, "python3");
  fs.mkdirSync(bin);
  fs.writeFileSync(versionedExecutable, "runtime");
  try {
    fs.symlinkSync("python3.12", catalogEntrypoint, "file");
  } catch {
    t.skip("creating file symlinks requires additional privileges");
    return;
  }

  assert.equal(
    managedToolchainSourceRoot(
      fs.realpathSync(catalogEntrypoint),
      "bin/python3",
      root,
    ),
    fs.realpathSync(root),
  );
  assert.throws(
    () =>
      managedToolchainSourceRoot(
        fs.realpathSync(catalogEntrypoint),
        "bin/python3",
      ),
    /TOOLCHAIN_NOT_SANDBOX_COMPATIBLE/,
  );
});

test("a built-in managed toolchain is referenced directly without an executor-cache copy", async (t) => {
  const descriptor = getDescriptorForHost(os.platform(), os.arch(), "python");
  if (!descriptor) {
    t.skip("no managed Python descriptor exists for this host");
    return;
  }
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "judgedesk-built-in-workspace-"),
  );
  const packageRoot = path.join(root, descriptor.id);
  const executablePath = path.join(
    packageRoot,
    ...descriptor.executableRelativePath.split("/"),
  );
  fs.mkdirSync(path.dirname(executablePath), { recursive: true });
  let canonicalExecutablePath = executablePath;
  if (process.platform === "darwin") {
    canonicalExecutablePath = path.join(
      path.dirname(executablePath),
      "python3.12",
    );
    fs.writeFileSync(canonicalExecutablePath, "runtime");
    fs.symlinkSync(path.basename(canonicalExecutablePath), executablePath);
  } else {
    fs.writeFileSync(executablePath, "runtime");
  }
  const entrypoint = descriptor.entrypoints.find(
    (candidate) => candidate.kind === "python",
  );
  assert.ok(entrypoint);
  fs.writeFileSync(
    path.join(packageRoot, ".judgedesk-package.json"),
    JSON.stringify({
      schemaVersion: 1,
      packageId: descriptor.id,
      version: descriptor.version,
      archiveSha256: "a".repeat(64),
      entrypointComponentId: entrypoint.componentId,
      components: [{
        id: entrypoint.componentId,
        kind: "executable",
        relativePath: entrypoint.executableRelativePath,
        roles: ["submission-runtime", "checker-runtime"],
      }],
    }),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const resolved: ResolvedToolchain = {
    kind: "python",
    source: "managed",
    executablePath,
    version: descriptor.version,
    ready: true,
    packageOrigin: "built-in",
    packageRoot,
    packageDigest: "a".repeat(64),
    packageComponentId: entrypoint.componentId,
  };
  const prepared = await prepareManagedToolchainExecutable("python", resolved);

  assert.equal(prepared.root, fs.realpathSync(packageRoot));
  assert.equal(prepared.executablePath, fs.realpathSync(canonicalExecutablePath));
  assert.equal(
    prepared.executableId,
    `builtin-toolchains/${descriptor.id}/${descriptor.executableRelativePath}`,
  );
  assert.deepEqual(prepared.toolchain, {
    packageId: descriptor.id,
    packageDigest: "a".repeat(64),
    componentId: entrypoint.componentId,
  });
});

test("workspace directory clones are isolated copies and preserve empty directories", (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "judgedesk-directory-clone-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const destination = path.join(root, "destination");
  fs.mkdirSync(path.join(source, "nested", "empty"), { recursive: true });
  fs.writeFileSync(path.join(source, "nested", "cache.bin"), "original");

  inspectRegularDirectory(source, {
    maxFiles: 10,
    maxBytes: 1_024,
  });
  cloneRegularDirectory(source, destination);

  assert.equal(
    fs.readFileSync(path.join(destination, "nested", "cache.bin"), "utf8"),
    "original",
  );
  assert.equal(
    fs.statSync(path.join(destination, "nested", "empty")).isDirectory(),
    true,
  );
  fs.writeFileSync(path.join(destination, "nested", "cache.bin"), "changed");
  assert.equal(
    fs.readFileSync(path.join(source, "nested", "cache.bin"), "utf8"),
    "original",
  );
});

test("workspace directory cloning rejects symlinks without leaving a partial copy", (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "judgedesk-directory-clone-link-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const destination = path.join(root, "destination");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "target"), "target");
  try {
    fs.symlinkSync("target", path.join(source, "link"), "file");
  } catch {
    t.skip("creating file symlinks requires additional privileges");
    return;
  }

  assert.throws(
    () => {
      inspectRegularDirectory(source, {
        maxFiles: 10,
        maxBytes: 1_024,
      });
      cloneRegularDirectory(source, destination);
    },
    /rejects symbolic links/,
  );
  assert.equal(fs.existsSync(destination), false);
});

test("sweepStaleQuarantines purges unlocked quarantined directories", (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "judgedesk-quarantine-sweep-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const normalWorkspace = path.join(root, "run_normal_123");
  const quarantinedWorkspace = path.join(root, "run_locked_456.quarantine.123456");
  fs.mkdirSync(normalWorkspace);
  fs.mkdirSync(quarantinedWorkspace);
  fs.writeFileSync(path.join(normalWorkspace, "stdout.txt"), "ok");
  fs.writeFileSync(path.join(quarantinedWorkspace, "stdout.txt"), "locked");

  sweepStaleQuarantines(root);

  assert.equal(fs.existsSync(normalWorkspace), true);
  assert.equal(fs.existsSync(quarantinedWorkspace), false);
});

test("sweepStaleQuarantines fails closed when a quarantine cannot be removed", (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "jd_test_quarantine_fail_closed_"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const quarantinedWorkspace = path.join(root, "run_locked_456.quarantine.123456");
  fs.mkdirSync(quarantinedWorkspace);

  assert.throws(
    () => sweepStaleQuarantines(root, {
      removeSync: () => {
        throw new Error("EPERM: simulated quarantine lock");
      },
    }),
    (error: unknown) => {
      assert(error instanceof Error);
      assert.match(error.message, /Failed to clean stale executor quarantine/);
      assert.match(error.message, /EPERM: simulated quarantine lock/);
      assert.match(error.message, /run_locked_456\.quarantine\.123456/);
      return true;
    },
  );
  assert.equal(fs.existsSync(quarantinedWorkspace), true);
});

test("executor workspace dispose fails closed when deletion fails", async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "jd_test_ws_fail_closed_"),
  );
  fs.mkdirSync(path.join(root, "workspaces"), { recursive: true });
  t.after(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  const origStart = executorClient.start.bind(executorClient);
  executorClient.start = async () => ({
    ready: true,
    mode: "windows-lpac-job",
    executorVersion: "1.5.0",
    executorRoot: root,
    diagnostics: [],
    networkBlocked: true,
    filesystemIsolated: true,
    processTreeControlled: true,
    memoryLimitSupported: true,
  });
  t.after(() => {
    executorClient.start = origStart;
  });

  let shouldFail = true;
  const simulatedRmSync = (target: string, opts?: fs.RmOptions) => {
    if (shouldFail) {
      throw new Error("EPERM: operation not permitted");
    }
    fs.rmSync(target, opts);
  };

  const workspace = await createExecutorWorkspace({ rmSync: simulatedRmSync });
  const testFile = path.join(workspace.path, "test.txt");
  fs.writeFileSync(testFile, "test-data");

  // Attempt dispose while rmSync fails: must throw fail-closed and report workspace.path
  assert.throws(
    () => workspace.dispose(),
    (err: unknown) => {
      assert(err instanceof Error);
      assert(err.message.includes("Failed to clean up executor workspace at"));
      assert(err.message.includes(workspace.path));
      assert(err.message.includes("EPERM"));
      return true;
    },
  );
  assert.equal(fs.existsSync(workspace.path), true);

  // When failure condition clears, dispose succeeds cleanly
  shouldFail = false;
  workspace.dispose();
  assert.equal(fs.existsSync(workspace.path), false);
});
