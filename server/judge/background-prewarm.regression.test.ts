import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureJudgePrewarmReady,
  executeJudgePrewarm,
  nativeCompilerKindsToPrewarm,
  resetJudgePrewarmStateForTests,
  startBackgroundJudgePrewarm,
  type PrewarmDependencies,
} from "./background-prewarm.js";
import { executorClient } from "../executor/client.js";
import type { ToolchainKind } from "../toolchains/types.js";

test("C-only judge requirements select managed-C prewarming", () => {
  assert.deepEqual(
    nativeCompilerKindsToPrewarm(new Set(["c"])),
    ["c"],
  );
});

test("C++ and C requirements preserve deterministic prewarm order", () => {
  assert.deepEqual(
    nativeCompilerKindsToPrewarm(new Set(["c", "cpp"])),
    ["cpp", "c"],
  );
});

function dependencies(prepared: ToolchainKind[]): PrewarmDependencies {
  return {
    waitForToolchainDiscovery: async () => ({
      schemaVersion: 2, registryRevision: 1, status: "complete", refreshing: false,
      completedAt: new Date().toISOString(), profiles: {},
    }),
    resolveNativeProtectedToolchain: (kind) => ({
      kind, source: "managed", packageOrigin: "built-in", ready: true,
      executablePath: `/${kind}/compiler`, version: "test",
    }),
    ensureUniversalCppPch: async () => null,
    prepareManagedToolchainComponent: async (kind) => { prepared.push(kind); },
    ensureManagedCCompilerWarmup: async () => {},
  };
}

test("background startup prepares C++ without preparing C", async (t) => {
  t.mock.method(executorClient, "start", async () => ({ ...executorClient.health, ready: true }));
  resetJudgePrewarmStateForTests();
  t.after(resetJudgePrewarmStateForTests);
  const compiled: ToolchainKind[] = [];
  await startBackgroundJudgePrewarm(false, dependencies(compiled));
  assert.deepEqual(compiled, ["cpp"]);
});

test("macOS prewarm keeps the textual compatibility header without generating unused GCC PCH", async (t) => {
  t.mock.property(process, "platform", "darwin");
  t.mock.method(executorClient, "start", async () => ({ ...executorClient.health, ready: true }));
  const compiled: ToolchainKind[] = [];
  const deps = dependencies(compiled);
  deps.ensureUniversalCppPch = async () => { throw new Error("CLANG_GCH_MUST_NOT_BE_GENERATED"); };
  assert.deepEqual(await executeJudgePrewarm(deps, ["cpp"]), { status: "completed" });
  assert.deepEqual(compiled, ["cpp"]);
});

test("C-only warmup does not resolve or prepare C++", async (t) => {
  t.mock.method(executorClient, "start", async () => ({ ...executorClient.health, ready: true }));
  const compiled: ToolchainKind[] = [];
  const deps = dependencies(compiled);
  const resolveToolchain = deps.resolveNativeProtectedToolchain!;
  deps.resolveNativeProtectedToolchain = (kind) => {
    assert.equal(kind, "c");
    return resolveToolchain(kind);
  };
  await executeJudgePrewarm(deps, ["c"]);
  assert.deepEqual(compiled, ["c"]);
});

test("C++ session completes while unrelated C warmup is blocked", async (t) => {
  t.mock.method(executorClient, "start", async () => ({ ...executorClient.health, ready: true }));
  resetJudgePrewarmStateForTests();
  t.after(resetJudgePrewarmStateForTests);
  const compiled: ToolchainKind[] = [];
  const deps = dependencies(compiled);
  await startBackgroundJudgePrewarm(false, deps);
  let releaseC: () => void = () => {};
  const blockedC = new Promise<void>((resolve) => { releaseC = resolve; });
  const prepare = deps.prepareManagedToolchainComponent!;
  deps.prepareManagedToolchainComponent = async (...args) => {
    if (args[0] === "c") await blockedC;
    return prepare(...args);
  };
  const cTask = startBackgroundJudgePrewarm(false, deps, ["c"]);
  try {
    const cppReady = ensureJudgePrewarmReady(undefined, undefined, undefined, deps, ["cpp"]);
    const completed = await Promise.race([
      cppReady.then(() => true),
      new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
    ]);
    assert.equal(completed, true, "C++ must not wait for C preparation");
    assert.deepEqual(compiled, ["cpp"]);
  } finally {
    releaseC();
    await cTask;
  }
});

