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

function adaptExpectedFixtureForHost(caseId: string, fixture: unknown): unknown {
  if (process.platform !== "darwin" || !fixture || typeof fixture !== "object") {
    return fixture;
  }
  const cloned = JSON.parse(JSON.stringify(fixture)) as Record<string, unknown>;
  const arch = process.arch;

  if (caseId === "get-status") {
    cloned.platform = "darwin";
    cloned.gpp = {
      checkerReady: false,
      diagnostic: "Managed toolchain is not supported on this host.",
      installed: false,
      managedInstalled: false,
      source: "managed",
      submissionReady: false,
      version: "Not found",
    };
    return cloned;
  }

  if (caseId === "get-distribution") {
    cloned.platform = "darwin";
    cloned.arch = arch;
    return cloned;
  }

  if (caseId === "get-toolchains") {
    cloned.platform = "darwin";
    cloned.arch = arch;
    const active = cloned.active as Record<string, unknown>;
    active.cpp = {
      diagnostic: "Managed toolchain is not supported on this host.",
      diagnosticCode: "MANAGED_PACKAGE_UNSUPPORTED",
      executablePath: "",
      kind: "cpp",
      ready: false,
      source: "managed",
      version: "",
    };
    active.python = {
      ...(active.python as Record<string, unknown>),
      executablePath:
        "<TEMP_ROOT>/<ISOLATED_ENV>/appdata/toolchains/python-macos-arm64/bin/python3",
      packageRoot:
        "<TEMP_ROOT>/<ISOLATED_ENV>/appdata/toolchains/python-macos-arm64",
    };
    const capabilities = cloned.capabilities as Record<string, unknown>;
    capabilities.cpp = {
      checkerReady: false,
      detected: false,
      installable: false,
      managed: false,
      submissionReady: false,
    };
    const profiles = cloned.profiles as Array<Record<string, unknown>>;
    for (const p of profiles) {
      if (p.id === "cpp-legacy-v1" || p.id === "c-gcc14") {
        const kind = p.kind as string;
        p.active = {
          diagnostic: "Managed toolchain is not supported on this host.",
          diagnosticCode: "MANAGED_PACKAGE_UNSUPPORTED",
          executablePath: "",
          kind,
          ready: false,
          source: "managed",
          version: "",
        };
        if (p.id === "cpp-legacy-v1") {
          p.certification = {
            canCertify: false,
            required: false,
            supported: false,
          };
        }
        p.detected = false;
        p.diagnostic = {
          code: "MANAGED_PACKAGE_UNSUPPORTED",
          message: "Managed toolchain is not supported on this host.",
          messageKey: "toolchains.diagnostics.MANAGED_PACKAGE_UNSUPPORTED",
        };
        p.localPolicy = {
          executionMode: "quick_verified_direct",
          supportedVersions: [">=9.0.0"],
        };
        delete p.managedPackage;
        p.roles = {
          checkerReady: false,
          submissionReady: false,
        };
        p.sources = {
          local_auto: { available: true },
          local_path: { available: true },
          managed: {
            available: false,
            reasonCode: "MANAGED_PACKAGE_UNSUPPORTED",
          },
          none: { available: true },
        };
        p.status = "not_available";
      } else if (p.id === "python-cpython312") {
        const act = p.active as Record<string, unknown>;
        act.executablePath =
          "<TEMP_ROOT>/<ISOLATED_ENV>/appdata/toolchains/python-macos-arm64/bin/python3";
        act.packageRoot =
          "<TEMP_ROOT>/<ISOLATED_ENV>/appdata/toolchains/python-macos-arm64";
        (p.localPolicy as Record<string, unknown>).executionMode =
          "quick_verified_direct";
        const pkg = p.managedPackage as Record<string, unknown>;
        pkg.id = "python-macos-arm64";
        (pkg.progress as Record<string, unknown>).id = "python-macos-arm64";
        p.sources = {
          local_auto: { available: true },
          local_path: { available: true },
          managed: { available: true },
          none: { available: true },
        };
      } else if (p.id === "pascal-fpc322") {
        const act = p.active as Record<string, unknown>;
        act.executablePath =
          "<TEMP_ROOT>/<ISOLATED_ENV>/appdata/toolchains/fpc-macos-arm64/bin/fpc";
        act.packageRoot =
          "<TEMP_ROOT>/<ISOLATED_ENV>/appdata/toolchains/fpc-macos-arm64";
        const pkg = p.managedPackage as Record<string, unknown>;
        pkg.id = "fpc-macos-arm64";
        (pkg.progress as Record<string, unknown>).id = "fpc-macos-arm64";
      } else if (p.id === "java-temurin21") {
        const act = p.active as Record<string, unknown>;
        act.executablePath =
          "<TEMP_ROOT>/<ISOLATED_ENV>/appdata/toolchains/temurin21-macos-arm64/bin/javac";
        act.packageRoot =
          "<TEMP_ROOT>/<ISOLATED_ENV>/appdata/toolchains/temurin21-macos-arm64";
        const pkg = p.managedPackage as Record<string, unknown>;
        pkg.id = "temurin21-macos-arm64";
        (pkg.progress as Record<string, unknown>).id = "temurin21-macos-arm64";
      } else if (p.id === "scratch-turbowarp-v1") {
        const act = p.active as Record<string, unknown>;
        act.executablePath =
          "<TEMP_ROOT>/<ISOLATED_ENV>/appdata/toolchains/scratch-macos-arm64/scratch-run";
        act.packageRoot =
          "<TEMP_ROOT>/<ISOLATED_ENV>/appdata/toolchains/scratch-macos-arm64";
        const pkg = p.managedPackage as Record<string, unknown>;
        pkg.id = "scratch-macos-arm64";
        (pkg.progress as Record<string, unknown>).id = "scratch-macos-arm64";
      }
    }
    return cloned;
  }

  if (
    caseId === "post-toolchain-certification-plan" ||
    caseId === "post-toolchain-certify"
  ) {
    cloned.message =
      "Local certification is currently available for Windows GNU C++ only.";
    return cloned;
  }

  if (caseId === "post-toolchain-diagnose") {
    cloned.diagnostic = {
      error: "Managed toolchain not installed.",
      language: "cpp",
      phase: "configuration",
      profileId: "cpp-legacy-v1",
      sourceMode: "managed",
      success: false,
      version: "",
    };
    return cloned;
  }

  if (caseId === "post-open-excel") {
    cloned.openMode = "system-open";
    return cloned;
  }

  if (caseId === "post-batch-judge" && Array.isArray(cloned)) {
    for (const item of cloned as Array<Record<string, unknown>>) {
      if (item.type === "metadata" && item.data && typeof item.data === "object") {
        const data = item.data as Record<string, unknown>;
        data.platform = "darwin";
        data.arch = arch;
        const toolchains = data.toolchains as Record<string, unknown>;
        toolchains.cpp = {
          checkerReady: false,
          source: "managed",
          submissionReady: false,
          version: "",
        };
      }
    }
    return cloned;
  }

  return cloned;
}

export async function runContractParity(
  adapterType: "node" | "rust",
  options: { writeReport?: boolean } = {},
): Promise<ParityRunReport> {
  const { writeReport = false } = options;
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
          expectedFixture = adaptExpectedFixtureForHost(
            testCase.id,
            JSON.parse(fs.readFileSync(fixturePath, "utf8")),
          );
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

    if (adapterType === "rust" && writeReport) {
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

  runContractParity(adapterType, { writeReport: true })
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
