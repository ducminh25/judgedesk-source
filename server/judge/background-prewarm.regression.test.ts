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

function dependencies(compiled: ToolchainKind[]): PrewarmDependencies {
  return {
    waitForToolchainDiscovery: async () => ({
      schemaVersion: 2, registryRevision: 1, status: "complete", refreshing: false,
      completedAt: new Date().toISOString(), profiles: {},
    }),
    resolveNativeProtectedToolchain: (kind) => ({
      kind, source: "custom", ready: true, executablePath: `/${kind}/compiler`, version: "test",
      localToolchain: { rootPath: `/${kind}`, executableRelativePath: "compiler", isolation: "strict" },
    }),
    ensureUniversalCppPch: async () => null,
    compileSubmission: async (options) => {
      compiled.push(options.language);
      return { executablePath: "probe", compileStatus: "OK", compileError: "", compileTime: 0 };
    },
  };
}

test("background startup warms C++ without compiling C", async (t) => {
  t.mock.method(executorClient, "start", async () => ({ ...executorClient.health, ready: true }));
  resetJudgePrewarmStateForTests();
  t.after(resetJudgePrewarmStateForTests);
  const compiled: ToolchainKind[] = [];
  await startBackgroundJudgePrewarm(false, dependencies(compiled));
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
  const compile = deps.compileSubmission!;
  deps.compileSubmission = async (options) => {
    if (options.language === "c") await blockedC;
    return compile(options);
  };
  const cTask = startBackgroundJudgePrewarm(false, deps, ["c"]);
  try {
    const cppReady = ensureJudgePrewarmReady(undefined, undefined, undefined, deps, ["cpp"]);
    const completed = await Promise.race([
      cppReady.then(() => true),
      new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
    ]);
    assert.equal(completed, true, "C++ must not wait for the C probe");
    assert.deepEqual(compiled, ["cpp"]);
  } finally {
    releaseC();
    await cTask;
  }
});

test("mixed warmup retains ownership of pending C after C++ rejects", async (t) => {
  t.mock.method(executorClient, "start", async () => ({ ...executorClient.health, ready: true }));
  resetJudgePrewarmStateForTests();
  t.after(resetJudgePrewarmStateForTests);
  const deps = dependencies([]);
  const failure = new Error("CPP_PROBE_FAILED");
  let releaseC: () => void = () => {};
  const blockedC = new Promise<void>((resolve) => { releaseC = resolve; });
  const compile = deps.compileSubmission!;
  deps.compileSubmission = async (options) => {
    if (options.language === "cpp") throw failure;
    await blockedC;
    return compile(options);
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
  const compile = deps.compileSubmission!;
  deps.compileSubmission = async (options) => {
    if (options.language === "cpp") throw failure;
    return compile(options);
  };
  await assert.rejects(startBackgroundJudgePrewarm(false, deps), (error: unknown) => error === failure);
  await ensureJudgePrewarmReady(undefined, undefined, undefined, deps, ["c"]);
  assert.deepEqual(compiled, ["c"]);
  await assert.rejects(ensureJudgePrewarmReady(), (error: unknown) => error === failure);
});

test("mixed native probes do not overlap", async (t) => {
  t.mock.method(executorClient, "start", async () => ({ ...executorClient.health, ready: true }));
  resetJudgePrewarmStateForTests();
  t.after(resetJudgePrewarmStateForTests);
  const compiled: ToolchainKind[] = [];
  const deps = dependencies(compiled);
  const compile = deps.compileSubmission!;
  let compiling = false;
  deps.compileSubmission = async (options) => {
    assert.equal(compiling, false, "native probes must share the single-run budget");
    compiling = true;
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return await compile(options);
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