test("mixed warmup retains ownership of pending C preparation after C++ rejects", async (t) => {
  t.mock.method(executorClient, "start", async () => ({ ...executorClient.health, ready: true }));
  resetJudgePrewarmStateForTests();
  t.after(resetJudgePrewarmStateForTests);
  const deps = dependencies([]);
  const failure = new Error("CPP_PREPARATION_FAILED");
  let releaseC: () => void = () => {};
  const blockedC = new Promise<void>((resolve) => { releaseC = resolve; });
  const prepare = deps.prepareManagedToolchainComponent!;
  deps.prepareManagedToolchainComponent = async (...args) => {
    if (args[0] === "cpp") throw failure;
    await blockedC;
    return prepare(...args);
  };
  let settled = false;
  const mixed = startBackgroundJudgePrewarm(false, deps, ["cpp", "c"]);
  const checked = assert.rejects(mixed, (error: unknown) => error === failure)
    .then(() => { settled = true; });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "pending C must remain owned after C++ fails");
  } finally {
    releaseC();
    await checked;
  }
});

test("a cached C++ failure does not prevent a C-only session from warming", async (t) => {
  t.mock.method(executorClient, "start", async () => ({ ...executorClient.health, ready: true }));
  resetJudgePrewarmStateForTests();
  t.after(resetJudgePrewarmStateForTests);
  const compiled: ToolchainKind[] = [];
  const deps = dependencies(compiled);
  const failure = new Error("CPP_STARTUP_FAILED");
  const prepare = deps.prepareManagedToolchainComponent!;
  deps.prepareManagedToolchainComponent = async (...args) => {
    if (args[0] === "cpp") throw failure;
    return prepare(...args);
  };
  await assert.rejects(startBackgroundJudgePrewarm(false, deps), (error: unknown) => error === failure);
  await ensureJudgePrewarmReady(undefined, undefined, undefined, deps, ["c"]);
  assert.deepEqual(compiled, ["c"]);
  await assert.rejects(ensureJudgePrewarmReady(), (error: unknown) => error === failure);
});

test("mixed native preparation does not overlap", async (t) => {
  t.mock.method(executorClient, "start", async () => ({ ...executorClient.health, ready: true }));
  resetJudgePrewarmStateForTests();
  t.after(resetJudgePrewarmStateForTests);
  const compiled: ToolchainKind[] = [];
  const deps = dependencies(compiled);
  const prepare = deps.prepareManagedToolchainComponent!;
  let compiling = false;
  deps.prepareManagedToolchainComponent = async (...args) => {
    assert.equal(compiling, false, "native preparation must share the single-run budget");
    compiling = true;
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return await prepare(...args);
    } finally {
      compiling = false;
    }
  };
  await startBackgroundJudgePrewarm(false, deps, ["cpp", "c"]);
  assert.deepEqual(compiled, ["cpp", "c"]);
});

test("mixed sessions reuse each completed warmup and refresh invalidates C too", async (t) => {
  t.mock.method(executorClient, "start", async () => ({ ...executorClient.health, ready: true }));
  resetJudgePrewarmStateForTests();
  t.after(resetJudgePrewarmStateForTests);
  const compiled: ToolchainKind[] = [];
  const deps = dependencies(compiled);
  await Promise.all([
    startBackgroundJudgePrewarm(false, deps, ["cpp", "c"]),
    startBackgroundJudgePrewarm(false, deps, ["cpp", "c"]),
  ]);
  assert.deepEqual(compiled, ["cpp", "c"]);
  await startBackgroundJudgePrewarm(true, deps);
  await startBackgroundJudgePrewarm(false, deps, ["c"]);
  assert.deepEqual(compiled, ["cpp", "c", "cpp", "c"]);
});
