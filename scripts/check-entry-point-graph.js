#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Authoritative classification of every package.json script.
 * Every script must be explicitly categorized.
 */
export const PACKAGE_SCRIPTS_CLASSIFICATION = Object.freeze({
  // Canonical coverage
  "lint": { classification: "canonical_coverage", runner: "npm/tsc/node", target: "Typecheck & quality invariants" },
  "test:themis-parity": { classification: "canonical_coverage", runner: "tsx", target: "Themis checker parity" },
  "corpus:check": { classification: "canonical_coverage", runner: "tsx", target: "Corpus manifest verification" },
  "test:update-ui": { classification: "canonical_coverage", runner: "tsx:test", target: "Update UI test suite" },
  "release:check-version": { classification: "canonical_coverage", runner: "node", target: "8-file version lockstep" },
  "test:executor": { classification: "canonical_coverage", runner: "cargo:test", target: "native-executor crate tests" },
  "test:security": { classification: "canonical_coverage", runner: "tsx:test", target: "Security integration test" },
  "test:rust": { classification: "canonical_coverage", runner: "node", target: "Centralized Rust gate runner (fmt, clippy, tests)" },

  // Alias / Composition
  "build": { classification: "alias_composition", composition: ["check:fast", "build:frontend", "build:executor", "build:server"] },
  "check:fast": { classification: "alias_composition", composition: ["check-node", "lint"] },
  "check:full": { classification: "alias_composition", composition: ["check:fast", "test:rust", "test:server", "test:themis-parity", "release:check-version"] },
  "check:rust": { classification: "alias_composition", composition: ["test:rust"] },
  "test:server": { classification: "alias_composition", composition: ["check-node", "build:executor", "corpus:check", "run-all-tests"] },
  "test:corpus": { classification: "alias_composition", composition: ["corpus:check", "run-all-tests --filter=corpus"] },
  "test:limits": { classification: "alias_composition", composition: ["test:security"] },
  "distribution:sync:full": { classification: "alias_composition", composition: ["toolchains:fetch:full", "distribution:prepare:full"] },
  "distribution:sync:core": { classification: "alias_composition", composition: ["toolchains:fetch:core", "distribution:prepare:core"] },

  // Platform / Live gate
  "test:themis-oracle": { classification: "platform_live_gate", platform: "win32", description: "Live Windows DLL oracle gate" },
  "test:stress": { classification: "platform_live_gate", platform: "any", description: "Standalone judge stress tester" },
  "test:desktop": { classification: "platform_live_gate", platform: "any", description: "Interactive desktop Tauri dev instance" },
  "test:performance": { classification: "platform_live_gate", platform: "any", description: "Executor performance benchmark" },
  "test:windows-resources": { classification: "platform_live_gate", platform: "win32", description: "Windows job/memory resource gate" },
  "test:windows-single-instance": { classification: "platform_live_gate", platform: "win32", description: "Windows single-instance mutex gate" },
  "test:macos-process-supervisor": { classification: "platform_live_gate", platform: "darwin", description: "macOS process supervisor gate" },
  "test:macos-packaged-checkers": { classification: "platform_live_gate", platform: "darwin", description: "macOS packaged checker gate" },
  "verify:macos:local": { classification: "platform_live_gate", platform: "darwin", description: "macOS local bundle verification" },
  "release:verify-public-assets": { classification: "platform_live_gate", platform: "any", description: "GitHub release asset verification" },

  // Explicit non-test exclusions (mandatory machine-checked reason)
  "dev": { classification: "explicit_non_test_exclusion", reason: "Development backend server watcher" },
  "dev:frontend": { classification: "explicit_non_test_exclusion", reason: "Development Vite frontend HMR server" },
  "build:frontend": { classification: "explicit_non_test_exclusion", reason: "Production Vite build for React UI" },
  "build:server": { classification: "explicit_non_test_exclusion", reason: "Production Node.js server bundle builder" },
  "build:executor": { classification: "explicit_non_test_exclusion", reason: "Builds native-executor release/debug binary" },
  "build:test": { classification: "explicit_non_test_exclusion", reason: "Tauri test build" },
  "build:windows:local": { classification: "explicit_non_test_exclusion", reason: "Local Windows desktop packaging" },
  "build:windows:core:local": { classification: "explicit_non_test_exclusion", reason: "Local Windows Core variant desktop packaging" },
  "build:windows:full:local": { classification: "explicit_non_test_exclusion", reason: "Local Windows Full variant desktop packaging" },
  "build:windows:release:local": { classification: "explicit_non_test_exclusion", reason: "Windows release packaging orchestrator" },
  "build:macos:local": { classification: "explicit_non_test_exclusion", reason: "Local macOS desktop packaging" },
  "build:macos:core:local": { classification: "explicit_non_test_exclusion", reason: "Local macOS Core variant desktop packaging" },
  "build:macos:full:local": { classification: "explicit_non_test_exclusion", reason: "Local macOS Full variant desktop packaging" },
  "build:macos:local:headless": { classification: "explicit_non_test_exclusion", reason: "Headless macOS packaging & verification" },
  "toolchains:keygen": { classification: "explicit_non_test_exclusion", reason: "Ed25519 signing key generation tool" },
  "toolchains:manifest": { classification: "explicit_non_test_exclusion", reason: "Toolchain manifest compilation tool" },
  "toolchains:package:host": { classification: "explicit_non_test_exclusion", reason: "Host toolchain packaging automation" },
  "toolchains:prepare:gate": { classification: "explicit_non_test_exclusion", reason: "Gate environment root setup tool" },
  "toolchains:fetch:full": { classification: "explicit_non_test_exclusion", reason: "Downloads full toolchain release bundle" },
  "toolchains:fetch:core": { classification: "explicit_non_test_exclusion", reason: "Downloads core toolchain release bundle" },
  "distribution:prepare:full": { classification: "explicit_non_test_exclusion", reason: "Prepares distribution directory for full bundle" },
  "distribution:prepare:core": { classification: "explicit_non_test_exclusion", reason: "Prepares distribution directory for core bundle" },
  "corpus:materialize": { classification: "explicit_non_test_exclusion", reason: "Materializes corpus testcase fixtures to disk" },
  "test:themis-oracle:update": { classification: "explicit_non_test_exclusion", reason: "Updates baseline fixtures for Themis oracle" },
  "benchmark:executor": { classification: "explicit_non_test_exclusion", reason: "Raw executor latency and throughput measurement" },
  "start": { classification: "explicit_non_test_exclusion", reason: "Launches production server executable" },
  "tauri": { classification: "explicit_non_test_exclusion", reason: "CLI proxy for Tauri development commands" },
  "clean": { classification: "explicit_non_test_exclusion", reason: "Cleans temporary directories and build artifacts" },
});

