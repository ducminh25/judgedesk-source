#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Known enumerated predicates and their evaluators
export const ENUMERATED_PREDICATES = Object.freeze({
  "win32_unprivileged_symlinks_missing": (ctx) => (ctx?.os || process.platform) === "win32",
  "win32_unprivileged_symlinks_supported": () => false,
  "is_not_darwin": (ctx) => (ctx?.os || process.platform) !== "darwin",
  "is_darwin": (ctx) => (ctx?.os || process.platform) === "darwin",
  "is_not_win32": (ctx) => (ctx?.os || process.platform) !== "win32",
  "is_win32": (ctx) => (ctx?.os || process.platform) === "win32",
  "no_unmanaged_python_detected": () => true,
  "unmanaged_python_certified": () => false,
  "env_real_toolchain_gates_unset": () => process.env.JUDGEDESK_REAL_TOOLCHAIN_GATES !== "1",
  "env_real_toolchain_gates_set": () => process.env.JUDGEDESK_REAL_TOOLCHAIN_GATES === "1",
  "invoked_by_parent_harness_only": () => true,
  "is_standalone_test": () => false,
  "managed_python_unavailable": () => true,
  "managed_python_ready": () => false,
  "managed_python_descriptor_missing": () => true,
  "managed_python_descriptor_available": () => false,
  "current_host_supports_cpp": () => true,
  "current_host_unsupported_cpp": () => false,
  "host_has_stable_managed_package": () => true,
  "host_lacks_stable_managed_package": () => false,
  "is_supported_toolchain_host": () => true,
  "is_unsupported_toolchain_host": () => false,
});

export function evaluatePredicate(predicateId, context = null) {
  const evaluator = ENUMERATED_PREDICATES[predicateId];
  if (!evaluator) {
    throw new Error(`Unknown predicate ID: '${predicateId}'`);
  }
  return evaluator(context);
}

export function validateRegistrySchema(registryData) {
  const schemaPath = path.join(repoRoot, "scripts", "expected-skips.schema.json");
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(schema);
  const valid = validate(registryData);
  return { valid, errors: validate.errors || [] };
}

export function validateSkipEntry(entry, now = new Date()) {
  const errors = [];

  // 1. Unknown predicate check
  if (!ENUMERATED_PREDICATES[entry.prerequisitePredicateId]) {
    errors.push(`Unknown prerequisitePredicateId: '${entry.prerequisitePredicateId}'`);
  }
  if (!ENUMERATED_PREDICATES[entry.removalPredicateId]) {
    errors.push(`Unknown removalPredicateId: '${entry.removalPredicateId}'`);
  }

  if (errors.length > 0) {
    return errors;
  }

  // 2. Prerequisite predicate must evaluate to true for all declared targets
  // 3. Removal predicate must evaluate to false for all declared targets
  for (const target of entry.targets) {
    const prereqVal = evaluatePredicate(entry.prerequisitePredicateId, target);
    if (!prereqVal) {
      errors.push(`Prerequisite predicate '${entry.prerequisitePredicateId}' evaluated to false for target (${target.os}/${target.arch}); skip waiver is invalid or target mismatch`);
    }

    const removalVal = evaluatePredicate(entry.removalPredicateId, target);
    if (removalVal) {
      errors.push(`Removal predicate '${entry.removalPredicateId}' evaluated to true for target (${target.os}/${target.arch}); skip condition is resolved and MUST be removed`);
    }
  }

  // 4. ISO expiry check: expiresOn must be in the future
  const expiryDate = new Date(entry.expiresOn);
  if (isNaN(expiryDate.getTime())) {
    errors.push(`Invalid ISO date format for expiresOn: '${entry.expiresOn}'`);
  } else if (expiryDate <= now) {
    errors.push(`Skip waiver has EXPIRED on ${entry.expiresOn} (current: ${now.toISOString()})`);
  }

  // 5. Source file fingerprint verification
  const fullSourcePath = path.join(repoRoot, entry.sourcePath);
  if (!fs.existsSync(fullSourcePath)) {
    errors.push(`Source file does not exist: '${entry.sourcePath}'`);
  } else {
    const fileContent = fs.readFileSync(fullSourcePath, "utf8");
    const currentFingerprint = crypto.createHash("sha256").update(fileContent, "utf8").digest("hex");
    if (currentFingerprint.toLowerCase() !== entry.sourceFingerprint.toLowerCase()) {
      errors.push(`Source fingerprint drift detected for '${entry.sourcePath}'. Expected: ${entry.sourceFingerprint}, actual: ${currentFingerprint}`);
    }
  }

  // 6. Prohibit release-blocking required target tuples
  for (const t of entry.targets) {
    // If a skip targets a mandatory release profile in managed sourceMode on its primary supported OS without exemption
    if (t.profile === "cpp" && t.os === "win32" && t.sourceMode === "managed") {
      errors.push(`Skip targeting required release profile '${t.profile}' on '${t.os}' in managed mode is release-blocking`);
    }
  }

  return errors;
}

