import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runStep, runRustGates } from "./run-rust-gates.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readText(relPath: string): string {
  return fs.readFileSync(path.join(repoRoot, relPath), "utf8");
}

export function validatePackageJsonComposition(pkgJsonText: string): void {
  const pkg = JSON.parse(pkgJsonText);
  assert.ok(pkg.scripts["test:rust"], "package.json must define 'test:rust'");
  assert.match(
    pkg.scripts["test:rust"],
    /scripts\/run-rust-gates\.js/,
    "'test:rust' must invoke scripts/run-rust-gates.js"
  );

  assert.ok(pkg.scripts["check:rust"], "package.json must define 'check:rust'");
  assert.equal(
    pkg.scripts["check:rust"],
    "npm run test:rust",
    "'check:rust' must alias 'npm run test:rust'"
  );

  const checkFull = pkg.scripts["check:full"];
  assert.ok(checkFull, "package.json must define 'check:full'");
  assert.ok(
    checkFull.includes("npm run test:rust"),
    "'check:full' must compose 'npm run test:rust'"
  );

  // Check ordering in check:full: check:fast -> test:rust -> test:server
  const fastIdx = checkFull.indexOf("npm run check:fast");
  const rustIdx = checkFull.indexOf("npm run test:rust");
  const serverIdx = checkFull.indexOf("npm run test:server");

  assert.ok(fastIdx !== -1, "'check:full' must include 'npm run check:fast'");
  assert.ok(rustIdx > fastIdx, "'test:rust' must run after 'check:fast'");
  assert.ok(serverIdx > rustIdx, "'test:server' must run after 'test:rust'");
}

export function validateRunRustGatesScript(scriptText: string): void {
  // Required components
  const requiredComponents = ["crates/judgedesk-core", "native-executor", "src-tauri"];
  for (const comp of requiredComponents) {
    assert.ok(
      scriptText.includes(comp),
      `run-rust-gates.js must target component '${comp}'`
    );
  }

  // Required Clippy flags: --locked, --all-targets, -D warnings
  assert.ok(
    scriptText.includes("--locked"),
    "run-rust-gates.js must pass --locked to cargo invocations"
  );
  assert.ok(
    scriptText.includes("--all-targets"),
    "run-rust-gates.js must pass --all-targets to clippy"
  );
  assert.ok(
    scriptText.includes("-D warnings") || scriptText.includes("'-D', 'warnings'"),
    "run-rust-gates.js must pass -D warnings to clippy"
  );

  // Required test flags: --no-fail-fast
  assert.ok(
    scriptText.includes("--no-fail-fast"),
    "run-rust-gates.js must pass --no-fail-fast to cargo test"
  );

  // Prohibit cargo fmt --locked (fmt does not accept --locked in stable cargo)
  assert.ok(
    !/fmt[^;]*--locked/.test(scriptText),
    "run-rust-gates.js must NOT invent 'cargo fmt --locked'"
  );

  // Required ordering: fmt -> clippy -> test
  const fmtIdx = scriptText.indexOf('step: "fmt"');
  const clippyIdx = scriptText.indexOf('step: "clippy"');
  const testIdx = scriptText.indexOf('step: "test"');
  assert.ok(fmtIdx !== -1 && clippyIdx !== -1 && testIdx !== -1, "Must contain fmt, clippy, and test stages");
  assert.ok(fmtIdx < clippyIdx, "fmt stage must precede clippy stage");
  assert.ok(clippyIdx < testIdx, "clippy stage must precede test stage");

  // Required bounded execution policy: timeout, maxBuffer, truncation
  assert.ok(
    scriptText.includes("timeout:") && scriptText.includes("DEFAULT_STEP_TIMEOUT_MS"),
    "run-rust-gates.js must enforce bounded timeout in child execution"
  );
  assert.ok(
    scriptText.includes("maxBuffer:") && scriptText.includes("DEFAULT_MAX_BUFFER_BYTES"),
    "run-rust-gates.js must enforce bounded maxBuffer in child execution"
  );
  assert.ok(
    scriptText.includes("timedOut") && scriptText.includes("outputLimitExceeded"),
    "run-rust-gates.js must track and record timedOut and outputLimitExceeded"
  );
  assert.ok(
    scriptText.includes("truncateBoundedOutput"),
    "run-rust-gates.js must implement bounded output truncation"
  );

  // Aggregation & continue-on-failure verification
  assert.ok(
    scriptText.includes("failures") || scriptText.includes("failed"),
    "run-rust-gates.js must collect failures across stages"
  );
  assert.ok(
    /process\.exit\s*\(\s*(?:passed\s*\?\s*0\s*:\s*1|1|exitCode)\s*\)/.test(scriptText),
    "run-rust-gates.js must exit nonzero if any failure occurred"
  );
}

