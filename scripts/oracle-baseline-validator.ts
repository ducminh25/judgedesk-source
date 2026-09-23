import assert from "node:assert/strict";

export interface ThemisOracleExecution {
  invoked: boolean;
  exitCode: number;
  signal: string | null;
  dll: string;
  dllSha256: string;
  rawScore: number;
  rawComment: string;
  hexComment: string;
  liveDllVerdict: "AC" | "WA";
}

export interface ThemisOracleProductDecision {
  decision: "INTENTIONALLY_NOT_EMULATED";
  rationale: string;
}

export interface ThemisOracleResultEntry {
  id: string;
  checker: "C1" | "C2" | "C3" | "C4" | "C5";
  description: string;
  fixtureInputBytes: {
    expectedBase64: string;
    actualBase64: string;
  };
  oracleExecution: ThemisOracleExecution;
  judgedesk: {
    verdict: string;
    message: string;
  };
  parityStatus: "VERIFIED_EXACT_MATCH" | "INTENTIONALLY_NOT_EMULATED";
  productDecision?: ThemisOracleProductDecision;
}

export interface ThemisOracleArtifactPayload {
  manifestVersion: string;
  timestamp: string;
  platform: string;
  dllHashes: Record<string, string>;
  harnessBuild: {
    compiler: string;
    flags: string;
    source: string;
  };
  summary: {
    totalFixtures: number;
    c1toC4ValidatedExactMatches: number;
    c5ExecutedWithProductDecision: number;
  };
  c5ProductDecision: ThemisOracleProductDecision;
  results: ThemisOracleResultEntry[];
}

export interface ThemisOracleCorpusBinding {
  invoked: boolean;
  exitCode: number | null;
  rawScore: number | null;
  rawComment: string | null;
  hexComment: string | null;
  liveDllVerdict: "AC" | "WA" | null;
  parityStatus: "VERIFIED_EXACT_MATCH" | "INTENTIONALLY_NOT_EMULATED" | "UNCHECKED";
  productDecision?: ThemisOracleProductDecision;
}

export interface CorpusFixture {
  id: string;
  checker: "C1" | "C2" | "C3" | "C4" | "C5";
  description: string;
  expectedBase64: string;
  actualBase64: string;
  expectedVerdict: string;
  expectedMessage: string;
  themisOracle?: ThemisOracleCorpusBinding;
}

export interface Corpus {
  version: string;
  description?: string;
  fixturesCount?: number;
  fixtures: CorpusFixture[];
}

export interface BaselineValidationIssue {
  type:
    | "DUPLICATE_ID"
    | "COUNT_MISMATCH"
    | "MISSING_FIXTURE"
    | "EXTRA_FIXTURE"
    | "FIELD_MISMATCH"
    | "DLL_HASH_MISMATCH"
    | "INVALID_PARITY_STATUS"
    | "INVALID_PRODUCT_DECISION";
  id?: string;
  message: string;
}

export interface BaselineValidationResult {
  valid: boolean;
  issues: BaselineValidationIssue[];
}

