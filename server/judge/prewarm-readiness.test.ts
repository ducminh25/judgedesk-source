import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { executorClient } from "../executor/client.js";
import type { prepareManagedToolchainComponent as realPrepare } from "../executor/workspace.js";
import type { ResolvedToolchain } from "../toolchains/types.js";
import {
  ensureJudgePrewarmReady,
  resetJudgePrewarmStateForTests,
  type PrewarmDependencies,
} from "./background-prewarm.js";

type NativeKind = "cpp" | "c";
type ManagedReadinessDependencies = PrewarmDependencies & {
  prepareManagedToolchainComponent?: (...args: Parameters<typeof realPrepare>) => Promise<unknown>;
  ensureManagedCCompilerWarmup?: (toolchain: ResolvedToolchain, compilerPath: string) => Promise<void>;
};

function releaseBarrier(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function readinessDependencies(): PrewarmDependencies {
  return {
    waitForToolchainDiscovery: async () => ({
      schemaVersion: 2, registryRevision: 1, status: "complete", refreshing: false,
      completedAt: "2026-10-05T00:00:00.000Z", profiles: {},
    }),
    resolveNativeProtectedToolchain: (kind) => ({
      kind, source: "custom", ready: true, executablePath: `/${kind}/compiler`, version: "test",
      localToolchain: { rootPath: `/${kind}`, executableRelativePath: "compiler", isolation: "strict" },
    }),
    ensureUniversalCppPch: async () => null,
    compileSubmission: async () => ({
      executablePath: "unused-probe", compileStatus: "OK", compileError: "", compileTime: 0,
    }),
  };
}

function resetReadiness(t: TestContext): void {
  // Keep the Windows PCH and native preparation paths covered on every test host.
  t.mock.property(process, "platform", "win32");
  resetJudgePrewarmStateForTests();
  t.after(resetJudgePrewarmStateForTests);
}

const nativeRequirements: readonly (readonly NativeKind[])[] = [["cpp"], ["c"], ["cpp", "c"]];

for (const kinds of nativeRequirements) {
  test(`${kinds.join("+")} judge readiness finishes without a generic no-op compile/link`, async (t) => {
    resetReadiness(t);
    t.mock.method(executorClient, "start", async () => ({ ...executorClient.health, ready: true }));
    const optionalCompile = releaseBarrier();
    const compiled: NativeKind[] = [];
    const resolved: NativeKind[] = [];
    const deps = readinessDependencies();
    const resolve = deps.resolveNativeProtectedToolchain!;
    deps.resolveNativeProtectedToolchain = (kind) => {
      assert.ok(kind === "cpp" || kind === "c");
      resolved.push(kind);
      return resolve(kind);
    };
    deps.ensureUniversalCppPch = async () => {
      assert.ok(kinds.includes("cpp"), "C-only readiness must not prepare C++ PCH");
      return null;
    };
    deps.compileSubmission = async (options) => {
      assert.ok(options.language === "cpp" || options.language === "c");
      compiled.push(options.language);
      await optionalCompile.promise;
      return { executablePath: "unused-probe", compileStatus: "OK", compileError: "", compileTime: 0 };
    };
    let settled = false;
    const readiness = ensureJudgePrewarmReady(undefined, undefined, "test-job", deps, kinds);
    const observed = readiness.then(() => { settled = true; }, () => { settled = true; });
    try {
      await nextTurn();
      assert.equal(settled, true, "a real judge job must not wait for an optional generic compile/link");
      await readiness;
      assert.deepEqual(resolved, kinds);
      assert.deepEqual(compiled, [], "judge readiness must not perform the generic compile/link");
    } finally {
      optionalCompile.release();
      await Promise.allSettled([readiness, observed]);
    }
  });
}

test("an optional generic compiler exception cannot reject mixed judge readiness", async (t) => {
  resetReadiness(t);
  t.mock.method(executorClient, "start", async () => ({ ...executorClient.health, ready: true }));
  const deps = readinessDependencies();
  deps.compileSubmission = async () => { throw new Error("OPTIONAL_NOOP_COMPILER_FAILED"); };
  await ensureJudgePrewarmReady(undefined, undefined, "test-job", deps, ["cpp", "c"]);
});

test("judge readiness still waits for discovery, executor startup and C++ PCH preparation", async (t) => {
  resetReadiness(t);
  const discovery = releaseBarrier();
  const executor = releaseBarrier();
  const pch = releaseBarrier();
  let executorStarted = false;
  let pchStarted = false;
  t.mock.method(executorClient, "start", async () => {
    executorStarted = true;
    await executor.promise;
    return { ...executorClient.health, ready: true };
  });
  const deps = readinessDependencies();
  const discover = deps.waitForToolchainDiscovery!;
  deps.waitForToolchainDiscovery = async () => {
    await discovery.promise;
    return discover();
  };
  deps.ensureUniversalCppPch = async () => {
    pchStarted = true;
    await pch.promise;
    return null;
  };
  let settled = false;
  const readiness = ensureJudgePrewarmReady(undefined, undefined, "test-job", deps);
  const observed = readiness.then(() => { settled = true; }, () => { settled = true; });
  try {
    await nextTurn();
    assert.equal(settled, false, "discovery must complete before readiness");
    assert.equal(executorStarted, false);
    discovery.release();
    await nextTurn();
    assert.equal(executorStarted, true);
    assert.equal(settled, false, "executor startup must complete before readiness");
    assert.equal(pchStarted, false);
    executor.release();
    await nextTurn();
    assert.equal(pchStarted, true);
    assert.equal(settled, false, "PCH preparation must complete before readiness");
    pch.release();
    await readiness;
  } finally {
    discovery.release();
    executor.release();
    pch.release();
    await Promise.allSettled([readiness, observed]);
  }
});

for (const phase of ["discovery", "executor", "pch"] as const) {
  test(`judge readiness preserves the exact ${phase} preparation failure`, async (t) => {
    resetReadiness(t);
    const failure = new Error(`${phase.toUpperCase()}_PREPARATION_FAILED`);
    t.mock.method(executorClient, "start", async () => {
      if (phase === "executor") throw failure;
      return { ...executorClient.health, ready: true };
    });
    const deps = readinessDependencies();
    if (phase === "discovery") deps.waitForToolchainDiscovery = async () => { throw failure; };
    if (phase === "pch") deps.ensureUniversalCppPch = async () => { throw failure; };
    await assert.rejects(
      ensureJudgePrewarmReady(undefined, undefined, "test-job", deps),
      (error: unknown) => error === failure,
    );
    await assert.rejects(
      ensureJudgePrewarmReady(undefined, undefined, "later-job", deps),
      (error: unknown) => error === failure,
    );
  });
}

for (const kind of ["cpp", "c"] as const) {
  test(`${kind} judge readiness rejects a managed compiler without authenticated package identity`, async (t) => {
    resetReadiness(t);
    t.mock.method(executorClient, "start", async () => ({ ...executorClient.health, ready: true }));
    const deps = readinessDependencies();
    deps.resolveNativeProtectedToolchain = (requested) => ({
      kind: requested, source: "managed", packageOrigin: "built-in", ready: true,
      executablePath: "/unverified/compiler", version: "test",
    });
    await assert.rejects(
      ensureJudgePrewarmReady(undefined, undefined, "test-job", deps, [kind]),
      /TOOLCHAIN_NOT_SANDBOX_COMPATIBLE/,
    );
  });
}

test("mixed readiness retains ownership of C preparation after the original C++ failure", async (t) => {
  resetReadiness(t);
  t.mock.method(executorClient, "start", async () => ({ ...executorClient.health, ready: true }));
  const cDiscovery = releaseBarrier();
  const failure = new Error("CPP_PCH_PREPARATION_FAILED");
  const deps = readinessDependencies();
  const discover = deps.waitForToolchainDiscovery!;
  let discoveryCount = 0;
  deps.waitForToolchainDiscovery = async () => {
    if (++discoveryCount === 2) await cDiscovery.promise;
    return discover();
  };
  deps.ensureUniversalCppPch = async () => { throw failure; };
  let settled = false;
  const readiness = ensureJudgePrewarmReady(undefined, undefined, "test-job", deps, ["cpp", "c"]);
  const checked = assert.rejects(readiness, (error: unknown) => error === failure)
    .then(() => { settled = true; });
  try {
    await nextTurn();
    assert.equal(discoveryCount, 2, "C preparation must still be owned after C++ fails");
    assert.equal(settled, false, "mixed readiness must drain owned C preparation before rejecting");
  } finally {
    cDiscovery.release();
    await checked;
  }
});

test("a cached C++ preparation failure does not reject a C-only judge job", async (t) => {
  resetReadiness(t);
  t.mock.method(executorClient, "start", async () => ({ ...executorClient.health, ready: true }));
  const failure = new Error("CPP_PCH_PREPARATION_FAILED");
  const deps = readinessDependencies();
  deps.ensureUniversalCppPch = async () => { throw failure; };
  await assert.rejects(
    ensureJudgePrewarmReady(undefined, undefined, "cpp-job", deps),
    (error: unknown) => error === failure,
  );
  await ensureJudgePrewarmReady(undefined, undefined, "c-job", deps, ["c"]);
  await assert.rejects(
    ensureJudgePrewarmReady(undefined, undefined, "later-cpp-job", deps),
    (error: unknown) => error === failure,
  );
});

test("judge readiness still rejects an incomplete certified C++ pin without executing its probe", async (t) => {
  resetReadiness(t);
  t.mock.method(executorClient, "start", async () => ({ ...executorClient.health, ready: true }));
  const cpp: ResolvedToolchain = {
    kind: "cpp", source: "custom", ready: true, provenance: "certified-local",
    executablePath: "/unverified/compiler", version: "test",
  };
  await assert.rejects(
    ensureJudgePrewarmReady(cpp, "/unused/job-workspace", "test-job", readinessDependencies()),
    /TOOLCHAIN_PREFLIGHT_FAILED: certified local C\+\+ pin is incomplete/,
  );
});

function managedCSelection(executionPath?: string): ResolvedToolchain {
  return {
    kind: "c", source: "managed", ready: true, packageOrigin: "built-in", version: "test",
    executablePath: "/selected/c/gcc.exe", executionPath,
    packageRoot: "/fake/managed-package", packageDigest: "1".repeat(64), packageComponentId: "c-compiler",
  };
}

for (const executionPath of [undefined, "/selected/execution-copy/gcc.exe"]) {
  test("managed C readiness authenticates before warming the selected " + (executionPath ? "execution" : "executable") + " path", async (t) => {
    resetReadiness(t);
    t.mock.method(executorClient, "start", async () => ({ ...executorClient.health, ready: true }));
    const selected = managedCSelection(executionPath);
    const prepare = releaseBarrier();
    const compatibility = releaseBarrier();
    let preparing = false;
    let warming = false;
    let genericCompiled = false;
    const deps: ManagedReadinessDependencies = readinessDependencies();
    deps.resolveNativeProtectedToolchain = (kind) => {
      assert.equal(kind, "c", "C-only preparation must not resolve C++");
      return selected;
    };
    deps.prepareManagedToolchainComponent = async (kind, toolchain, componentId, role) => {
      preparing = true;
      assert.equal(kind, "c");
      assert.strictEqual(toolchain, selected);
      assert.equal(componentId, selected.packageComponentId);
      assert.equal(role, "compiler");
      await prepare.promise;
      return { executablePath: "/prepared/executor-cache/gcc.exe" };
    };
    deps.ensureManagedCCompilerWarmup = async (toolchain, compilerPath) => {
      warming = true;
      assert.strictEqual(toolchain, selected, "compatibility warm-up must use the selected package identity");
      assert.equal(compilerPath, executionPath || selected.executablePath);
      await compatibility.promise;
    };
    deps.compileSubmission = async () => {
      genericCompiled = true;
      return { executablePath: "unused-probe", compileStatus: "OK", compileError: "", compileTime: 0 };
    };
    let settled = false;
    const readiness = ensureJudgePrewarmReady(undefined, undefined, "c-job", deps, ["c"]);
    const observed = readiness.then(() => { settled = true; }, () => { settled = true; });
    try {
      await nextTurn();
      assert.equal(preparing, true, "managed package verification must be performed");
      assert.equal(warming, false, "compatibility warm-up must wait for successful verification");
      assert.equal(settled, false, "verified preparation must remain owned");
      prepare.release();
      await nextTurn();
      assert.equal(warming, true, "managed C compatibility warm-up must remain part of preparation");
      assert.equal(settled, false, "readiness must retain ownership of blocked compatibility warm-up");
      compatibility.release();
      await readiness;
      assert.equal(genericCompiled, false, "compatibility preparation must not add a second generic compile/link");
    } finally {
      prepare.release();
      compatibility.release();
      await Promise.allSettled([readiness, observed]);
    }
  });
}

test("managed C verified preparation failure rejects unchanged and never starts compatibility warm-up", async (t) => {
  resetReadiness(t);
  t.mock.method(executorClient, "start", async () => ({ ...executorClient.health, ready: true }));
  const failure = new Error("SIGNED_MANAGED_PACKAGE_REJECTED");
  const selected = managedCSelection();
  let warmups = 0;
  const deps: ManagedReadinessDependencies = readinessDependencies();
  deps.resolveNativeProtectedToolchain = () => selected;
  deps.prepareManagedToolchainComponent = async () => { throw failure; };
  deps.ensureManagedCCompilerWarmup = async () => { ++warmups; };
  await assert.rejects(
    ensureJudgePrewarmReady(undefined, undefined, "c-job", deps, ["c"]),
    (error: unknown) => error === failure,
  );
  await assert.rejects(
    ensureJudgePrewarmReady(undefined, undefined, "later-c-job", deps, ["c"]),
    (error: unknown) => error === failure,
  );
  assert.equal(warmups, 0, "failed package authentication must never execute its compiler");
});

test("a transient managed C compatibility failure does not poison cached or mixed judge readiness", async (t) => {
  resetReadiness(t);
  t.mock.method(executorClient, "start", async () => ({ ...executorClient.health, ready: true }));
  const selected = managedCSelection();
  const failure = new Error("TRANSIENT_MANAGED_C_COMPATIBILITY_FAILURE");
  let warmups = 0;
  let genericCompiles = 0;
  const deps: ManagedReadinessDependencies = readinessDependencies();
  const resolve = deps.resolveNativeProtectedToolchain!;
  deps.resolveNativeProtectedToolchain = (kind) => kind === "c" ? selected : resolve(kind);
  deps.prepareManagedToolchainComponent = async () => ({ executablePath: "/prepared/executor-cache/gcc.exe" });
  deps.ensureManagedCCompilerWarmup = async () => {
    ++warmups;
    throw failure;
  };
  deps.compileSubmission = async () => {
    ++genericCompiles;
    return { executablePath: "unused-probe", compileStatus: "CE", compileError: failure.message, compileTime: 0 };
  };
  await ensureJudgePrewarmReady(undefined, undefined, "c-job", deps, ["c"]);
  await ensureJudgePrewarmReady(undefined, undefined, "later-c-job", deps, ["c"]);
  await ensureJudgePrewarmReady(undefined, undefined, "mixed-job", deps, ["cpp", "c"]);
  assert.equal(warmups, 1, "the failed compatibility attempt must have been performed once without caching a readiness rejection");
  assert.equal(genericCompiles, 0, "generic compile/link must remain unnecessary after a compatibility failure");
});
