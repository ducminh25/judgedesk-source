#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import {
  NodeBackendAdapter,
  RustBackendAdapter,
  type BackendAdapter,
} from "../server/test-fixtures/api-contracts/backend-adapter.js";
import {
  CANONICAL_CONTRACT_CASES,
  createContractContext,
  cleanContractContext,
} from "../server/test-fixtures/api-contracts/contract-cases.js";
import {
  normalizeVolatile,
  parseSseInitialEvent,
  parseNdjsonStream,
} from "../server/test-fixtures/api-contracts/normalizer.js";
import {
  createIsolatedTestEnvironment,
  recordHostAppDataHashes,
  assertHostAppDataUnchanged,
  runCompositionalTeardown,
  type IsolatedTestEnvironment,
} from "../server/test-fixtures/api-contracts/test-environment.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturesDir = path.join(repoRoot, "server", "test-fixtures", "api-contracts");
const reportPath = path.join(
  repoRoot,
  "docs",
  "verification",
  "pure-rust-core",
  "rust-contract-parity-report.json",
);

export interface ParityCaseResult {
  id: string;
  name: string;
  method: string;
  path: string;
  expectedStatus: number;
  actualStatus: number | null;
  statusMatch: boolean;
  bodyMatch: boolean;
  passed: boolean;
  mismatchReason?: string;
  knownRustGap?: string;
}

export interface ParityRunReport {
  adapter: "node" | "rust";
  timestamp: string;
  totalCases: number;
  passedCount: number;
  mismatchCount: number;
  backgroundErrors?: string[];
  results: ParityCaseResult[];
}