export function validateCiWorkflowComposition(ciYamlText: string): void {
  // rust-toolchain components must install both rustfmt and clippy
  assert.match(
    ciYamlText,
    /components:\s*rustfmt,\s*clippy/,
    "ci.yml must install both rustfmt and clippy in dtolnay/rust-toolchain"
  );

  // Windows and macOS must invoke npm run test:rust
  assert.ok(
    ciYamlText.includes("npm run test:rust"),
    "ci.yml must invoke npm run test:rust"
  );
  assert.match(
    ciYamlText,
    /runner\.os\s*!=\s*['"]Linux['"]/,
    "ci.yml must execute test:rust on non-Linux runners (Windows & macOS)"
  );
}

export function validateQualityGateIntegration(qualityGateText: string): void {
  assert.ok(
    qualityGateText.includes("checkScoringBoundaryGate") && qualityGateText.includes("check-scoring-boundary.js"),
    "check-quality-gate.js must integrate check-scoring-boundary.js"
  );
  assert.ok(
    qualityGateText.includes("checkRustInvariantsGate") && qualityGateText.includes("check-rust-runtime-invariants.js"),
    "check-quality-gate.js must integrate check-rust-runtime-invariants.js"
  );
  assert.ok(
    qualityGateText.includes("checkExpectedSkipsGate") && qualityGateText.includes("check-expected-skips.js"),
    "check-quality-gate.js must integrate check-expected-skips.js"
  );
  assert.ok(
    qualityGateText.includes("checkEntryPointGraphGate") && qualityGateText.includes("check-entry-point-graph.js"),
    "check-quality-gate.js must integrate check-entry-point-graph.js"
  );
}

export function validateCandidateSourceFreezeClosure(freezeScriptText: string): void {
  const requiredRootBuildInputs = [
    ".nvmrc",
    "rust-toolchain.toml",
    "sea-config.json",
    "server-bootstrap.ts",
    "server.ts",
  ];

  for (const input of requiredRootBuildInputs) {
    assert.ok(
      freezeScriptText.includes(`"${input}"`),
      `freeze-candidate-source.ps1 must inventory required root build input '${input}'`,
    );
  }
}

test("structural gate: package.json script composition and ordering", () => {
  const pkgText = readText("package.json");
  validatePackageJsonComposition(pkgText);
});

test("structural gate: run-rust-gates.js components, flags, and aggregation", () => {
  const scriptText = readText("scripts/run-rust-gates.js");
  validateRunRustGatesScript(scriptText);
});

test("structural gate: ci.yml toolchain and test:rust composition", () => {
  const ciText = readText(".github/workflows/ci.yml");
  validateCiWorkflowComposition(ciText);
});

test("structural gate: check-quality-gate.js gate integration", () => {
  const qgText = readText("scripts/check-quality-gate.js");
  validateQualityGateIntegration(qgText);
});

test("structural gate: candidate source freeze includes root build inputs", () => {
  validateCandidateSourceFreezeClosure(
    readText("docs/verification/pure-rust-core/artifacts/wp0.5/freeze-candidate-source.ps1"),
  );
});

test("structural gate mutation testing: detecting regressions", () => {
  const pkgText = readText("package.json");
  const scriptText = readText("scripts/run-rust-gates.js");
  const ciText = readText(".github/workflows/ci.yml");

  // Mutation 1: removing test:rust from check:full
  assert.throws(() => {
    validatePackageJsonComposition(pkgText.replace("npm run test:rust && ", ""));
  }, /'check:full' must compose 'npm run test:rust'/);

  // Mutation 2: reordering test:server before test:rust
  assert.throws(() => {
    validatePackageJsonComposition(
      pkgText.replace(
        "npm run test:rust && npm run test:server",
        "npm run test:server && npm run test:rust"
      )
    );
  }, /'test:server' must run after 'test:rust'/);

  // Mutation 3: removing --locked from run-rust-gates.js
  assert.throws(() => {
    validateRunRustGatesScript(scriptText.replaceAll("--locked", "--not-locked"));
  }, /run-rust-gates\.js must pass --locked/);

  // Mutation 4: removing --all-targets from clippy
  assert.throws(() => {
    validateRunRustGatesScript(scriptText.replaceAll("--all-targets", ""));
  }, /run-rust-gates\.js must pass --all-targets/);

  // Mutation 5: removing -D warnings from clippy
  assert.throws(() => {
    validateRunRustGatesScript(scriptText.replaceAll("-D warnings", ""));
  }, /run-rust-gates\.js must pass -D warnings/);

  // Mutation 6: removing --no-fail-fast from cargo test
  assert.throws(() => {
    validateRunRustGatesScript(scriptText.replaceAll("--no-fail-fast", ""));
  }, /run-rust-gates\.js must pass --no-fail-fast/);

  // Mutation 7: removing component crates/judgedesk-core
  assert.throws(() => {
    validateRunRustGatesScript(scriptText.replaceAll("crates/judgedesk-core", "crates/missing"));
  }, /run-rust-gates\.js must target component 'crates\/judgedesk-core'/);

  // Mutation 8: removing clippy from CI
  assert.throws(() => {
    validateCiWorkflowComposition(ciText.replace("components: rustfmt, clippy", "components: rustfmt"));
  }, /ci\.yml must install both rustfmt and clippy/);

  // Mutation 9: inventing cargo fmt --locked
  assert.throws(() => {
    validateRunRustGatesScript(scriptText.replace("cargo fmt", "cargo fmt --locked"));
  }, /run-rust-gates\.js must NOT invent 'cargo fmt --locked'/);

  // Mutation 10: removing timeout enforcement from run-rust-gates.js
  assert.throws(() => {
    validateRunRustGatesScript(scriptText.replaceAll("timeout:", "unboundedTimeout:"));
  }, /run-rust-gates\.js must enforce bounded timeout in child execution/);

  // Mutation 11: removing maxBuffer enforcement from run-rust-gates.js
  assert.throws(() => {
    validateRunRustGatesScript(scriptText.replaceAll("maxBuffer:", "unboundedBuffer:"));
  }, /run-rust-gates\.js must enforce bounded maxBuffer in child execution/);

  // Mutation 12: removing failure classification for timeout/maxBuffer
  assert.throws(() => {
    validateRunRustGatesScript(scriptText.replaceAll("timedOut", "ignoredTimedOut"));
  }, /run-rust-gates\.js must track and record timedOut and outputLimitExceeded/);

  // Mutation 13: removing bounded output truncation
  assert.throws(() => {
    validateRunRustGatesScript(scriptText.replaceAll("truncateBoundedOutput", "unboundedOutput"));
  }, /run-rust-gates\.js must implement bounded output truncation/);
});

test("run-rust-gates subprocess policy: hung child execution is bounded and fail-closed", () => {
  // Test running a child that hangs beyond its timeout limit
  const stepRes = runStep(
    process.execPath,
    ["-e", "setTimeout(() => {}, 10000)"],
    ".",
    { timeoutMs: 150 }
  );

  assert.equal(stepRes.status, "FAIL", "Timed out step must report status FAIL");
  assert.equal(stepRes.timedOut, true, "Timed out step must set timedOut to true");
  assert.notEqual(stepRes.exitCode, 0, "Timed out step must have nonzero exit code");

  // Verify that runRustGates aggregates failure and continues when a step fails
  const mockComponents = [
    {
      name: "hung-test-comp-1",
      manifestPath: "dummy-hung-path-1",
      hasFmt: true,
      hasClippy: false,
      hasTest: false,
    },
    {
      name: "hung-test-comp-2",
      manifestPath: "dummy-hung-path-2",
      hasFmt: true,
      hasClippy: false,
      hasTest: false,
    },
  ];
  const { passed, runRecord } = runRustGates({
    targetComponents: mockComponents,
    stepTimeoutMs: 150,
  });
  assert.equal(passed, false, "Aggregate result must be false when a step fails");
  assert.equal(runRecord.counts.failed, 2, "Both components must be attempted despite first failure");
});

test("run-rust-gates subprocess policy: output-spam child execution is bounded and fail-closed", () => {
  const stepRes = runStep(
    process.execPath,
    ["-e", "process.stdout.write('A'.repeat(500000))"],
    ".",
    { maxBufferBytes: 10000 }
  );

  assert.equal(stepRes.status, "FAIL", "Buffer overflow step must report status FAIL");
  assert.equal(stepRes.outputLimitExceeded, true, "Buffer overflow step must set outputLimitExceeded to true");
  assert.notEqual(stepRes.exitCode, 0, "Buffer overflow step must have nonzero exit code");
});
