#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ERRORS = [];

function recordError(category, file, line, message) {
  ERRORS.push({ category, file, line, message });
}

function scanDir(dir, filterExts, ignoreDirs = new Set(["node_modules", "dist", "build", "src-tauri", ".git", ".agents", ".system_generated"])) {
  const fullPath = path.join(repoRoot, dir);
  if (!fs.existsSync(fullPath)) return [];
  const results = [];
  const entries = fs.readdirSync(fullPath, { withFileTypes: true });

  for (const entry of entries) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!ignoreDirs.has(entry.name)) {
        results.push(...scanDir(rel, filterExts, ignoreDirs));
      }
    } else if (entry.isFile()) {
      if (filterExts.some((ext) => entry.name.endsWith(ext))) {
        results.push(rel.replace(/\\/g, "/"));
      }
    }
  }
  return results;
}

// 1. Floor Invariant: No @ts-ignore, @ts-nocheck, empty catch, or stubs
function checkFloorRules() {
  const files = scanDir("src", [".ts", ".tsx"]).concat(scanDir("server", [".ts"]));
  for (const file of files) {
    const content = fs.readFileSync(path.join(repoRoot, file), "utf8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/@ts-ignore|@ts-nocheck/.test(line)) {
        recordError("FLOOR", file, i + 1, `Forbidden TypeScript suppression: ${line.trim()}`);
      }
      if (/throw new Error\(["']Not implemented["']\)/i.test(line)) {
        recordError("FLOOR", file, i + 1, "Forbidden unimplemented stub");
      }
    }
  }
}

// 2. ESM Relative Import Extensions: All relative imports in Node.js modules must end with an extension (.js, .json, etc.)
function checkEsmImports() {
  const files = scanDir("server", [".ts", ".js"])
    .concat(scanDir("scripts", [".ts", ".js"]))
    .concat(scanDir("shared", [".ts", ".js"]));
  const importRegex = /(?:import|export)\s+(?:[\w*\s{},]*\s+from\s+)?["'](\.[^"']+)["']/g;
  const dynamicImportRegex = /import\s*\(\s*["'](\.[^"']+)["']\s*\)/g;

  for (const file of files) {
    const content = fs.readFileSync(path.join(repoRoot, file), "utf8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith("//") || line.trim().startsWith("/*")) continue;

      let match;
      importRegex.lastIndex = 0;
      while ((match = importRegex.exec(line)) !== null) {
        const importPath = match[1];
        const ext = path.extname(importPath);
        if (!ext && !importPath.endsWith("/")) {
          recordError("ESM_IMPORT", file, i + 1, `Relative import '${importPath}' lacks explicit .js extension`);
        }
      }

      dynamicImportRegex.lastIndex = 0;
      while ((match = dynamicImportRegex.exec(line)) !== null) {
        const importPath = match[1];
        const ext = path.extname(importPath);
        if (!ext && !importPath.endsWith("/")) {
          recordError("ESM_IMPORT", file, i + 1, `Dynamic relative import '${importPath}' lacks explicit .js extension`);
        }
      }
    }
  }
}

// 3. Anti-AI-Slop Styling Guard: No backdrop-blur, no shadow-*-500/* colored glows, no animate-bounce in UI
function checkAntiSlopStyling() {
  const files = scanDir("src", [".ts", ".tsx", ".css"]);
  for (const file of files) {
    // Exempt tests from styling scan
    if (file.endsWith(".test.tsx") || file.endsWith(".test.ts")) continue;

    const content = fs.readFileSync(path.join(repoRoot, file), "utf8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/backdrop-blur/.test(line)) {
        recordError("ANTI_SLOP", file, i + 1, `Forbidden backdrop-blur (violates desktop precision & causes WebKit stutter): ${line.trim()}`);
      }
      if (/shadow-(?:indigo|rose|emerald|amber|sky|purple)-500\/\d+/.test(line)) {
        recordError("ANTI_SLOP", file, i + 1, `Forbidden colored diffuse shadow glow (use neutral structural shadows): ${line.trim()}`);
      }
      if (/animate-bounce/.test(line)) {
        recordError("ANTI_SLOP", file, i + 1, `Forbidden bouncy animation (violates utilitarian desktop ergonomics): ${line.trim()}`);
      }
    }
  }
}

