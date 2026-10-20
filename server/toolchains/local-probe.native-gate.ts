import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executorClient, executorPathCandidates } from "../executor/client.js";
import { cloneRegularDirectory, inspectRegularDirectory } from "../executor/workspace.js";
import { drainToolchainDiscovery } from "./discovery.js";
import {
  deriveLocalToolchain,
  resolveCachedLocalExecution,
  scheduleLocalCompatibilityProbe,
  type LocallyExecutableKind,
} from "./local-execution.js";

// Explicit opt-in host gate, not part of the deterministic .test.ts suite.
// Missing executables fail rather than adding another conditional skip.
test("selected local C/C++/Python pass every real native compatibility phase", async (t) => {
  assert.ok(
    process.platform === "win32" || process.platform === "darwin",
    "this host gate supports Windows and macOS roots",
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-local-probe-native-"));
  const keys = ["LOCALAPPDATA", "APPDATA", "TMPDIR", "TMP", "TEMP", "JUDGEDESK_EXECUTOR_PATH"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(async () => {
    let drained = false;
    try {
      await drainToolchainDiscovery();
      await executorClient.shutdown();
      drained = true;
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      // Unknown cleanup keeps its owned files for diagnosis; never erase early.
      if (drained) fs.rmSync(root, { recursive: true, force: true });
      else console.error(`[local-probe-native] Retained unconfirmed root: ${root}`);
    }
  });
  const sourceExecutor = executorPathCandidates().find((candidate) => fs.existsSync(candidate));
  assert.ok(sourceExecutor, "build the native executor before running this gate");
  const ownedExecutor = path.join(
    root,
    process.platform === "win32" ? "owned-executor.exe" : "owned-executor",
  );
  fs.copyFileSync(sourceExecutor, ownedExecutor, fs.constants.COPYFILE_EXCL);
  if (process.platform !== "win32") {
    fs.chmodSync(ownedExecutor, 0o755);
  }
  const ownedTmpDir = path.join(root, "tmpdir");
  fs.mkdirSync(ownedTmpDir, { recursive: true, mode: 0o700 });
  process.env.LOCALAPPDATA = path.join(root, "localappdata");
  process.env.APPDATA = path.join(root, "roamingappdata");
  process.env.TMPDIR = ownedTmpDir;
  process.env.TMP = ownedTmpDir;
  process.env.TEMP = ownedTmpDir;
  process.env.JUDGEDESK_EXECUTOR_PATH = ownedExecutor;
  const health = await executorClient.start();
  assert.equal(health.ready, true, health.diagnostics.join("; "));
  const rootRelative = path.relative(fs.realpathSync(root), fs.realpathSync(health.executorRoot));
  assert.ok(rootRelative && rootRelative !== ".." && !rootRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(rootRelative),
    "native root must be beneath the owned fixture before any probe or copy");
  console.log(`[local-probe-native] owned root confirmed: ${health.executorRoot}`);
  const copies = new Map<string, string>();
  const ownedCopy = process.env.JUDGEDESK_LOCAL_PROBE_GATE_OWNED_COPY === "1";
  for (const kind of ["cpp", "c", "python"] satisfies LocallyExecutableKind[]) {
    await t.test(kind, async () => {
      let executable = process.env[`JUDGEDESK_LOCAL_PROBE_GATE_${kind.toUpperCase()}`];
      assert.ok(executable, `set JUDGEDESK_LOCAL_PROBE_GATE_${kind.toUpperCase()}`);
      assert.ok(path.isAbsolute(executable), "an explicit absolute executable path is required");
      const sourceExecutable = executable;
      if (ownedCopy) {
        // A controlled fixture proves the native role pipeline, NOT that the
        // original in-place installation is readable by its AppContainer.
        // Reuse bounded regular-directory staging; no user ACL/path changes.
        const derived = deriveLocalToolchain(kind, executable);
        let copyRoot = copies.get(derived.identity.rootPath);
        if (!copyRoot) {
          inspectRegularDirectory(derived.identity.rootPath, { maxFiles: 65_536, maxBytes: 2 * 1024 * 1024 * 1024 });
          copyRoot = path.join(health.executorRoot, "toolchains", `owned-local-gate-${copies.size}`);
          cloneRegularDirectory(derived.identity.rootPath, copyRoot);
          copies.set(derived.identity.rootPath, copyRoot);
        }
        executable = path.join(copyRoot, derived.identity.executableRelativePath);
      }
      const started = performance.now();
      const probe = await scheduleLocalCompatibilityProbe(kind, executable);
      console.log(`[local-probe-native] ${kind}: ${JSON.stringify({ sourceExecutable, ownedCopy, executable, ...probe, durationMs: performance.now() - started })}`);
      assert.equal(probe.status, "compatible", probe.diagnostic);
      assert.equal(resolveCachedLocalExecution(kind, executable).ready, true);
    });
  }
});