export const CANONICAL_NODE_TEST_ROOTS = ["src", "server", "scripts", "shared"];
export const CANONICAL_CARGO_CRATES = [
  "crates/judgedesk-core",
  "native-executor",
  "src-tauri",
];

export function validatePackageScriptsGraph(packageJsonScripts, classificationMap = PACKAGE_SCRIPTS_CLASSIFICATION) {
  const violations = [];
  const scriptKeys = new Set(Object.keys(packageJsonScripts));
  const classifiedKeys = new Set(Object.keys(classificationMap));

  // 1. Any script in package.json must be in classificationMap
  for (const key of scriptKeys) {
    if (!classifiedKeys.has(key)) {
      violations.push(`Uncategorized package.json script: '${key}'. Every entry point must be machine-classified.`);
    }
  }

  // 2. Any script in classificationMap must exist in package.json
  for (const key of classifiedKeys) {
    if (!scriptKeys.has(key)) {
      violations.push(`Classified script '${key}' does not exist in package.json.`);
    }
  }

  // 3. For every classified script, validate classification rules
  for (const [key, entry] of Object.entries(classificationMap)) {
    if (!["canonical_coverage", "alias_composition", "platform_live_gate", "explicit_non_test_exclusion"].includes(entry.classification)) {
      violations.push(`Invalid classification '${entry.classification}' for script '${key}'.`);
    }
    if (entry.classification === "explicit_non_test_exclusion") {
      if (!entry.reason || entry.reason.trim().length < 5) {
        violations.push(`Explicit non-test exclusion '${key}' lacks a machine-checked justification reason.`);
      }
    }
    if (entry.classification === "alias_composition") {
      if (!Array.isArray(entry.composition) || entry.composition.length === 0) {
        violations.push(`Alias composition '${key}' must define a non-empty composition array.`);
      }
    }
  }

  return violations;
}

