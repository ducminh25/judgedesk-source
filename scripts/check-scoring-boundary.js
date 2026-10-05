#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 1. Authoritative frozen boundary for rational scoring modules
export const AUTHORITATIVE_SCORING_MODULES = Object.freeze([
  "server/judge/scoring.ts",
  "shared/rational.ts",
  "crates/judgedesk-core/src/scoring.rs",
  "crates/judgedesk-core/src/rational.rs",
]);

// Helper to strip comments and strings from source code to avoid false positives
export function stripCommentsAndStrings(code) {
  let result = "";
  let i = 0;
  const len = code.length;
  let inLineComment = false;
  let inBlockComment = false;
  let inString = false;
  let stringChar = "";

  while (i < len) {
    const ch = code[i];
    const next = i + 1 < len ? code[i + 1] : "";

    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        result += "\n";
      }
      i++;
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      if (ch === "\n") result += "\n";
      i++;
      continue;
    }

    if (inString) {
      if (ch === "\\") {
        i += 2; // skip escaped character
        continue;
      }
      if (ch === stringChar) {
        inString = false;
        stringChar = "";
        result += '""';
      }
      if (ch === "\n") result += "\n";
      i++;
      continue;
    }

    // Check for comment start
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }

    // Check for string start
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = true;
      stringChar = ch;
      i++;
      continue;
    }

    result += ch;
    i++;
  }

  return result;
}

// 2. Syntactic prohibition checks on stripped source
export function checkScoringFileContent(filePath, rawContent) {
  const stripped = stripCommentsAndStrings(rawContent);
  const lines = stripped.split("\n");
  const violations = [];

  const isTypeScript = filePath.endsWith(".ts");
  const isRust = filePath.endsWith(".rs");

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const lineNum = idx + 1;

    if (isTypeScript) {
      // Prohibit Math.round/Math.floor/Math.ceil on score computing (exempting presentation functions in rational.ts)
      if (filePath === "server/judge/scoring.ts") {
        if (/Math\.(round|floor|ceil|trunc)\s*\(.*score/i.test(line)) {
          violations.push({
            file: filePath,
            line: lineNum,
            message: `Forbidden float math in scoring calculation: '${line.trim()}'`,
          });
        }
        if (/parseFloat\s*\(/.test(line)) {
          violations.push({
            file: filePath,
            line: lineNum,
            message: `Forbidden parseFloat in scoring logic; rational parsing required: '${line.trim()}'`,
          });
        }
      }
    }

    if (isRust) {
      if (filePath === "crates/judgedesk-core/src/scoring.rs") {
        // Disallow direct floating point operations for points accumulation
        if (/\bscore\s*[\+\-\*\/]=\s*\d+\.\d+/.test(line)) {
          violations.push({
            file: filePath,
            line: lineNum,
            message: `Forbidden float arithmetic on score: '${line.trim()}'`,
          });
        }
        if (/\bparse::<f64>\s*\(/.test(line)) {
          violations.push({
            file: filePath,
            line: lineNum,
            message: `Forbidden f64 parse in scoring calculation: '${line.trim()}'`,
          });
        }
      }
    }
  }

  return violations;
}

// 3. Escape Check: ensure no unlisted scoring modules exist
export function checkScoringBoundaryInventory() {
  const violations = [];
  const scannedDirs = ["server", "shared", "crates/judgedesk-core/src"];
  const declaredSet = new Set(AUTHORITATIVE_SCORING_MODULES);

  function walk(dir) {
    const full = path.join(repoRoot, dir);
    if (!fs.existsSync(full)) return;
    const entries = fs.readdirSync(full, { withFileTypes: true });
    for (const entry of entries) {
      const rel = path.join(dir, entry.name).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "target") {
          walk(rel);
        }
      } else if (entry.isFile()) {
        const lower = entry.name.toLowerCase();
        if (
          (lower.includes("scoring") || lower.includes("rational")) &&
          !lower.includes(".test.") &&
          !lower.includes("modal") &&
          !lower.includes("log")
        ) {
          if (!declaredSet.has(rel)) {
            violations.push({
              file: rel,
              message: `Scoring or rational module '${rel}' is not in the declared authoritative boundary inventory.`,
            });
          }
        }
      }
    }
  }

  for (const d of scannedDirs) {
    walk(d);
  }

  return violations;
}

export function main() {
  const args = process.argv.slice(2);
  const isTestMutations = args.includes("--test-mutations");

  if (isTestMutations) {
    // Self-test mutations: verify prohibited constructs are caught and comments/strings are ignored
    const prohibitedTs = `
      function calc(score: number) {
        // This is a comment mentioning Math.round(score)
        const note = "A string with Math.round(score)";
        const finalScore = Math.round(score * 10) / 10;
        return finalScore;
      }
    `;
    const cleanTs = `
      function calc(score: Rational) {
        // Comment
        const note = "safe";
        return addRational(score, createRational(1));
      }
    `;
    const prohibitedRust = `
      fn calc(score: &mut f64) {
        // Comment mentioning score += 0.5
        let msg = "score += 0.5";
        score += 0.5;
      }
    `;

    const v1 = checkScoringFileContent("server/judge/scoring.ts", prohibitedTs);
    const v2 = checkScoringFileContent("server/judge/scoring.ts", cleanTs);
    const v3 = checkScoringFileContent("crates/judgedesk-core/src/scoring.rs", prohibitedRust);

    if (v1.length !== 1) {
      console.error("FAIL: prohibited TS float math was not caught or comments/strings were falsely triggered:", v1);
      process.exit(1);
    }
    if (v2.length !== 0) {
      console.error("FAIL: clean TS code was falsely flagged:", v2);
      process.exit(1);
    }
    if (v3.length !== 1) {
      console.error("FAIL: prohibited Rust float math was not caught:", v3);
      process.exit(1);
    }

    console.log("[check-scoring-boundary] Self-test mutations passed: prohibited float math caught; comments and strings safely ignored.");
    process.exit(0);
  }

  // 1. Inventory escape check
  const inventoryViolations = checkScoringBoundaryInventory();
  if (inventoryViolations.length > 0) {
    console.error("\n[check-scoring-boundary] FAILED: Inventory escape detected:");
    for (const v of inventoryViolations) {
      console.error(`  ${v.file}: ${v.message}`);
    }
    process.exit(1);
  }

  // 2. Syntax prohibition checks on declared boundary modules
  const allViolations = [];
  for (const modulePath of AUTHORITATIVE_SCORING_MODULES) {
    const full = path.join(repoRoot, modulePath);
    if (!fs.existsSync(full)) {
      allViolations.push({ file: modulePath, line: 1, message: "Authoritative scoring module missing from disk" });
      continue;
    }
    const content = fs.readFileSync(full, "utf8");
    const violations = checkScoringFileContent(modulePath, content);
    allViolations.push(...violations);
  }

  if (allViolations.length > 0) {
    console.error(`\n[check-scoring-boundary] FAILED: ${allViolations.length} syntax violation(s) in authoritative scoring boundary:`);
    for (const v of allViolations) {
      console.error(`  ${v.file}:${v.line} — ${v.message}`);
    }
    process.exit(1);
  }

  console.log(`[check-scoring-boundary] PASS: All 4 authoritative scoring modules verified clean and bounded.`);
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
