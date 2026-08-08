import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  buildLocalPythonEnvironment,
  clearLocalCompatibilityProbeCache,
  deriveLocalToolchain,
  isAcceptedLocalAbsolutePath,
  resolveCachedLocalExecution,
  scheduleLocalCompatibilityProbe,
} from "./local-execution.js";

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
  const resolved = resolveCachedLocalExecution("python", process.execPath, false);

  assert.equal(calls, 1);
  assert.equal(probe.status, "compatible");
  assert.equal(resolved.ready, true);
  assert.equal(resolved.derived?.identity.isolation, "strict");
  assert.equal(resolved.probe.status, "compatible");
});

test("resource-only is explicit and does not disguise a failed strict probe", async (t) => {
  clearLocalCompatibilityProbeCache();
  t.after(clearLocalCompatibilityProbeCache);
  await scheduleLocalCompatibilityProbe(
    "python",
    process.execPath,
    async () => {
      throw new Error("simulated strict sandbox failure");
    },
  );

  const strict = resolveCachedLocalExecution("python", process.execPath, false);
  const relaxed = resolveCachedLocalExecution("python", process.execPath, true);
  assert.equal(strict.ready, false);
  assert.equal(strict.probe.status, "incompatible");
  assert.match(strict.diagnostic || "", /simulated strict sandbox failure/);
  assert.equal(relaxed.ready, true);
  assert.equal(relaxed.derived?.identity.isolation, "resource-only");
  assert.equal(relaxed.probe.status, "incompatible");
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
  const derived = deriveLocalToolchain("python", process.execPath, "strict");
  assert.deepEqual(buildLocalPythonEnvironment(derived), {
    JUDGEDESK_PYTHON_ISOLATED: "1",
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONHOME: derived.identity.rootPath,
    PATH: path.dirname(derived.executablePath),
  });
});