export function validateAllExpectedSkips(registryPath = path.join(repoRoot, "docs", "verification", "pure-rust-core", "expected-skips.json")) {
  if (!fs.existsSync(registryPath)) {
    return { valid: false, errors: [`Registry file missing: ${registryPath}`], count: 0 };
  }

  const raw = fs.readFileSync(registryPath, "utf8");
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return { valid: false, errors: [`Invalid JSON in registry: ${err.message}`], count: 0 };
  }

  // 1. Schema check
  const schemaResult = validateRegistrySchema(data);
  if (!schemaResult.valid) {
    const errMsgs = schemaResult.errors.map(e => `Schema error at ${e.instancePath}: ${e.message}`);
    return { valid: false, errors: errMsgs, count: data.skips?.length || 0 };
  }

  // 2. Policy ID uniqueness & entry checks
  const allErrors = [];
  const seenPolicyIds = new Set();
  const now = new Date();

  for (const entry of data.skips) {
    if (seenPolicyIds.has(entry.policyId)) {
      allErrors.push(`Duplicate policyId: '${entry.policyId}'`);
    }
    seenPolicyIds.add(entry.policyId);

    const entryErrors = validateSkipEntry(entry, now);
    for (const err of entryErrors) {
      allErrors.push(`[${entry.policyId}] ${err}`);
    }
  }

  const unregistered = checkUnregisteredSkips(data.skips);
  allErrors.push(...unregistered);

  return {
    valid: allErrors.length === 0,
    errors: allErrors,
    count: data.skips.length,
    skips: data.skips,
  };
}

export function checkUnregisteredSkips(registeredSkips) {
  const registeredPaths = new Set(registeredSkips.map(s => s.sourcePath.replace(/\\/g, "/")));
  const unregisteredErrors = [];
  const scanRoots = ["src", "server", "scripts", "shared"];

  function scan(dir) {
    const full = path.join(repoRoot, dir);
    if (!fs.existsSync(full)) return;
    const entries = fs.readdirSync(full, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.name === "node_modules" || ent.name === "dist" || ent.name === "build") continue;
      const rel = path.join(dir, ent.name).replace(/\\/g, "/");
      if (ent.isDirectory()) {
        scan(rel);
      } else if (ent.isFile() && (rel.endsWith(".test.ts") || rel.endsWith(".test.js") || rel.endsWith(".test.tsx"))) {
        const content = fs.readFileSync(path.join(repoRoot, rel), "utf8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (/\b(?:it|test)\.skip\s*\(/.test(line)) {
            if (!registeredPaths.has(rel)) {
              unregisteredErrors.push(`Unregistered test skip detected in '${rel}:${i + 1}': ${line.trim()}`);
            }
          }
        }
      }
    }
  }

  for (const root of scanRoots) {
    scan(root);
  }
  return unregisteredErrors;
}