export function validateOracleBaselineIntegrity(
  corpus: Corpus,
  baseline: ThemisOracleArtifactPayload,
  liveDllHashes?: Record<string, string>,
): BaselineValidationResult {
  const issues: BaselineValidationIssue[] = [];

  // 1. Check duplicate IDs in corpus
  const corpusIds = new Set<string>();
  for (const f of corpus.fixtures) {
    if (corpusIds.has(f.id)) {
      issues.push({
        type: "DUPLICATE_ID",
        id: f.id,
        message: `Corpus contains duplicate fixture ID: "${f.id}"`,
      });
    }
    corpusIds.add(f.id);
  }

  // 2. Check duplicate IDs in baseline results
  const baselineIds = new Set<string>();
  const baselineMap = new Map<string, ThemisOracleResultEntry>();
  for (const r of baseline.results) {
    if (baselineIds.has(r.id)) {
      issues.push({
        type: "DUPLICATE_ID",
        id: r.id,
        message: `Baseline contains duplicate result ID: "${r.id}"`,
      });
    }
    baselineIds.add(r.id);
    baselineMap.set(r.id, r);
  }

  // 3. Exactly 67 fixtures (1-to-1 bijection)
  if (corpus.fixtures.length !== 67) {
    issues.push({
      type: "COUNT_MISMATCH",
      message: `Corpus fixtures count must be exactly 67, got ${corpus.fixtures.length}`,
    });
  }
  if (baseline.results.length !== 67) {
    issues.push({
      type: "COUNT_MISMATCH",
      message: `Baseline results count must be exactly 67, got ${baseline.results.length}`,
    });
  }

  // Check 1-to-1 bijection between corpus and baseline
  for (const f of corpus.fixtures) {
    if (!baselineMap.has(f.id)) {
      issues.push({
        type: "MISSING_FIXTURE",
        id: f.id,
        message: `Fixture "${f.id}" from corpus is missing in baseline results`,
      });
    }
  }
  for (const r of baseline.results) {
    if (!corpusIds.has(r.id)) {
      issues.push({
        type: "EXTRA_FIXTURE",
        id: r.id,
        message: `Baseline contains extra result "${r.id}" not present in corpus`,
      });
    }
  }

  // 4. Exact field parity (checker, Base64 input bytes, expected verdict/message)
  for (const f of corpus.fixtures) {
    const b = baselineMap.get(f.id);
    if (!b) continue;

    if (b.checker !== f.checker) {
      issues.push({
        type: "FIELD_MISMATCH",
        id: f.id,
        message: `Checker mismatch for "${f.id}": corpus=${f.checker}, baseline=${b.checker}`,
      });
    }

    if (b.fixtureInputBytes.expectedBase64 !== f.expectedBase64) {
      issues.push({
        type: "FIELD_MISMATCH",
        id: f.id,
        message: `expectedBase64 mismatch for "${f.id}"`,
      });
    }

    if (b.fixtureInputBytes.actualBase64 !== f.actualBase64) {
      issues.push({
        type: "FIELD_MISMATCH",
        id: f.id,
        message: `actualBase64 mismatch for "${f.id}"`,
      });
    }

    if (b.judgedesk.verdict !== f.expectedVerdict) {
      issues.push({
        type: "FIELD_MISMATCH",
        id: f.id,
        message: `JudgeDesk expected verdict mismatch for "${f.id}": corpus=${f.expectedVerdict}, baseline=${b.judgedesk.verdict}`,
      });
    }

    if (b.judgedesk.message !== f.expectedMessage) {
      issues.push({
        type: "FIELD_MISMATCH",
        id: f.id,
        message: `JudgeDesk expected message mismatch for "${f.id}": corpus="${f.expectedMessage}", baseline="${b.judgedesk.message}"`,
      });
    }

    // 5. Parity status rules:
    // C1–C4 must have VERIFIED_EXACT_MATCH
    // C5 must have INTENTIONALLY_NOT_EMULATED
    if (f.checker === "C5") {
      if (b.parityStatus !== "INTENTIONALLY_NOT_EMULATED") {
        issues.push({
          type: "INVALID_PARITY_STATUS",
          id: f.id,
          message: `C5 fixture "${f.id}" must have parityStatus="INTENTIONALLY_NOT_EMULATED", got "${b.parityStatus}"`,
        });
      }
      if (b.productDecision?.decision !== "INTENTIONALLY_NOT_EMULATED") {
        issues.push({
          type: "INVALID_PRODUCT_DECISION",
          id: f.id,
          message: `C5 fixture "${f.id}" must have productDecision.decision="INTENTIONALLY_NOT_EMULATED"`,
        });
      }
      if (!b.productDecision?.rationale || b.productDecision.rationale.trim().length === 0) {
        issues.push({
          type: "INVALID_PRODUCT_DECISION",
          id: f.id,
          message: `C5 fixture "${f.id}" must have a non-empty productDecision.rationale`,
        });
      }
    } else {
      if (b.parityStatus !== "VERIFIED_EXACT_MATCH") {
        issues.push({
          type: "INVALID_PARITY_STATUS",
          id: f.id,
          message: `${f.checker} fixture "${f.id}" must have parityStatus="VERIFIED_EXACT_MATCH", got "${b.parityStatus}"`,
        });
      }
    }
  }

  // 6. DLL hashes verification
  const requiredDlls = ["C1", "C2", "C3", "C4", "C5"];
  for (const dll of requiredDlls) {
    const hash = baseline.dllHashes[dll];
    if (!hash || !/^[0-9A-F]{64}$/.test(hash)) {
      issues.push({
        type: "DLL_HASH_MISMATCH",
        message: `Baseline dllHashes["${dll}"] is missing or invalid SHA-256: "${hash}"`,
      });
    }
    if (liveDllHashes && liveDllHashes[dll] && liveDllHashes[dll] !== hash) {
      issues.push({
        type: "DLL_HASH_MISMATCH",
        message: `Live DLL hash for ${dll} does not match baseline: live=${liveDllHashes[dll]}, baseline=${hash}`,
      });
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

export function assertOracleBaselineIntegrity(
  corpus: Corpus,
  baseline: ThemisOracleArtifactPayload,
  liveDllHashes?: Record<string, string>,
): void {
  const res = validateOracleBaselineIntegrity(corpus, baseline, liveDllHashes);
  if (!res.valid) {
    const formatted = res.issues.map((i) => `  - [${i.type}] ${i.message}`).join("\n");
    throw new Error(`[Oracle Baseline Integrity Failure] Found ${res.issues.length} issue(s):\n${formatted}`);
  }
}