export async function runContractParity(adapterType: "node" | "rust"): Promise<ParityRunReport> {
  let hostBaseline: Map<string, string> | null = null;
  let env: IsolatedTestEnvironment | null = null;
  let adapter: BackendAdapter | null = null;
  let ctx: ReturnType<typeof createContractContext> | null = null;
  const results: ParityCaseResult[] = [];

  try {
    hostBaseline = recordHostAppDataHashes();
    env = createIsolatedTestEnvironment();
    adapter = adapterType === "node" ? new NodeBackendAdapter(env) : new RustBackendAdapter(env);

    console.log(`[check-contract-parity] Starting ${adapterType.toUpperCase()} backend adapter in isolated root: ${env.rootDir}...`);
    await adapter.start();
    console.log(`[check-contract-parity] Adapter listening at ${adapter.baseUrl}`);

    ctx = createContractContext(env.tempDir);

    for (const testCase of CANONICAL_CONTRACT_CASES) {
      testCase.before?.(ctx);
      const casePath = testCase.path(ctx);
      const headers = testCase.headers ? testCase.headers(ctx) : {};
      const rawBody = testCase.body ? testCase.body(ctx) : null;

      console.log(`  -> Case [${testCase.method} ${casePath}] ...`);
      let actualStatus: number | null = null;
      let actualBody: unknown = null;
      let mismatchReason: string | undefined;

      try {
        const fetchInit: RequestInit = {
          method: testCase.method,
          headers,
          signal: AbortSignal.timeout(5000),
        };
        if (rawBody) {
          fetchInit.body = rawBody as BodyInit;
        }

        const res = await adapter.fetch(casePath, fetchInit);
        actualStatus = res.status;

        const contentType = res.headers.get("content-type") || "";

        if (testCase.streaming === "sse") {
          const reader = res.body?.getReader();
          if (reader) {
            const { value } = await reader.read();
            await reader.cancel();
            const text = value ? new TextDecoder().decode(value) : "";
            actualBody = parseSseInitialEvent(text);
          } else {
            actualBody = { protocol: "text/event-stream" };
          }
        } else if (testCase.streaming === "ndjson") {
          const text = await res.text();
          actualBody = parseNdjsonStream(text);
        } else if (contentType.includes("application/json")) {
          actualBody = await res.json();
        } else {
          actualBody = await res.text();
        }

        const statusMatch = actualStatus === testCase.expectedStatus;

        // Load and normalize golden fixture
        const fixturePath = path.join(fixturesDir, testCase.fixtureFile);
        let expectedFixture: unknown = null;
        if (fs.existsSync(fixturePath)) {
          expectedFixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
        }

        const normalizerOpts = {
          envRootDir: env.rootDir,
          tempRoot: env.tempDir,
        };
        const normalizedActual = normalizeVolatile(actualBody, normalizerOpts);
        const normalizedExpected = normalizeVolatile(expectedFixture, normalizerOpts);

        let bodyMatch = true;
        try {
          assert.deepStrictEqual(normalizedActual, normalizedExpected);
        } catch (diffErr) {
          bodyMatch = false;
          const message = diffErr instanceof Error ? diffErr.message : String(diffErr);
          mismatchReason = `Body mismatch: ${message}`;
        }

        if (!statusMatch) {
          mismatchReason = `Status mismatch: expected HTTP ${testCase.expectedStatus}, got HTTP ${actualStatus}. ${mismatchReason || ""}`.trim();
        }

        const passed = statusMatch && bodyMatch;
        results.push({
          id: testCase.id,
          name: testCase.name,
          method: testCase.method,
          path: casePath,
          expectedStatus: testCase.expectedStatus,
          actualStatus,
          statusMatch,
          bodyMatch,
          passed,
          mismatchReason: passed ? undefined : mismatchReason,
          knownRustGap: testCase.knownRustGap,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({
          id: testCase.id,
          name: testCase.name,
          method: testCase.method,
          path: casePath,
          expectedStatus: testCase.expectedStatus,
          actualStatus,
          statusMatch: false,
          bodyMatch: false,
          passed: false,
          mismatchReason: `Transport failure: ${message}`,
          knownRustGap: testCase.knownRustGap,
        });
      }
    }
  } finally {
    const backgroundErrors: string[] = [];
    let teardownErr: unknown = null;
    try {
      await runCompositionalTeardown([
        {
          name: "backendAdapter",
          run: async () => {
            if (adapter) {
              try {
                await adapter.close();
              } catch (closeErr) {
                const messages =
                  closeErr instanceof AggregateError
                    ? closeErr.errors.map((e: unknown) =>
                        e instanceof Error ? e.message : String(e),
                      )
                    : [closeErr instanceof Error ? closeErr.message : String(closeErr)];
                backgroundErrors.push(...messages);
                throw closeErr;
              }
            }
          },
        },
        {
          name: "contractContext",
          run: () => {
            if (ctx) cleanContractContext(ctx);
          },
        },
        {
          name: "testEnvironment",
          run: async () => {
            if (env) await env.cleanup();
          },
        },
        {
          name: "hostAppDataAudit",
          run: () => {
            if (hostBaseline) assertHostAppDataUnchanged(hostBaseline);
          },
        },
      ]);
    } catch (err) {
      teardownErr = err;
    }

    const passedCount = results.filter((r) => r.passed).length;
    const mismatchCount = results.length - passedCount;

    const report: ParityRunReport = {
      adapter: adapterType,
      timestamp: new Date().toISOString(),
      totalCases: results.length,
      passedCount,
      mismatchCount,
      backgroundErrors: backgroundErrors.length > 0 ? backgroundErrors : undefined,
      results,
    };

    if (adapterType === "rust") {
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
      console.log(`[check-contract-parity] Wrote Rust contract parity report to ${reportPath}`);
    }

    if (teardownErr) {
      throw teardownErr;
    }

    return report;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const isRust = process.argv.includes("--adapter=rust");
  const adapterType = isRust ? "rust" : "node";
  const reportOnly = process.argv.includes("--report-only");

  runContractParity(adapterType)
    .then((report) => {
      console.log("\n=======================================================");
      console.log(`  CONTRACT PARITY REPORT: ${report.adapter.toUpperCase()} ADAPTER`);
      console.log("=======================================================");
      console.log(`  Total Cases Run: ${report.totalCases}`);
      console.log(`  Passed Cases:    ${report.passedCount}`);
      console.log(`  Mismatches:      ${report.mismatchCount}`);
      console.log("-------------------------------------------------------");

      if (report.mismatchCount > 0) {
        console.log("\n  Discovered Mismatches (Contract Differences):");
        for (const r of report.results.filter((x) => !x.passed)) {
          console.log(`  ✖ [${r.method} ${r.path}] ${r.name}`);
          console.log(`    Expected: HTTP ${r.expectedStatus}`);
          console.log(`    Observed: HTTP ${r.actualStatus}`);
          console.log(`    Detail:   ${r.mismatchReason}`);
          if (r.knownRustGap) {
            console.log(`    Phase:    ${r.knownRustGap}`);
          }
          console.log("");
        }
      }

      if (report.backgroundErrors && report.backgroundErrors.length > 0) {
        console.error("\n  [check-contract-parity] Background Errors Encountered:");
        for (const err of report.backgroundErrors) {
          console.error(`    ✖ ${err}`);
        }
        process.exit(1);
      }

      if (adapterType === "node") {
        if (report.mismatchCount > 0) {
          console.error(`[check-contract-parity] FAILURE: Node reference baseline has ${report.mismatchCount} mismatch(es).`);
          process.exit(1);
        }
        console.log("[check-contract-parity] SUCCESS: Node reference baseline 100% compliant with golden fixtures.");
        process.exit(0);
      } else {
        // Rust adapter report: records real mismatches as requested by WP0.2 remediation
        console.log(`[check-contract-parity] Rust adapter executed: ${report.passedCount}/${report.totalCases} passed, ${report.mismatchCount} gaps documented.`);
        if (report.mismatchCount > 0 && !reportOnly) {
          console.error(`[check-contract-parity] STRICT FAILURE: Rust has ${report.mismatchCount} contract mismatch(es) against golden fixtures.`);
          process.exit(1);
        }
        process.exit(0);
      }
    })
    .catch((err) => {
      console.error("[check-contract-parity] Fatal error running parity:", err);
      process.exit(1);
    });
}
