import assert from "node:assert/strict";
import test from "node:test";
import { buildIsolatedPythonLaunch } from "./python-runtime.js";

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
