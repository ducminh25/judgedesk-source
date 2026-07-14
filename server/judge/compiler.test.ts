import assert from "node:assert/strict";
import test from "node:test";
import { buildSubmissionCompilerArgs, resolveChecker } from "./compiler";

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

test("standard checkers use the cross-platform built-in implementation", () => {
  assert.deepEqual(
    resolveChecker({
      checkerType: "C1",
      problemName: "sample",
      problemDirectory: ".",
      tempDirectory: ".",
    }),
    { path: null },
  );
});