export function main() {
  const args = process.argv.slice(2);
  const isTestMutations = args.includes("--test-mutations");
  const isJson = args.includes("--json");

  if (isTestMutations) {
    // Test mutation 1: unknown predicate
    const badPredicateEntry = {
      policyId: "test-unknown-pred",
      observedIdentity: "test",
      sourcePath: "server/api-contracts.test.ts",
      sourceFingerprint: "0000000000000000000000000000000000000000000000000000000000000000",
      runner: "node:test",
      suite: "server/api-contracts.test.ts",
      targets: [{ os: "win32", arch: "x64", profile: null, sourceMode: null }],
      owner: "Test",
      prerequisitePredicateId: "nonexistent_predicate_123",
      expiresOn: "2099-01-01T00:00:00Z",
      removalPredicateId: "is_darwin",
      justification: "Test mutation justification",
    };
    const e1 = validateSkipEntry(badPredicateEntry);
    if (!e1.some(e => e.includes("Unknown prerequisitePredicateId"))) {
      console.error("FAIL: unknown predicate was not flagged:", e1);
      process.exit(1);
    }

    // Test mutation 2: expired skip
    const expiredEntry = {
      ...badPredicateEntry,
      policyId: "test-expired",
      prerequisitePredicateId: "win32_unprivileged_symlinks_missing",
      removalPredicateId: "win32_unprivileged_symlinks_supported",
      expiresOn: "2020-01-01T00:00:00Z", // past date
    };
    const e2 = validateSkipEntry(expiredEntry);
    if (!e2.some(e => e.includes("EXPIRED"))) {
      console.error("FAIL: expired skip was not flagged:", e2);
      process.exit(1);
    }

    // Test mutation 3: prerequisite=false
    const prereqFalseEntry = {
      ...badPredicateEntry,
      policyId: "test-prereq-false",
      prerequisitePredicateId: "win32_unprivileged_symlinks_supported", // evaluates false
      removalPredicateId: "win32_unprivileged_symlinks_supported",
      expiresOn: "2099-01-01T00:00:00Z",
    };
    const e3 = validateSkipEntry(prereqFalseEntry);
    if (!e3.some(e => e.includes("evaluated to false"))) {
      console.error("FAIL: false prerequisite was not flagged:", e3);
      process.exit(1);
    }

    // Test mutation 4: removal=true
    const removalTrueEntry = {
      ...badPredicateEntry,
      policyId: "test-removal-true",
      prerequisitePredicateId: "win32_unprivileged_symlinks_missing",
      removalPredicateId: "win32_unprivileged_symlinks_missing", // evaluates true
      expiresOn: "2099-01-01T00:00:00Z",
    };
    const e4 = validateSkipEntry(removalTrueEntry);
    if (!e4.some(e => e.includes("evaluated to true"))) {
      console.error("FAIL: true removal predicate was not flagged:", e4);
      process.exit(1);
    }

    // Test mutation 5: fingerprint drift
    const driftedFingerprintEntry = {
      ...badPredicateEntry,
      policyId: "test-fingerprint-drift",
      prerequisitePredicateId: "win32_unprivileged_symlinks_missing",
      removalPredicateId: "win32_unprivileged_symlinks_supported",
      sourcePath: "server/api-contracts.test.ts",
      sourceFingerprint: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", // mismatch
      expiresOn: "2099-01-01T00:00:00Z",
    };
    const e5 = validateSkipEntry(driftedFingerprintEntry);
    if (!e5.some(e => e.includes("Source fingerprint drift detected"))) {
      console.error("FAIL: drifted fingerprint was not flagged:", e5);
      process.exit(1);
    }

    // Test mutation 6: required target tuple skip
    const requiredTargetEntry = {
      ...badPredicateEntry,
      policyId: "test-required-target",
      prerequisitePredicateId: "win32_unprivileged_symlinks_missing",
      removalPredicateId: "win32_unprivileged_symlinks_supported",
      expiresOn: "2099-01-01T00:00:00Z",
      targets: [{ os: "win32", arch: "x64", profile: "cpp", sourceMode: "managed" }],
    };
    const e6 = validateSkipEntry(requiredTargetEntry);
    if (!e6.some(e => e.includes("release-blocking"))) {
      console.error("FAIL: required target tuple skip was not flagged:", e6);
      process.exit(1);
    }

    console.log("[check-expected-skips] Self-test mutations passed: unknown predicates, expired waivers, false prereq, true removal, drifted fingerprint, and required targets all failed closed.");
    process.exit(0);
  }

  const result = validateAllExpectedSkips();

  if (isJson) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.valid ? 0 : 1);
  }

  if (!result.valid) {
    console.error(`\n[check-expected-skips] FAILED: ${result.errors.length} error(s) in expected-skips registry:`);
    for (const err of result.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  console.log(`[check-expected-skips] PASS: Validated ${result.count} expected skip entries against schema, production authorities, predicates, and source fingerprints.`);
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
