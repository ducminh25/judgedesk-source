#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const MANDATORY_RUST_COMPONENTS = Object.freeze([
  {
    name: "native-executor",
    manifestPath: "native-executor/Cargo.toml",
    hasFmt: true,
    hasClippy: true,
    hasTest: true,
    testFlags: ["--no-fail-fast", "--", "--test-threads=1"],
  },
  {
    name: "crates/judgedesk-core",
    manifestPath: "crates/judgedesk-core/Cargo.toml",
    hasFmt: true,
    hasClippy: true,
    hasTest: true,
    testFlags: ["--no-fail-fast", "--", "--test-threads=1"],
  },
  {
    name: "src-tauri",
    manifestPath: "src-tauri/Cargo.toml",
    hasFmt: true,
    hasClippy: true,
    hasTest: true,
    testFlags: ["--no-fail-fast"],
  },
]);

export const DEFAULT_STEP_TIMEOUT_MS = 600_000;
export const DEFAULT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
export const MAX_RETAINED_OUTPUT_CHARS = 100_000;

export function truncateBoundedOutput(str, maxChars = MAX_RETAINED_OUTPUT_CHARS) {
  if (!str || str.length <= maxChars) return str || "";
  const keep = Math.floor(maxChars / 2);
  const head = str.slice(0, keep);
  const tail = str.slice(-keep);
  const omitted = str.length - head.length - tail.length;
  return `${head}\n[... truncated ${omitted} characters due to output bounds ...]\n${tail}`;
}

export function runStep(command, args, cwd, stepOptions = {}) {
  const startedAt = new Date().toISOString();
  const startTime = Date.now();
  const timeoutMs = stepOptions.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const maxBufferBytes = stepOptions.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;

  let res;
  let spawnError = null;
  try {
    res = spawnSync(command, args, {
      cwd: path.resolve(repoRoot, cwd),
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      env: { ...process.env, ...(stepOptions.env || {}) },
      timeout: timeoutMs,
      maxBuffer: maxBufferBytes,
    });
  } catch (err) {
    spawnError = err;
  }

  const durationMs = Date.now() - startTime;
  const finishedAt = new Date().toISOString();

  const err = spawnError || res?.error || null;
  const isTimeout = Boolean(
    (err && (err.code === "ETIMEDOUT" || /timed?\s*out/i.test(err.message))) ||
    (res && res.signal === "SIGTERM" && durationMs >= timeoutMs * 0.9)
  );
  const isMaxBuffer = Boolean(
    err &&
    (err.code === "ENOBUFS" ||
     err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
     err.name === "RangeError" ||
     /maxBuffer/i.test(err.message))
  );

  let rawStdout = res?.stdout || "";
  let rawStderr = res?.stderr || "";
  if (err && !rawStderr.includes(err.message)) {
    rawStderr = rawStderr ? `${rawStderr}\n[spawn error: ${err.message}]` : `[spawn error: ${err.message}]`;
  }

  const stdout = truncateBoundedOutput(rawStdout);
  const stderr = truncateBoundedOutput(rawStderr);

  const passed = !err && res?.status === 0;
  const status = passed ? "PASS" : "FAIL";
  let exitCode = res?.status;
  if (exitCode === undefined || exitCode === null) {
    exitCode = isTimeout ? 124 : 1;
  }

  return {
    command: `${command} ${args.join(" ")}`,
    cwd,
    status,
    exitCode,
    signal: res?.signal ?? null,
    durationMs,
    startedAt,
    finishedAt,
    timedOut: isTimeout,
    outputLimitExceeded: isMaxBuffer,
    error: err ? err.message : null,
    stdout,
    stderr,
  };
}

