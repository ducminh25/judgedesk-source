import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { executorClient } from "../executor/client.js";
import type { ExecutorRunResult, ExecutorRunSpec } from "../executor/protocol.js";
import { drainToolchainDiscovery } from "./discovery.js";
import {
  clearLocalCompatibilityProbeCache,
  resolveCachedLocalExecution,
  scheduleLocalCompatibilityProbe,
} from "./local-execution.js";
import { LocalProbeCleanupUnconfirmedError } from "./local-probe-registry.js";

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("Deferred promise not initialized"); };
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function terminal(spec: ExecutorRunSpec, reason: ExecutorRunResult["reason"] = "exited"): ExecutorRunResult {
  return {
    runId: spec.runId, reason, exitCode: reason === "exited" ? 0 : null,
    securitySetupTimeUs: 1, wallTimeUs: 1, resultCollectionTimeUs: 1,
    stdoutBytes: 0, stderrBytes: 0,
  };
}

function fixture(t: TestContext) {
  clearLocalCompatibilityProbeCache();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-owned-local-probe-"));
  fs.mkdirSync(path.join(root, "workspaces"));
  const developerRoot = path.join(root, "FakeXcode.app", "Contents", "Developer");
  const toolchainRoot = path.join(developerRoot, "Toolchains", "Default.xctoolchain");
  const bin = process.platform === "darwin"
    ? path.join(toolchainRoot, "usr", "bin")
    : path.join(root, "compiler", "bin");
  fs.mkdirSync(bin, { recursive: true });
  if (process.platform === "darwin") {
    fs.mkdirSync(path.join(toolchainRoot, "usr", "lib", "clang", "20", "include"), { recursive: true });
    fs.mkdirSync(path.join(developerRoot, "Platforms", "MacOSX.platform", "Developer", "SDKs", "MacOSX.sdk"), { recursive: true });
  }
  const compiler = path.join(bin, process.platform === "win32" ? "g++.exe" : "clang++");
  fs.writeFileSync(compiler, "owned fake native boundary");
  t.mock.method(executorClient, "start", async () => ({ ...executorClient.health, ready: true, executorRoot: root }));
  t.after(() => {
    clearLocalCompatibilityProbeCache();
    // Only fake IPC is used here; no process ever runs against these owned files.
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, compiler, workspaces: () => fs.readdirSync(path.join(root, "workspaces")) };
}

function fakeCompile(spec: ExecutorRunSpec) {
  const output = spec.args[spec.args.indexOf("-o") + 1];
  assert.ok(output);
  fs.writeFileSync(output, "owned fake executable");
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("local compiler admission requires its produced program in submission and checker roles", async (t) => {
  const f = fixture(t);
  const specs: ExecutorRunSpec[] = [];
  t.mock.method(executorClient, "run", async (spec: ExecutorRunSpec, beforeSubmit?: () => void) => {
    beforeSubmit?.();
    specs.push(spec);
    if (spec.role === "compiler") fakeCompile(spec);
    return terminal(spec);
  });
  const result = await scheduleLocalCompatibilityProbe("cpp", f.compiler);
  assert.equal(result.status, "compatible");
  assert.deepEqual(specs.map((spec) => spec.role), ["compiler", "submission", "checker"]);
  assert.equal(specs[0].localToolchain?.isolation, "strict");
  assert.equal(specs[0].localToolchain?.role, "compiler");
  assert.equal(specs[1].localToolchain, undefined);
  assert.equal(specs[2].localToolchain, undefined);
  assert.match(specs[1].executableId, /^workspaces\/.+\/probe\.(exe|out)$/);
  assert.equal(specs[2].executableId, specs[1].executableId);
  assert.ok(specs[1].stdinFile);
  assert.equal(specs[2].stdinFile, specs[1].stdinFile);
  assert.ok(specs[2].limits.outputBytes <= 256 * 1024);
  assert.deepEqual(f.workspaces(), []);
});

test("native checker failure denies the whole compiler probe without fallback", async (t) => {
  const f = fixture(t);
  const roles: string[] = [];
  t.mock.method(executorClient, "run", async (spec: ExecutorRunSpec, beforeSubmit?: () => void) => {
    beforeSubmit?.();
    roles.push(spec.role);
    if (spec.role === "compiler") fakeCompile(spec);
    return terminal(spec, spec.role === "checker" ? "launch_error" : "exited");
  });
  const result = await scheduleLocalCompatibilityProbe("cpp", f.compiler);
  assert.equal(result.status, "incompatible");
  assert.match(result.diagnostic || "", /checker/);
  assert.deepEqual(roles, ["compiler", "submission", "checker"]);
  assert.deepEqual(f.workspaces(), []);
});

test("C admission compiles C11 and executes both native runtime roles", async (t) => {
  const f = fixture(t);
  const specs: ExecutorRunSpec[] = [];
  t.mock.method(executorClient, "run", async (spec: ExecutorRunSpec, beforeSubmit?: () => void) => {
    beforeSubmit?.();
    specs.push(spec);
    if (spec.role === "compiler") fakeCompile(spec);
    return terminal(spec);
  });
  assert.equal((await scheduleLocalCompatibilityProbe("c", f.compiler)).status, "compatible");
  assert.ok(specs[0].args.includes("-std=c11"));
  assert.deepEqual(specs.map((spec) => spec.role), ["compiler", "submission", "checker"]);
  assert.deepEqual(f.workspaces(), []);
});

test("compiler success without a bounded nonempty executable is not admitted", async (t) => {
  for (const artifact of ["missing", "empty", "oversize", "directory"] as const) {
    await t.test(artifact, async (child) => {
      const f = fixture(child);
      const roles: string[] = [];
      child.mock.method(executorClient, "run", async (spec: ExecutorRunSpec, beforeSubmit?: () => void) => {
        beforeSubmit?.();
        roles.push(spec.role);
        if (spec.role === "compiler") {
          const output = spec.args[spec.args.indexOf("-o") + 1];
          if (artifact === "empty") fs.writeFileSync(output, "");
          if (artifact === "oversize") {
            const descriptor = fs.openSync(output, "wx");
            try { fs.ftruncateSync(descriptor, 8 * 1024 * 1024 + 1); } finally { fs.closeSync(descriptor); }
          }
          if (artifact === "directory") fs.mkdirSync(output);
        }
        return terminal(spec);
      });
      assert.equal((await scheduleLocalCompatibilityProbe("cpp", f.compiler)).status, "incompatible");
      assert.deepEqual(roles, ["compiler"], "do not attempt to run an invalid artifact");
      assert.deepEqual(f.workspaces(), []);
    });
  }
});

test("Python uses two strict role-scoped runtimes and cleans its workspace", async (t) => {
  const f = fixture(t);
  const specs: ExecutorRunSpec[] = [];
  t.mock.method(executorClient, "run", async (spec: ExecutorRunSpec, beforeSubmit?: () => void) => {
    beforeSubmit?.();
    specs.push(spec);
    return terminal(spec);
  });
  assert.equal((await scheduleLocalCompatibilityProbe("python", process.execPath)).status, "compatible");
  assert.deepEqual(specs.map((spec) => spec.role), ["submission", "checker-runtime"]);
  assert.deepEqual(specs.map((spec) => spec.localToolchain?.role), ["submission-runtime", "checker-runtime"]);
  assert.ok(specs.every((spec) => spec.localToolchain?.isolation === "strict"));
  assert.deepEqual(f.workspaces(), []);
});

test("abort during executor startup blocks the ordered run write without cancellation", async (t) => {
  const f = fixture(t);
  const startup = deferred<void>();
  const controller = new AbortController();
  let writes = 0;
  let cancels = 0;
  t.mock.method(executorClient, "run", async (spec: ExecutorRunSpec, beforeSubmit?: () => void) => {
    await startup.promise;
    beforeSubmit?.();
    writes += 1;
    return terminal(spec);
  });
  t.mock.method(executorClient, "cancel", async () => { cancels += 1; return true; });
  const probe = scheduleLocalCompatibilityProbe("python", process.execPath, undefined, controller.signal);
  await nextTurn();
  controller.abort();
  await nextTurn();
  const keptUntilStartup = f.workspaces().length;
  startup.resolve();
  assert.equal((await probe).status, "incompatible");
  assert.equal(keptUntilStartup, 1, "do not dispose before the blocked startup settles");
  assert.equal(writes, 0);
  assert.equal(cancels, 0, "no submitted run exists yet");
  assert.deepEqual(f.workspaces(), []);
});

test("abort awaits the run terminal and the single cancellation acknowledgement before cleanup", async (t) => {
  const f = fixture(t);
  const response = deferred<ExecutorRunResult>();
  const cancellation = deferred<boolean>();
  const controller = new AbortController();
  let accepted: ExecutorRunSpec | undefined;
  let cancels = 0;
  t.mock.method(executorClient, "run", async (spec: ExecutorRunSpec, beforeSubmit?: () => void) => {
    beforeSubmit?.();
    accepted = spec;
    return response.promise;
  });
  t.mock.method(executorClient, "cancel", async () => { cancels += 1; return cancellation.promise; });
  const probe = scheduleLocalCompatibilityProbe("python", process.execPath, undefined, controller.signal);
  let settled = false;
  void probe.then(() => { settled = true; }, () => { settled = true; });
  await nextTurn();
  assert.ok(accepted);
  controller.abort();
  response.resolve(terminal(accepted, "cancelled"));
  await nextTurn();
  const keptBeforeAck = f.workspaces().length;
  const premature = settled;
  cancellation.resolve(true);
  assert.equal((await probe).status, "incompatible");
  assert.equal(premature, false);
  assert.equal(keptBeforeAck, 1);
  assert.equal(cancels, 1);
  assert.deepEqual(f.workspaces(), []);
});

test("IPC rejection after submit may clean up only after a positive cancellation drain acknowledgement", async (t) => {
  const f = fixture(t);
  let cancels = 0;
  t.mock.method(executorClient, "run", async (_spec: ExecutorRunSpec, beforeSubmit?: () => void) => {
    beforeSubmit?.();
    throw new Error("lost terminal frame");
  });
  t.mock.method(executorClient, "cancel", async () => { cancels += 1; return true; });
  assert.equal((await scheduleLocalCompatibilityProbe("python", process.execPath)).status, "incompatible");
  assert.equal(cancels, 1);
  assert.deepEqual(f.workspaces(), []);
});

test("internal_error is not drain proof; retained cleanup failure reaches real discovery shutdown", async (t) => {
  const f = fixture(t);
  t.mock.method(executorClient, "run", async (spec: ExecutorRunSpec, beforeSubmit?: () => void) => {
    beforeSubmit?.();
    return { ...terminal(spec, "internal_error"), diagnostic: "Job Object did not become empty during teardown" };
  });
  t.mock.method(executorClient, "cancel", async () => false);
  const probe = scheduleLocalCompatibilityProbe("python", process.execPath);
  await assert.rejects(probe, LocalProbeCleanupUnconfirmedError);
  assert.equal(f.workspaces().length, 1, "uncertain cleanup must retain owned files");
  assert.equal(resolveCachedLocalExecution("python", process.execPath).ready, false);
  clearLocalCompatibilityProbeCache();
  await assert.rejects(scheduleLocalCompatibilityProbe("python", process.execPath), LocalProbeCleanupUnconfirmedError);
  await assert.rejects(drainToolchainDiscovery(500), /cleanup is unconfirmed/);
});