// 4. Rational Scoring Engine Invariant: No float rounding in scoring calculations
function checkRationalScoring() {
  const scoringFiles = ["server/judge/scoring.ts", "shared/rational.ts"];
  for (const file of scoringFiles) {
    const fullPath = path.join(repoRoot, file);
    if (!fs.existsSync(fullPath)) continue;
    const content = fs.readFileSync(fullPath, "utf8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith("//")) continue;
      // Disallow Math.round for score computing
      if (/Math\.round\s*\(.*score/i.test(line)) {
        recordError("RATIONAL_SCORING", file, i + 1, `Forbidden float rounding on score; rational fraction arithmetic required: ${line.trim()}`);
      }
    }
  }
}

// 5. 8-File Version Lockstep Check
function checkVersionLockstep() {
  const versionChecker = path.join(repoRoot, "scripts", "check-release-version.js");
  const result = spawnSync(process.execPath, [versionChecker], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    recordError("VERSION_LOCKSTEP", "scripts/check-release-version.js", 1, result.stderr || result.stdout || "Version lockstep verification failed");
  }
}

// 6. Test Inventory Sync: Verify all test files on disk are discoverable
function checkTestInventorySync() {
  const testFiles = scanDir("src", [".test.ts", ".test.tsx", ".test.js"])
    .concat(scanDir("server", [".test.ts", ".test.js"]))
    .concat(scanDir("scripts", [".test.ts", ".test.js"]))
    .concat(scanDir("shared", [".test.ts", ".test.js"]));

  if (testFiles.length < 80) {
    recordError("TEST_INVENTORY", "scripts/check-quality-gate.js", 1, `Expected at least 80 test files on disk, found only ${testFiles.length}`);
  }
}

// 7. API Contract & Stream Inventory Check
function checkApiContracts() {
  const apiContractChecker = path.join(repoRoot, "scripts", "check-api-contracts.js");
  const result = spawnSync(process.execPath, [apiContractChecker], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    recordError("API_CONTRACTS", "scripts/check-api-contracts.js", 1, result.stderr || result.stdout || "API contract verification failed");
  }
}

// 8. Authoritative Scoring Module Boundary & Floating-Point Prohibition
function checkScoringBoundaryGate() {
  const checker = path.join(repoRoot, "scripts", "check-scoring-boundary.js");
  const result = spawnSync(process.execPath, [checker], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    recordError("SCORING_BOUNDARY", "scripts/check-scoring-boundary.js", 1, result.stderr || result.stdout || "Scoring boundary check failed");
  }
}

// 9. Production Rust Runtime Invariants (deny unwrap/expect in non-test paths)
function checkRustInvariantsGate() {
  const checker = path.join(repoRoot, "scripts", "check-rust-runtime-invariants.js");
  const result = spawnSync(process.execPath, [checker], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    recordError("RUST_RUNTIME_INVARIANTS", "scripts/check-rust-runtime-invariants.js", 1, result.stderr || result.stdout || "Rust runtime invariants check failed");
  }
}

// 10. Expected Skips Registry & Schema Invariants
function checkExpectedSkipsGate() {
  const checker = path.join(repoRoot, "scripts", "check-expected-skips.js");
  const result = spawnSync(process.execPath, [checker], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    recordError("EXPECTED_SKIPS", "scripts/check-expected-skips.js", 1, result.stderr || result.stdout || "Expected skips validation failed");
  }
}

// 11. Entry Point Graph & Inventory Coverage
function checkEntryPointGraphGate() {
  const checker = path.join(repoRoot, "scripts", "check-entry-point-graph.js");
  const result = spawnSync(process.execPath, [checker], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    recordError("ENTRY_POINT_GRAPH", "scripts/check-entry-point-graph.js", 1, result.stderr || result.stdout || "Entry point graph verification failed");
  }
}

function main() {
  const startTime = Date.now();
  console.log("[quality-gate] Running JudgeDesk architecture & quality invariant checks...");

  checkFloorRules();
  checkEsmImports();
  checkAntiSlopStyling();
  checkRationalScoring();
  checkVersionLockstep();
  checkTestInventorySync();
  checkApiContracts();
  checkScoringBoundaryGate();
  checkRustInvariantsGate();
  checkExpectedSkipsGate();
  checkEntryPointGraphGate();

  const elapsed = Date.now() - startTime;

  if (ERRORS.length > 0) {
    console.error(`\n\x1b[31m[quality-gate] FAILED: ${ERRORS.length} invariant violation(s) detected (${elapsed}ms):\x1b[0m\n`);
    for (const err of ERRORS) {
      console.error(`  \x1b[33m[${err.category}]\x1b[0m \x1b[36m${err.file}:${err.line}\x1b[0m — ${err.message}`);
    }
    console.error("\nPlease correct these issues before committing or building.");
    process.exit(1);
  }

  console.log(`\x1b[32m[quality-gate] All architecture & quality invariants passed clean (${elapsed}ms).\x1b[0m`);
  process.exit(0);
}

main();
