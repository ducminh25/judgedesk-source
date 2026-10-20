import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  buildLocalPythonEnvironment,
  clearLocalCompatibilityProbeCache,
  deriveLocalToolchain,
  inferLocalToolchainRoot,
  isAcceptedLocalAbsolutePath,
  resolveCachedLocalExecution,
  scheduleLocalCompatibilityProbe,
} from "./local-execution.js";
import { getLocalExecutionPolicyFilePath } from "./execution-policy.js";

function useLegacyResourceOnlyPolicy(t: TestContext): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-local-admission-"));
  const previous = process.env.THEMIS_APP_DATA_DIR;
  process.env.THEMIS_APP_DATA_DIR = directory;
  fs.writeFileSync(getLocalExecutionPolicyFilePath(),
    '{"schemaVersion":1,"allowResourceOnlyLocalExecution":true}', "utf8");
  t.after(() => {
    if (previous === undefined) delete process.env.THEMIS_APP_DATA_DIR;
    else process.env.THEMIS_APP_DATA_DIR = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  });
}

test("a successful bounded probe admits the unchanged local image in strict mode", async (t) => {
  clearLocalCompatibilityProbeCache();
  t.after(clearLocalCompatibilityProbeCache);
  let calls = 0;
  const probe = await scheduleLocalCompatibilityProbe(
    "python",
    process.execPath,
    async () => {
      calls += 1;
    },
  );
  const resolved = resolveCachedLocalExecution("python", process.execPath);

  assert.equal(calls, 1);
  assert.equal(probe.status, "compatible");
  assert.equal(resolved.ready, true);
  assert.equal(resolved.derived?.identity.isolation, "strict");
  assert.equal(resolved.probe.status, "compatible");
});

test("failed strict probes cannot authorize resource-only local execution", async (t) => {
  useLegacyResourceOnlyPolicy(t);
  clearLocalCompatibilityProbeCache();
  t.after(clearLocalCompatibilityProbeCache);
  await scheduleLocalCompatibilityProbe(
    "python",
    process.execPath,
    async () => {
      throw new Error("simulated strict sandbox failure");
    },
  );

  const strict = resolveCachedLocalExecution("python", process.execPath);
  assert.equal(strict.ready, false);
  assert.equal(strict.probe.status, "incompatible");
  assert.match(strict.diagnostic || "", /simulated strict sandbox failure/);
  assert.equal(strict.derived?.identity.isolation, "strict");
});

test("pending probes cannot become ready through a resource-only policy override", async (t) => {
  useLegacyResourceOnlyPolicy(t);
  clearLocalCompatibilityProbeCache();
  t.after(clearLocalCompatibilityProbeCache);
  assert.equal(resolveCachedLocalExecution("python", process.execPath).ready, false);
  let complete: (() => void) | undefined;
  const pending = scheduleLocalCompatibilityProbe("python", process.execPath, () =>
    new Promise<void>((resolve) => { complete = resolve; }));
  await Promise.resolve();
  const checking = resolveCachedLocalExecution("python", process.execPath);
  assert.equal(checking.ready, false);
  assert.equal(checking.probe.status, "checking");
  assert.equal(checking.derived?.identity.isolation, "strict");
  assert.ok(complete);
  complete();
  await pending;
  assert.equal(resolveCachedLocalExecution("python", process.execPath).ready, true);
});

test("an invalidated probe completion cannot overwrite the newer successful probe", async (t) => {
  clearLocalCompatibilityProbeCache();
  t.after(clearLocalCompatibilityProbeCache);
  let failOld: ((error: Error) => void) | undefined;
  const old = scheduleLocalCompatibilityProbe("python", process.execPath, () =>
    new Promise<void>((_resolve, reject) => { failOld = reject; }));
  await Promise.resolve();
  clearLocalCompatibilityProbeCache();
  let replacementCalls = 0;
  const joined = scheduleLocalCompatibilityProbe("python", process.execPath, async () => {
    replacementCalls += 1;
  });
  assert.ok(failOld);
  failOld(new Error("outdated failure"));
  assert.equal((await old).status, "incompatible");
  await joined;
  assert.equal(replacementCalls, 0, "rescan must retain ownership until the old probe drains");
  const current = await scheduleLocalCompatibilityProbe("python", process.execPath, async () => {});
  assert.equal(current.status, "compatible");
  const admitted = resolveCachedLocalExecution("python", process.execPath);
  assert.equal(admitted.ready, true);
  assert.equal(admitted.probe.status, "compatible");
});

test("a discovery caller can cancel an already running resolver-owned probe", async (t) => {
  clearLocalCompatibilityProbeCache();
  t.after(clearLocalCompatibilityProbeCache);
  let ownedSignal: AbortSignal | undefined;
  let complete: (() => void) | undefined;
  const first = scheduleLocalCompatibilityProbe("python", process.execPath, async (_kind, _derived, signal) => {
    ownedSignal = signal;
    await new Promise<void>((resolve) => { complete = resolve; });
  });
  await Promise.resolve();
  const discovery = new AbortController();
  const joined = scheduleLocalCompatibilityProbe("python", process.execPath, async () => {
    throw new Error("duplicate probe");
  }, discovery.signal);
  discovery.abort();
  assert.ok(complete);
  complete();
  const result = await first;
  assert.strictEqual(joined, first);
  assert.equal(ownedSignal?.aborted, true, "joining abort must reach operation-owned signal");
  assert.equal(result.status, "incompatible", "aborted work cannot publish compatible even if runner returns");
  assert.equal(resolveCachedLocalExecution("python", process.execPath).ready, false);
});

test("clearing a pending probe prevents it from repopulating admission state", async (t) => {
  clearLocalCompatibilityProbeCache();
  t.after(clearLocalCompatibilityProbeCache);
  let complete: (() => void) | undefined;
  const old = scheduleLocalCompatibilityProbe("python", process.execPath, () =>
    new Promise<void>((resolve) => { complete = resolve; }));
  await Promise.resolve();
  clearLocalCompatibilityProbeCache();
  assert.ok(complete);
  complete();
  assert.equal((await old).status, "compatible");
  const resolved = resolveCachedLocalExecution("python", process.execPath);
  assert.equal(resolved.ready, false);
  assert.equal(resolved.probe.status, "not_started");
});

test("local path and Python environment contracts remain bounded", () => {
  assert.equal(
    isAcceptedLocalAbsolutePath(String.raw`C:\tools\python.exe`, "win32"),
    true,
  );
  assert.equal(
    isAcceptedLocalAbsolutePath(String.raw`\\server\share\python.exe`, "win32"),
    false,
  );
  assert.equal(
    isAcceptedLocalAbsolutePath(String.raw`\\?\C:\tools\python.exe`, "win32"),
    false,
  );
  assert.equal(
    inferLocalToolchainRoot(
      "python",
      "/opt/homebrew/Cellar/python@3.14/3.14.5/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python",
      "darwin",
    ),
    "/opt/homebrew/Cellar/python@3.14/3.14.5/Frameworks/Python.framework/Versions/3.14",
  );
  const derived = deriveLocalToolchain("python", process.execPath, "strict");
  assert.deepEqual(buildLocalPythonEnvironment(derived), {
    JUDGEDESK_PYTHON_ISOLATED: "1",
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONHOME: derived.identity.rootPath,
    PATH: path.dirname(derived.executablePath),
  });
});
