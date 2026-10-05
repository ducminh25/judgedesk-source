#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PRODUCTION_RUST_ROOTS = [
  path.join("crates", "judgedesk-core", "src"),
  path.join("native-executor", "src"),
];

// Helper binaries that are explicitly test-only
const TEST_ONLY_FILES = new Set([
  path.join("crates", "judgedesk-core", "src", "bin", "test_server.rs").replace(/\\/g, "/"),
]);

export function findRustFiles(dir) {
  const fullPath = path.join(repoRoot, dir);
  if (!fs.existsSync(fullPath)) return [];
  const results = [];
  const entries = fs.readdirSync(fullPath, { withFileTypes: true });
  for (const entry of entries) {
    const rel = path.join(dir, entry.name).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      results.push(...findRustFiles(rel));
    } else if (entry.isFile() && entry.name.endsWith(".rs")) {
      results.push(rel);
    }
  }
  return results;
}

export function scanFileForUnwrapExpect(filePath, fileContent) {
  const violations = [];
  const lines = fileContent.split("\n");
  let inTestModule = false;
  let testModuleBraceDepth = 0;
  let currentBraceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Check if entering a #[cfg(test)] block or mod tests
    if (trimmed.includes("#[cfg(test)]")) {
      inTestModule = true;
      testModuleBraceDepth = currentBraceDepth;
    }

    // Count braces to know when we exit test module
    for (const ch of line) {
      if (ch === "{") currentBraceDepth++;
      else if (ch === "}") {
        currentBraceDepth--;
        if (inTestModule && currentBraceDepth <= testModuleBraceDepth) {
          inTestModule = false;
        }
      }
    }

    if (inTestModule) continue;
    if (trimmed.startsWith("//") || trimmed.startsWith("/*")) continue;

    // Check for .unwrap() or .expect(
    // Ignore lines that are comments or attribute annotations
    const unwrapMatch = /\.unwrap\s*\(/g.exec(line);
    if (unwrapMatch) {
      violations.push({
        file: filePath,
        line: i + 1,
        construct: "unwrap()",
        text: trimmed,
      });
    }

    const expectMatch = /\.expect\s*\(/g.exec(line);
    if (expectMatch) {
      violations.push({
        file: filePath,
        line: i + 1,
        construct: "expect()",
        text: trimmed,
      });
    }
  }

  return violations;
}

export function verifyClippyPolicyHeaders(filePath, fileContent) {
  const violations = [];
  const hasUnwrapDeny = /deny\([^)]*clippy::unwrap_used[^)]*\)/.test(fileContent);
  const hasExpectDeny = /deny\([^)]*clippy::expect_used[^)]*\)/.test(fileContent);

  if (!hasUnwrapDeny || !hasExpectDeny) {
    violations.push({
      file: filePath,
      line: 1,
      message: `Missing compiler-backed Clippy deny attributes for unwrap_used and/or expect_used`,
    });
  }
  return violations;
}

export function checkAllProductionRustInvariants() {
  const allViolations = [];
  const checkedFiles = [];

  for (const root of PRODUCTION_RUST_ROOTS) {
    const files = findRustFiles(root);
    for (const file of files) {
      const normalizedPath = file.replace(/\\/g, "/");
      if (TEST_ONLY_FILES.has(normalizedPath)) {
        continue;
      }
      checkedFiles.push(normalizedPath);
      const content = fs.readFileSync(path.join(repoRoot, file), "utf8");
      const unwrapViolations = scanFileForUnwrapExpect(normalizedPath, content);
      allViolations.push(...unwrapViolations);
    }
  }

  // Check required crate roots for Clippy policy headers
  const requiredHeaderRoots = [
    "crates/judgedesk-core/src/lib.rs",
    "crates/judgedesk-core/src/bin/server.rs",
    "native-executor/src/main.rs",
  ];

  for (const rootPath of requiredHeaderRoots) {
    const fullPath = path.join(repoRoot, rootPath);
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath, "utf8");
      const headerViolations = verifyClippyPolicyHeaders(rootPath, content);
      for (const v of headerViolations) {
        allViolations.push({
          file: v.file,
          line: v.line,
          construct: "clippy_policy",
          text: v.message,
        });
      }
    }
  }

  return { violations: allViolations, checkedFilesCount: checkedFiles.length };
}

export function main() {
  const args = process.argv.slice(2);
  const isTestMutations = args.includes("--test-mutations");

  if (isTestMutations) {
    // Run self-test verification that mutations are caught
    const mutantCodeWithUnwrap = `
      pub fn production_code() -> i32 {
        let opt: Option<i32> = Some(42);
        opt.unwrap()
      }
    `;
    const mutantCodeWithExpect = `
      pub fn production_code() -> i32 {
        let res: Result<i32, ()> = Ok(42);
        res.expect("fail")
      }
    `;
    const cleanTestCode = `
      #[cfg(test)]
      mod tests {
        #[test]
        fn test_something() {
          let x = Some(1).unwrap();
          assert_eq!(x, 1);
        }
      }
    `;

    const unwrapViolations = scanFileForUnwrapExpect("mutant.rs", mutantCodeWithUnwrap);
    const expectViolations = scanFileForUnwrapExpect("mutant.rs", mutantCodeWithExpect);
    const cleanViolations = scanFileForUnwrapExpect("clean.rs", cleanTestCode);

    if (unwrapViolations.length !== 1 || unwrapViolations[0].construct !== "unwrap()") {
      console.error("FAIL: mutant unwrap() was not detected correctly");
      process.exit(1);
    }
    if (expectViolations.length !== 1 || expectViolations[0].construct !== "expect()") {
      console.error("FAIL: mutant expect() was not detected correctly");
      process.exit(1);
    }
    if (cleanViolations.length !== 0) {
      console.error("FAIL: clean test code was falsely flagged");
      process.exit(1);
    }

    console.log("[check-rust-runtime-invariants] Self-test mutations passed: unwrap() and expect() caught in production, allowed in #[cfg(test)].");
    process.exit(0);
  }

  const { violations, checkedFilesCount } = checkAllProductionRustInvariants();

  if (violations.length > 0) {
    console.error(`\n[check-rust-runtime-invariants] FAILED: ${violations.length} violation(s) in production Rust source:`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line} [${v.construct}] — ${v.text}`);
    }
    process.exit(1);
  }

  console.log(`[check-rust-runtime-invariants] PASS: ${checkedFilesCount} production Rust source files verified clean of runtime unwrap()/expect() and enforce Clippy deny headers.`);
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
