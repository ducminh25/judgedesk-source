import assert from "node:assert/strict";
import test from "node:test";
import { runRustGates, runStep, MAX_RETAINED_OUTPUT_CHARS } from "./run-rust-gates.js";

const component = {
  name: "diagnostic-fixture",
  manifestPath: "nonexistent-gate-diagnostic-fixture/Cargo.toml",
  hasFmt: true,
  hasClippy: true,
  hasTest: true,
  testFlags: ["--no-fail-fast"],
};

function captureConsole(context) {
  const errors = [];
  context.mock.method(console, "log", () => {});
  context.mock.method(console, "error", (...values) => { errors.push(values.join(" ")); });
  return errors;
}

function failedChild() {
  return runStep(process.execPath, ["-e", [
    'console.log("thread lifecycle panicked: expected exactly one terminal event");',
    'for (let i = 0; i < 40; ++i) console.error("Running later_suite_" + i);',
    'process.exitCode = 1;',
  ].join("\n")], ".");
}

test("Rust gate exposes the failing assertion even when Cargo stderr has more than 25 later lines", (context) => {
  const child = failedChild();
  assert.equal(child.status, "FAIL");
  const errors = captureConsole(context);
  let invocations = 0;
  const { passed, runRecord } = runRustGates({
    targetComponents: [component],
    executeStep: () => { ++invocations; return child; },
  });

  assert.equal(passed, false);
  assert.equal(invocations, 3, "fmt, clippy and test must each run exactly once");
  assert.equal(runRecord.counts.failed, 3);
  assert.equal(runRecord.counts.skipped, 0);
  const output = errors.join("\n");
  assert.equal(output.match(/thread lifecycle panicked/g)?.length, 3, "each failed stage must retain its stdout assertion");
  assert.equal(output.match(/Running later_suite_39/g)?.length, 3, "each failed stage must retain its stderr");
  for (const result of runRecord.results) {
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, child.stdout, "JSON evidence must retain the stdout assertion");
    assert.equal(result.stderr, child.stderr, "JSON evidence must retain stderr independently");
  }
});

test("Rust gate records bounded failure streams without discarding the nonzero exit", (context) => {
  const child = runStep(process.execPath, ["-e", [
    'process.stdout.write("assertion-start\\n" + "x".repeat(150000) + "\\nassertion-end");',
    'process.stderr.write("cargo-start\\n" + "y".repeat(150000) + "\\ncargo-end");',
    'process.exitCode = 7;',
  ].join("\n")], ".");
  assert.equal(child.status, "FAIL");
  assert.equal(child.exitCode, 7);
  captureConsole(context);
  const { passed, runRecord } = runRustGates({
    targetComponents: [{ ...component, hasFmt: false, hasClippy: false }],
    executeStep: () => child,
  });
  assert.equal(passed, false);
  assert.equal(runRecord.counts.failed, 1);
  const [result] = runRecord.results;
  assert.equal(result.exitCode, 7);
  for (const [stream, first, last] of [
    ["stdout", "assertion-start", "assertion-end"],
    ["stderr", "cargo-start", "cargo-end"],
  ]) {
    assert.ok(result[stream].length <= MAX_RETAINED_OUTPUT_CHARS + 128);
    assert.ok(result[stream].startsWith(first));
    assert.ok(result[stream].endsWith(last));
    assert.match(result[stream], /truncated/);
  }
});

test("successful Rust steps keep their summaries compact without emitting child output", (context) => {
  const child = runStep(process.execPath, ["-e", 'console.log("successful child detail")'], ".");
  assert.equal(child.status, "PASS");
  const errors = captureConsole(context);
  const { passed, runRecord } = runRustGates({
    targetComponents: [component],
    executeStep: () => child,
  });
  assert.equal(passed, true);
  assert.deepEqual(errors, []);
  assert.equal(runRecord.counts.passed, 3);
  for (const result of runRecord.results) {
    assert.equal(result.exitCode, 0);
    assert.equal(Object.hasOwn(result, "stdout"), false);
    assert.equal(Object.hasOwn(result, "stderr"), false);
  }
});
