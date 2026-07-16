import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildSubmissionCompilerArgs,
  COMPILE_TIMEOUT_MS,
  MAX_GENERATED_FILE_BYTES,
  resolveChecker,
  runCompilerWithLimits,
} from "./compiler";

test("production compiler limits are 15 seconds and 32 MiB", () => {
  assert.equal(COMPILE_TIMEOUT_MS, 15_000);
  assert.equal(MAX_GENERATED_FILE_BYTES, 32 * 1024 * 1024);
});

test("compiler watchdog terminates a stuck compiler", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "themis-compiler-timeout-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(
    runCompilerWithLimits(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      root,
      path.join(root, "never-created.out"),
      undefined,
      { timeoutMs: 100, maxGeneratedFileBytes: 64 * 1024 },
    ),
    /COMPILER_TIMEOUT/,
  );
});

test("compiler rejects and removes an oversized generated file", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "themis-compiler-size-"));
  const outputPath = path.join(root, "oversized.out");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(
    runCompilerWithLimits(
      process.execPath,
      [
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], Buffer.alloc(131072))",
        outputPath,
      ],
      root,
      outputPath,
      undefined,
      { timeoutMs: 2_000, maxGeneratedFileBytes: 64 * 1024 },
    ),
    /GENERATED_FILE_TOO_LARGE/,
  );
  assert.equal(fs.existsSync(outputPath), false);
});

test("compiler flags retain Windows limits and avoid unsupported macOS flags", () => {
  const windows = buildSubmissionCompilerArgs(
    "win32",
    "source file.cpp",
    "output file.exe",
  );
  assert.ok(windows.includes("-static"));
  assert.ok(windows.includes("-Wl,--stack,66060288"));
  assert.equal(windows.includes('"source file.cpp"'), false);
  assert.ok(windows.includes("source file.cpp"));

  const mac = buildSubmissionCompilerArgs("darwin", "main.cpp", "main");
  assert.equal(mac.includes("-static"), false);
  assert.equal(
    mac.some((flag) => flag.includes("--stack")),
    false,
  );

  const linux = buildSubmissionCompilerArgs("linux", "main.cpp", "main");
  assert.ok(linux.includes("-static"));
  assert.equal(
    linux.some((flag) => flag.includes("--stack")),
    false,
  );
});

test("standard checkers use the cross-platform built-in implementation", async () => {
  assert.deepEqual(
    await resolveChecker({
      checkerType: "C1",
      problemName: "sample",
      problemDirectory: ".",
      tempDirectory: ".",
    }),
    { path: null },
  );
});
