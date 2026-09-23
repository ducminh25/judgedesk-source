import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertOracleBaselineIntegrity,
  validateOracleBaselineIntegrity,
} from "./oracle-baseline-validator.js";
import type {
  Corpus,
  ThemisOracleArtifactPayload,
} from "./oracle-baseline-validator.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const corpusPath = path.join(projectRoot, "judgers", "fixtures", "themis-c1-c5-corpus.json");
const baselinePath = path.join(projectRoot, "judgers", "fixtures", "themis-oracle-results.json");

test("Oracle Baseline Validator — Real artifacts pass 100% clean", () => {
  const corpus: Corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8"));
  const baseline: ThemisOracleArtifactPayload = JSON.parse(fs.readFileSync(baselinePath, "utf8"));

  const result = validateOracleBaselineIntegrity(corpus, baseline);
  assert.equal(result.valid, true, `Expected valid, got issues: ${JSON.stringify(result.issues)}`);
  assert.equal(result.issues.length, 0);

  // assertOracleBaselineIntegrity should not throw
  assert.doesNotThrow(() => {
    assertOracleBaselineIntegrity(corpus, baseline);
  });
});

test("Oracle Baseline Validator — Detects duplicate IDs in corpus", () => {
  const corpus: Corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8"));
  const baseline: ThemisOracleArtifactPayload = JSON.parse(fs.readFileSync(baselinePath, "utf8"));

  // Duplicate the first fixture
  corpus.fixtures.push({ ...corpus.fixtures[0] });

  const result = validateOracleBaselineIntegrity(corpus, baseline);
  assert.equal(result.valid, false);
  const dup = result.issues.find((i) => i.type === "DUPLICATE_ID");
  assert.ok(dup, "Should detect duplicate ID");
  assert.equal(dup.id, corpus.fixtures[0].id);
});

test("Oracle Baseline Validator — Detects duplicate IDs in baseline", () => {
  const corpus: Corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8"));
  const baseline: ThemisOracleArtifactPayload = JSON.parse(fs.readFileSync(baselinePath, "utf8"));

  // Duplicate the first baseline result
  baseline.results.push({ ...baseline.results[0] });

  const result = validateOracleBaselineIntegrity(corpus, baseline);
  assert.equal(result.valid, false);
  const dup = result.issues.find((i) => i.type === "DUPLICATE_ID");
  assert.ok(dup, "Should detect duplicate ID in baseline");
});

test("Oracle Baseline Validator — Detects count mismatch", () => {
  const corpus: Corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8"));
  const baseline: ThemisOracleArtifactPayload = JSON.parse(fs.readFileSync(baselinePath, "utf8"));

  // Remove one fixture
  corpus.fixtures.pop();
  baseline.results.pop();

  const result = validateOracleBaselineIntegrity(corpus, baseline);
  assert.equal(result.valid, false);
  const countIssues = result.issues.filter((i) => i.type === "COUNT_MISMATCH");
  assert.equal(countIssues.length, 2, "Should report count mismatch for both corpus and baseline");
});

test("Oracle Baseline Validator — Detects missing fixture in baseline", () => {
  const corpus: Corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8"));
  const baseline: ThemisOracleArtifactPayload = JSON.parse(fs.readFileSync(baselinePath, "utf8"));

  const removed = baseline.results.pop()!;
  baseline.results.push({ ...baseline.results[0], id: "extra_id_999" });

  const result = validateOracleBaselineIntegrity(corpus, baseline);
  assert.equal(result.valid, false);
  const missing = result.issues.find((i) => i.type === "MISSING_FIXTURE" && i.id === removed.id);
  assert.ok(missing, `Should detect missing fixture ${removed.id}`);
  const extra = result.issues.find((i) => i.type === "EXTRA_FIXTURE" && i.id === "extra_id_999");
  assert.ok(extra, "Should detect extra fixture");
});

test("Oracle Baseline Validator — Detects field mismatch (checker, base64, verdict, message)", () => {
  const corpus: Corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8"));
  const baseline: ThemisOracleArtifactPayload = JSON.parse(fs.readFileSync(baselinePath, "utf8"));

  // Tamper with expectedBase64 of first fixture
  baseline.results[0].fixtureInputBytes.expectedBase64 = "VEFNUEVSRUQ=";
  // Tamper with expected verdict of second fixture
  baseline.results[1].judgedesk.verdict = "WA";

  const result = validateOracleBaselineIntegrity(corpus, baseline);
  assert.equal(result.valid, false);
  const fieldIssues = result.issues.filter((i) => i.type === "FIELD_MISMATCH");
  assert.ok(fieldIssues.length >= 2, "Should report field mismatches");
});

test("Oracle Baseline Validator — Enforces C1-C4 VERIFIED_EXACT_MATCH and C5 INTENTIONALLY_NOT_EMULATED", () => {
  const corpus: Corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8"));
  const baseline: ThemisOracleArtifactPayload = JSON.parse(fs.readFileSync(baselinePath, "utf8"));

  // Change C1 to INTENTIONALLY_NOT_EMULATED (illegal for C1)
  const c1Result = baseline.results.find((r) => r.checker === "C1")!;
  c1Result.parityStatus = "INTENTIONALLY_NOT_EMULATED";

  // Change C5 to VERIFIED_EXACT_MATCH (illegal for C5)
  const c5Result = baseline.results.find((r) => r.checker === "C5")!;
  c5Result.parityStatus = "VERIFIED_EXACT_MATCH";

  const result = validateOracleBaselineIntegrity(corpus, baseline);
  assert.equal(result.valid, false);
  const statusIssues = result.issues.filter((i) => i.type === "INVALID_PARITY_STATUS");
  assert.equal(statusIssues.length, 2, "Should report invalid parity statuses for both C1 and C5");
});

test("Oracle Baseline Validator — Detects mismatched live DLL hashes", () => {
  const corpus: Corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8"));
  const baseline: ThemisOracleArtifactPayload = JSON.parse(fs.readFileSync(baselinePath, "utf8"));

  const tamperedLiveHashes = {
    ...baseline.dllHashes,
    C1: "0000000000000000000000000000000000000000000000000000000000000000",
  };

  const result = validateOracleBaselineIntegrity(corpus, baseline, tamperedLiveHashes);
  assert.equal(result.valid, false);
  const hashIssue = result.issues.find((i) => i.type === "DLL_HASH_MISMATCH");
  assert.ok(hashIssue, "Should report DLL hash mismatch");
});
