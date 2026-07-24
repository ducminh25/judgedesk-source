import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { clearToolchainDetectionCache, findSystemPython } from "../toolchains/resolver.js";
import { managedToolchainSourceRoot } from "../executor/workspace.js";
import {
  chooseCompilationToolchain,
  compileSubmission,
} from "./compiler.js";

test("production testcase runner has no raw child-process or broad macOS profile path", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "server", "judge", "testcase-runner.ts"), "utf8");
  assert.doesNotMatch(source, /from ["'](?:node:)?child_process["']/);
  assert.doesNotMatch(source, /tree-kill|sandbox-exec|\(allow file-read\*\)/);
  assert.match(source, /executorClient\.run/);
});

test("managed macOS Python imports the complete package root instead of only bin", () => {
  const packageRoot = path.join(os.tmpdir(), "python-package");
  assert.equal(
    managedToolchainSourceRoot(path.join(packageRoot, "bin", "python3"), "bin/python3"),
    path.resolve(packageRoot),
  );
  assert.equal(
    managedToolchainSourceRoot(path.join(packageRoot, "python.exe"), "python.exe"),
    path.resolve(packageRoot),
  );
});

test("an unmanaged Python runtime fails closed instead of running on the host", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-python-fail-closed-"));
  const source = path.join(root, "sum.py");
  fs.writeFileSync(source, "print(42)\n", "utf8");
  t.after(() => {
    delete process.env.THEMIS_APP_DATA_DIR;
    clearToolchainDetectionCache();
    fs.rmSync(root, { recursive: true, force: true });
  });
  process.env.THEMIS_APP_DATA_DIR = path.join(root, "empty-app-data");
  clearToolchainDetectionCache();

  const detectedPython = findSystemPython();
  if (!detectedPython) {
    t.skip("No supported unmanaged Python runtime is installed on this test host.");
    return;
  }
  const compiled = await compileSubmission({
    language: "python",
    contestantName: "Alice",
    problemName: "SUM",
    submissionPath: source,
    tempDirectory: root,
    pythonToolchain: {
      kind: "python",
      source: "system",
      executablePath: detectedPython,
      version: "test",
      ready: true,
    },
  });
  assert.equal(compiled.compileStatus, "CE");
  assert.equal(compiled.compileError, "TOOLCHAIN_NOT_SANDBOX_COMPATIBLE");
});

test("an executor cache cannot keep submissions ready after managed Python is uninstalled", () => {
  const selectedSystem = {
    kind: "python" as const,
    source: "system" as const,
    executablePath: String.raw`C:\msys64\ucrt64\bin\python3.exe`,
    version: "3.14.5",
    ready: true,
  };
  const missingManaged = {
    kind: "python" as const,
    source: "managed" as const,
    executablePath: "",
    version: "",
    ready: false,
  };
  const staleCache = {
    kind: "python" as const,
    source: "managed" as const,
    executablePath: String.raw`C:\executor-cache\python.exe`,
    version: "3.12.13",
    ready: true,
  };

  assert.equal(
    chooseCompilationToolchain(
      "python",
      selectedSystem,
      missingManaged,
      staleCache,
    ),
    selectedSystem,
  );
  assert.equal(
    chooseCompilationToolchain(
      "python",
      selectedSystem,
      { ...staleCache, executablePath: String.raw`C:\installed\python.exe` },
      staleCache,
    ),
    staleCache,
  );
});
