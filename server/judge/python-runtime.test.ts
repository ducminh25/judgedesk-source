import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { deriveLocalToolchain } from "../toolchains/local-execution.js";
import {
  buildIsolatedPythonLaunch,
  prepareIsolatedPythonRuntime,
} from "./python-runtime.js";

test("managed Python launch preserves isolation arguments and environment", () => {
  assert.deepEqual(
    buildIsolatedPythonLaunch({
      executableId: "toolchains/python",
      scriptPath: "workspace/submission.py",
      pythonHome: "toolchains/python/root",
      pythonBinDirectory: "toolchains/python/root/bin",
    }),
    {
      executableId: "toolchains/python",
      args: ["-I", "-B", "workspace/submission.py"],
      environment: {
        JUDGEDESK_PYTHON_ISOLATED: "1",
        PYTHONNOUSERSITE: "1",
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONHOME: "toolchains/python/root",
        PATH: "toolchains/python/root/bin",
      },
    },
  );
});

test("local Python runtime preserves the pinned grant and isolated environment", async () => {
  const derived = deriveLocalToolchain("python", process.execPath, "resource-only");
  const runtime = await prepareIsolatedPythonRuntime(process.execPath, {
    kind: "python",
    source: "custom",
    executablePath: process.execPath,
    version: "test",
    ready: true,
    provenance: "unverified-local",
    localToolchain: derived.identity,
  });

  assert.equal(runtime.executableId, derived.executableId);
  assert.deepEqual(runtime.localToolchain, derived.identity);
  assert.equal(runtime.environment.PYTHONHOME, derived.identity.rootPath);
  assert.equal(runtime.environment.PATH, path.dirname(derived.executablePath));
  assert.equal(runtime.environment.PYTHONNOUSERSITE, "1");
  assert.equal(runtime.toolchain, undefined);
});
