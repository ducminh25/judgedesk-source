import assert from "node:assert/strict";
import test from "node:test";
import { deriveLocalToolchain } from "./local-execution.js";
import {
  createLocalProbeRegistry,
  LocalProbeCleanupUnconfirmedError,
} from "./local-probe-registry.js";

function deferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => { throw new Error("Deferred promise not initialized"); };
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

test("clearing admission cannot release ownership of an in-flight probe", async () => {
  const registry = createLocalProbeRegistry();
  const derived = deriveLocalToolchain("python", process.execPath);
  const release = deferredVoid();
  let calls = 0;
  const first = registry.schedule("python", derived, async () => {
    calls += 1;
    await release.promise;
  });
  await Promise.resolve();
  registry.clear();
  const joined = registry.schedule("python", derived, async () => { calls += 1; });
  assert.strictEqual(first, joined);
  assert.equal(registry.get("python", derived)?.status, "checking");
  release.resolve();
  await first;
  assert.equal(calls, 1);
  assert.equal(registry.get("python", derived), undefined, "invalidated completion cannot publish");
  await registry.schedule("python", derived, async () => { calls += 1; });
  assert.equal(calls, 2);
  assert.equal(registry.get("python", derived)?.status, "compatible");
});

test("operation ownership survives metadata changes at the same executable path", async () => {
  const registry = createLocalProbeRegistry();
  const derived = deriveLocalToolchain("python", process.execPath);
  const release = deferredVoid();
  const first = registry.schedule("python", derived, async () => release.promise);
  const changed = { ...derived, fingerprint: "changed-metadata" };
  let replacementCalls = 0;
  const joined = registry.schedule("python", changed, async () => { replacementCalls += 1; });
  assert.strictEqual(joined, first);
  release.resolve();
  await first;
  assert.equal(replacementCalls, 0);
  assert.equal(registry.get("python", changed), undefined, "old image cannot admit changed image");
});

test("shutdown cancels and awaits resolver-owned work without any caller signal", async () => {
  const registry = createLocalProbeRegistry();
  const derived = deriveLocalToolchain("python", process.execPath);
  const release = deferredVoid();
  let signal: AbortSignal | undefined;
  const probe = registry.schedule("python", derived, async (_kind, _derived, ownedSignal) => {
    signal = ownedSignal;
    await release.promise;
  });
  await Promise.resolve();
  let drained = false;
  const drain = registry.drain().then(() => { drained = true; });
  assert.equal(signal?.aborted, true);
  await Promise.resolve();
  assert.equal(drained, false, "abort is not completion");
  let lateCalls = 0;
  assert.equal((await registry.schedule("python", derived, async () => { lateCalls += 1; })).status, "incompatible");
  assert.equal(lateCalls, 0, "shutdown seals new probe admission");
  release.resolve();
  assert.equal((await probe).status, "incompatible");
  await drain;
  assert.equal(drained, true);
});

test("cleanup uncertainty remains visible to shutdown and blocks replacement after rescan", async () => {
  const registry = createLocalProbeRegistry();
  const derived = deriveLocalToolchain("python", process.execPath);
  const error = new LocalProbeCleanupUnconfirmedError("owned run did not drain");
  const first = registry.schedule("python", derived, async () => { throw error; });
  await assert.rejects(first, (failure) => failure === error);
  registry.clear();
  let replacementCalls = 0;
  const changed = { ...derived, fingerprint: "changed-metadata" };
  const joined = registry.schedule("python", changed, async () => { replacementCalls += 1; });
  await assert.rejects(joined, (failure) => failure === error);
  assert.equal(replacementCalls, 0);
  assert.equal(registry.get("python", changed)?.status, "incompatible");
  assert.match(registry.get("python", changed)?.diagnostic || "", /cleanup-unconfirmed/);
  await assert.rejects(registry.drain(), AggregateError);
  await assert.rejects(registry.drain(), AggregateError, "a second shutdown must not forget retained errors");
});

test("caller abort forwarding is detached after a probe settles", async () => {
  const registry = createLocalProbeRegistry();
  const derived = deriveLocalToolchain("python", process.execPath);
  const caller = new AbortController();
  let ownedSignal: AbortSignal | undefined;
  await registry.schedule("python", derived, async (_kind, _derived, signal) => {
    ownedSignal = signal;
  }, caller.signal);
  caller.abort();
  assert.equal(ownedSignal?.aborted, false);
  assert.equal(registry.get("python", derived)?.status, "compatible");
});

test("shutdown revokes previously compatible admission even after cache clear", async () => {
  const registry = createLocalProbeRegistry();
  const derived = deriveLocalToolchain("python", process.execPath);
  await registry.schedule("python", derived, async () => {});
  assert.equal(registry.get("python", derived)?.status, "compatible");
  await registry.drain();
  assert.equal(registry.get("python", derived)?.status, "incompatible");
  assert.match(registry.get("python", derived)?.diagnostic || "", /stopping/);
  registry.clear();
  assert.equal(registry.get("python", derived)?.status, "incompatible");
});