export function runRustGates(options = {}) {
  const {
    jsonOutput = false,
    targetComponents = MANDATORY_RUST_COMPONENTS,
    stepTimeoutMs = DEFAULT_STEP_TIMEOUT_MS,
    maxBufferBytes = DEFAULT_MAX_BUFFER_BYTES,
  } = options;
  const stepOptions = { timeoutMs: stepTimeoutMs, maxBufferBytes };
  const overallStart = Date.now();
  const results = [];
  let aggregatePassed = true;

  console.log(`[run-rust-gates] Running complete sequential Rust gates across ${targetComponents.length} component(s)...`);

  for (const comp of targetComponents) {
    console.log(`\n======================================================`);
    console.log(` Component: ${comp.name}`);
    console.log(`======================================================`);

    // 1. cargo fmt --check
    if (comp.hasFmt) {
      console.log(`[${comp.name}] Step 1/3: cargo fmt --check...`);
      const fmtRes = runStep("cargo", ["fmt", "--check", "--manifest-path", comp.manifestPath], ".", stepOptions);
      results.push({ component: comp.name, step: "fmt", ...fmtRes });
      if (fmtRes.status !== "PASS") {
        aggregatePassed = false;
        const reason = fmtRes.timedOut
          ? `timed out after ${fmtRes.durationMs}ms`
          : fmtRes.outputLimitExceeded
          ? "output buffer limit exceeded"
          : "failed";
        console.error(`  FAIL: cargo fmt --check ${reason} for ${comp.name} (${fmtRes.durationMs}ms)`);
        if (fmtRes.stderr || fmtRes.stdout) {
          console.error((fmtRes.stderr || fmtRes.stdout).trim());
        }
      } else {
        console.log(`  PASS: cargo fmt clean (${fmtRes.durationMs}ms)`);
      }
    }

    // 2. cargo clippy --locked --manifest-path ... --all-targets -- -D warnings
    if (comp.hasClippy) {
      console.log(`[${comp.name}] Step 2/3: cargo clippy --locked --all-targets -- -D warnings...`);
      const clippyRes = runStep(
        "cargo",
        ["clippy", "--locked", "--manifest-path", comp.manifestPath, "--all-targets", "--", "-D", "warnings"],
        ".",
        stepOptions,
      );
      results.push({ component: comp.name, step: "clippy", ...clippyRes });
      if (clippyRes.status !== "PASS") {
        aggregatePassed = false;
        const reason = clippyRes.timedOut
          ? `timed out after ${clippyRes.durationMs}ms`
          : clippyRes.outputLimitExceeded
          ? "output buffer limit exceeded"
          : "failed";
        console.error(`  FAIL: cargo clippy ${reason} for ${comp.name} (${clippyRes.durationMs}ms)`);
        if (clippyRes.stderr || clippyRes.stdout) {
          console.error((clippyRes.stderr || clippyRes.stdout).trim());
        }
      } else {
        console.log(`  PASS: cargo clippy clean (${clippyRes.durationMs}ms)`);
      }
    }

    // 3. cargo test --locked --manifest-path ...
    if (comp.hasTest) {
      console.log(`[${comp.name}] Step 3/3: cargo test --locked ${comp.testFlags.join(" ")}...`);
      const testRes = runStep(
        "cargo",
        ["test", "--locked", "--manifest-path", comp.manifestPath, ...comp.testFlags],
        ".",
        stepOptions,
      );
      results.push({ component: comp.name, step: "test", ...testRes });
      if (testRes.status !== "PASS") {
        aggregatePassed = false;
        const reason = testRes.timedOut
          ? `timed out after ${testRes.durationMs}ms`
          : testRes.outputLimitExceeded
          ? "output buffer limit exceeded"
          : "failed";
        console.error(`  FAIL: cargo test ${reason} for ${comp.name} (${testRes.durationMs}ms)`);
        if (testRes.stderr || testRes.stdout) {
          // Print summary lines
          const out = (testRes.stdout + "\n" + testRes.stderr).trim();
          const tail = out.split("\n").slice(-25).join("\n");
          console.error(tail);
        }
      } else {
        console.log(`  PASS: cargo test passed (${testRes.durationMs}ms)`);
      }
    }
  }

  const overallDurationMs = Date.now() - overallStart;

  const passedCount = results.filter((r) => r.status === "PASS").length;
  const failedCount = results.filter((r) => r.status === "FAIL").length;

  console.log(`\n======================================================`);
  console.log(` Rust Gates Aggregate Summary: ${aggregatePassed ? "PASS" : "FAILED"}`);
  console.log(` Total steps: ${results.length} | Passed: ${passedCount} | Failed: ${failedCount} | Duration: ${overallDurationMs}ms`);
  console.log(`======================================================`);

  for (const r of results) {
    const symbol = r.status === "PASS" ? "✓" : "✗";
    console.log(` ${symbol} [${r.component}] ${r.step.padEnd(8)}: ${r.status} (${r.durationMs}ms)`);
  }

  const runRecord = {
    schemaVersion: 1,
    workPackage: "WP0.5",
    host: {
      os: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
      arch: os.arch(),
    },
    startedAt: new Date(overallStart).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: overallDurationMs,
    status: aggregatePassed ? "PASS" : "FAIL",
    counts: {
      total: results.length,
      passed: passedCount,
      failed: failedCount,
      skipped: 0,
    },
    results: results.map((r) => ({
      component: r.component,
      step: r.step,
      command: r.command,
      status: r.status,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      timedOut: r.timedOut,
      outputLimitExceeded: r.outputLimitExceeded,
    })),
  };

  if (jsonOutput) {
    console.log("\n" + JSON.stringify(runRecord, null, 2));
  }

  return { passed: aggregatePassed, runRecord };
}

export function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes("--json");
  const { passed } = runRustGates({ jsonOutput });
  process.exit(passed ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