export function validateNodeTestRootsDiscovery() {
  const violations = [];
  // Ensure all canonical roots exist on disk
  for (const root of CANONICAL_NODE_TEST_ROOTS) {
    const absPath = path.join(repoRoot, root);
    if (!fs.existsSync(absPath)) {
      violations.push(`Canonical Node test root '${root}' missing from filesystem.`);
    }
  }

  // Ensure runner scans the canonical roots
  const runnerScript = path.join(repoRoot, "scripts", "run-all-tests.js");
  if (!fs.existsSync(runnerScript)) {
    violations.push("run-all-tests.js runner script is missing.");
    return violations;
  }

  const content = fs.readFileSync(runnerScript, "utf8");
  for (const root of CANONICAL_NODE_TEST_ROOTS) {
    if (!content.includes(`"${root}"`) && !content.includes(`'${root}'`)) {
      violations.push(`run-all-tests.js does not scan canonical root '${root}'.`);
    }
  }

  return violations;
}

export function validateCargoTargetsInventory() {
  const violations = [];
  for (const crate of CANONICAL_CARGO_CRATES) {
    const manifestPath = path.join(repoRoot, crate, "Cargo.toml");
    if (!fs.existsSync(manifestPath)) {
      violations.push(`Canonical Cargo crate manifest missing: '${manifestPath}'.`);
    }
  }
  return violations;
}

export function buildEntryPointGraph() {
  const packageJsonPath = path.join(repoRoot, "package.json");
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const scriptViolations = validatePackageScriptsGraph(pkg.scripts);
  const nodeRootsViolations = validateNodeTestRootsDiscovery();
  const cargoViolations = validateCargoTargetsInventory();

  const allViolations = [...scriptViolations, ...nodeRootsViolations, ...cargoViolations];
  return {
    valid: allViolations.length === 0,
    violations: allViolations,
    entryPointsCount: Object.keys(PACKAGE_SCRIPTS_CLASSIFICATION).length,
    canonicalCoverageCount: Object.values(PACKAGE_SCRIPTS_CLASSIFICATION).filter(v => v.classification === "canonical_coverage").length,
    aliasCompositionCount: Object.values(PACKAGE_SCRIPTS_CLASSIFICATION).filter(v => v.classification === "alias_composition").length,
    platformLiveGateCount: Object.values(PACKAGE_SCRIPTS_CLASSIFICATION).filter(v => v.classification === "platform_live_gate").length,
    nonTestExclusionCount: Object.values(PACKAGE_SCRIPTS_CLASSIFICATION).filter(v => v.classification === "explicit_non_test_exclusion").length,
  };
}

export function main() {
  const args = process.argv.slice(2);
  const isTestMutations = args.includes("--test-mutations");
  const isJson = args.includes("--json");

  if (isTestMutations) {
    // 1. Mutation: missing script from classification
    const fakeScripts = { "lint": "echo", "unlisted_new_script": "exit 1" };
    const v1 = validatePackageScriptsGraph(fakeScripts, { "lint": PACKAGE_SCRIPTS_CLASSIFICATION["lint"] });
    if (!v1.some(e => e.includes("Uncategorized package.json script: 'unlisted_new_script'"))) {
      console.error("FAIL: unlisted script was not flagged:", v1);
      process.exit(1);
    }

    // 2. Mutation: non-test exclusion without reason
    const v2 = validatePackageScriptsGraph({ "foo": "echo" }, { "foo": { classification: "explicit_non_test_exclusion", reason: "" } });
    if (!v2.some(e => e.includes("lacks a machine-checked justification reason"))) {
      console.error("FAIL: missing justification reason was not flagged:", v2);
      process.exit(1);
    }

    console.log("[check-entry-point-graph] Self-test mutations passed: unlisted scripts, empty reasons, and graph mismatches caught.");
    process.exit(0);
  }

  const result = buildEntryPointGraph();

  if (isJson) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.valid ? 0 : 1);
  }

  if (!result.valid) {
    console.error(`\n[check-entry-point-graph] FAILED with ${result.violations.length} violation(s):`);
    for (const v of result.violations) {
      console.error(`  - ${v}`);
    }
    process.exit(1);
  }

  console.log(
    `[check-entry-point-graph] PASS: Entry point graph verified. ${result.entryPointsCount} entry points classified (` +
    `${result.canonicalCoverageCount} canonical, ${result.aliasCompositionCount} compositions, ` +
    `${result.platformLiveGateCount} platform/live gates, ${result.nonTestExclusionCount} excluded non-tests).`
  );
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
