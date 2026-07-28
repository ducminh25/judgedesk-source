import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { clearToolchainDetectionCache, findSystemPython } from "../toolchains/resolver.js";
import {
  isDescendant,
  managedToolchainSourceRoot,
  rewriteManagedToolchainSymlinks,
} from "../executor/workspace.js";
import {
  chooseCompilationToolchain,
  compileSubmission,
} from "./compiler.js";

test("production testcase runner has no raw child-process or broad macOS profile path", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "server", "judge", "testcase-runner.ts"), "utf8");
  assert.doesNotMatch(source, /from ["'](?:node:)?child_process["']/);
  assert.doesNotMatch(source, /tree-kill|sandbox-exec|\(allow file-read\*\)/);
  assert.match(source, /runReservedExecutor/);
  assert.doesNotMatch(source, /executorClient\.run/);
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

test("Python compilation honors the selected source and keeps the installed path stable", () => {
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
    ),
    selectedSystem,
  );
  assert.equal(
    chooseCompilationToolchain(
      "python",
      selectedSystem,
      { ...staleCache, executablePath: String.raw`C:\installed\python.exe` },
    ),
    selectedSystem,
  );
  const selectedManaged = {
    ...staleCache,
    executablePath: String.raw`C:\installed\python.exe`,
  };
  assert.equal(
    chooseCompilationToolchain(
      "python",
      selectedManaged,
      selectedManaged,
    ),
    selectedManaged,
  );
});

test("managed toolchain cache rewrites package symlinks inside the cache", {
  skip: process.platform === "win32",
}, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-python-symlink-"));
  const source = path.join(root, "source");
  const destination = path.join(root, "cache");
  fs.mkdirSync(path.join(source, "bin"), { recursive: true });
  fs.writeFileSync(path.join(source, "bin", "python3.12"), "python");
  fs.symlinkSync("python3.12", path.join(source, "bin", "python3"));
  fs.cpSync(source, destination, { recursive: true, dereference: true, force: false });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  rewriteManagedToolchainSymlinks(source, destination);

  const cachedLink = path.join(destination, "bin", "python3");
  assert.equal(fs.lstatSync(cachedLink).isSymbolicLink(), true);
  assert.equal(
    fs.realpathSync(cachedLink),
    fs.realpathSync(path.join(destination, "bin", "python3.12")),
  );
});

test("managed cache containment canonicalizes aliased macOS temporary roots", {
  skip: process.platform === "win32",
}, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "judgedesk-cache-alias-"));
  const realRoot = path.join(root, "real");
  const aliasRoot = path.join(root, "alias");
  const cachedExecutable = path.join(realRoot, "toolchains", "python", "bin", "python3");
  const outsideExecutable = path.join(root, "outside-python3");
  fs.mkdirSync(path.dirname(cachedExecutable), { recursive: true });
  fs.writeFileSync(cachedExecutable, "python");
  fs.writeFileSync(outsideExecutable, "outside");
  fs.symlinkSync(realRoot, aliasRoot, "dir");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.equal(
    isDescendant(
      path.join(aliasRoot, "toolchains", "python"),
      fs.realpathSync(cachedExecutable),
    ),
    true,
  );
  assert.equal(
    isDescendant(path.join(aliasRoot, "toolchains", "python"), outsideExecutable),
    false,
  );
});
