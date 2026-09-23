import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { EventEmitter } from "node:events";
import { spawn, execSync } from "node:child_process";
import express from "express";
import {
  NodeBackendAdapter,
  RustBackendAdapter,
  type BackendAdapter,
} from "./test-fixtures/api-contracts/backend-adapter.js";
import { runContractInventory } from "../scripts/check-api-contracts.js";
import { runContractParity } from "../scripts/check-contract-parity.js";
import {
  createIsolatedTestEnvironment,
  recordHostAppDataHashes,
  assertHostAppDataUnchanged,
  runCompositionalTeardown,
  type IsolatedTestEnvironment,
} from "./test-fixtures/api-contracts/test-environment.js";
import {
  cleanContractContext,
  type ContractCaseContext,
} from "./test-fixtures/api-contracts/contract-cases.js";
import { executorClient } from "./executor/client.js";
import {
  SCORE_EXPORT_CONTENT_TYPE,
  MAX_SCORE_EXPORT_PAYLOAD_BYTES,
} from "../shared/score-export-wire.js";
import {
  prepareServerShutdown,
  registerSystemRoutes,
  type ServerShutdownDependencies,
} from "./routes/system-routes.js";
import { ServerLifecycle, serverLifecycle } from "./platform/server-lifecycle.js";
import {
  drainToolchainDiscovery,
  registerDiscoveryChildForTests,
  getActiveDiscoveryChildrenCountForTests,
  registerCompatibilityProbeForTests,
  getActiveCompatibilityProbesCountForTests,
  forceClearToolchainDiscoveryRuntimeForTests,
} from "./toolchains/discovery.js";
import {
  loadToolchainPreferenceSnapshot,
  getPreferencesFilePath,
  getAppDataDir,
} from "./toolchains/storage.js";
import {
  startBackgroundJudgePrewarm,
  ensureJudgePrewarmReady,
  resetJudgePrewarmStateForTests,
} from "./judge/background-prewarm.js";
import {
  isSafeTestAppDataDir,
  resolveTestAppDataDir,
  evaluateChildResult,
} from "../scripts/run-all-tests.js";
import { registerToolchainRoutes } from "./routes/toolchain-routes.js";
import type { ChildProcess } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("WP0.2 API and Stream Contract Verification", () => {
  let adapter: NodeBackendAdapter;
  let testEnv: IsolatedTestEnvironment;
  let hostBaseline: Map<string, string>;

  before(async () => {
    hostBaseline = recordHostAppDataHashes();
    testEnv = createIsolatedTestEnvironment();
    adapter = new NodeBackendAdapter(testEnv);
    await adapter.start();
  });

  after(async () => {
    await runCompositionalTeardown([
      {
        name: "backendAdapter",
        run: async () => {
          if (adapter) await adapter.close();
        },
      },
      {
        name: "testEnvironment",
        run: async () => {
          if (testEnv) await testEnv.cleanup();
        },
      },
      {
        name: "hostAppDataAudit",
        run: () => {
          if (hostBaseline) assertHostAppDataUnchanged(hostBaseline);
        },
      },
    ]);
  });

  describe("Contract Manifest & Route Inventory Integrity", () => {
    it("satisfies the deterministic route and caller inventory gate", () => {
      const result = runContractInventory();
      assert.equal(result.passed, true, `Inventory failed with errors: ${result.errors.join("; ")}`);
      assert.equal(result.manifestRoutes, 29);
      assert.ok(result.frontendCallersFound >= 20);
      assert.equal(result.nodeRoutesFound, 29);
      assert.equal(result.rustRoutesFound, 29);
    });

    it("ensures all golden fixtures exist on disk and parse as valid JSON", () => {
      const manifestPath = path.join(repoRoot, "docs", "verification", "pure-rust-core", "api-contract-manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

      for (const route of manifest.routes) {
        assert.ok(route.goldenSuccessFixture, `Route ${route.id} must define goldenSuccessFixture`);
        const fixturePath = path.join(repoRoot, route.goldenSuccessFixture);
        assert.ok(fs.existsSync(fixturePath), `Golden fixture ${route.goldenSuccessFixture} must exist on disk`);

        const content = fs.readFileSync(fixturePath, "utf8");
        assert.doesNotThrow(() => JSON.parse(content), `Fixture ${route.goldenSuccessFixture} must be valid JSON`);

        for (const failureFixture of route.goldenFailureFixtures) {
          const failPath = path.join(repoRoot, failureFixture);
          assert.ok(fs.existsSync(failPath), `Failure fixture ${failureFixture} must exist on disk`);
          assert.doesNotThrow(() => JSON.parse(fs.readFileSync(failPath, "utf8")), `Fixture ${failureFixture} must be valid JSON`);
        }
      }
    });
  });

  describe("Executable Golden Fixture Parity (Node Reference Baseline)", () => {
    it("satisfies 100% golden fixture parity on Node reference baseline (30/30 cases)", async () => {
      const report = await runContractParity("node");
      const mismatches = report.results.filter((r) => !r.passed);
      if (mismatches.length > 0) {
        console.error("MISMATCH DETAILS:", JSON.stringify(mismatches.map(m => ({ id: m.id, reason: m.mismatchReason })), null, 2));
      }
      assert.equal(report.mismatchCount, 0, `Mismatches: ${mismatches.map((m) => m.id).join(", ")}`);
      assert.equal(report.passedCount, 30);
    });
  });

  describe("Live Endpoint Family Assertions", () => {
    it("GET /api/status returns 200 with platform and runner diagnostics", async () => {
      const res = await adapter.fetch("/api/status");
      assert.equal(res.status, 200);
      const data = (await res.json()) as Record<string, unknown>;
      assert.ok(data.gpp !== undefined);
      assert.ok(data.python !== undefined);
      assert.ok(data.platform !== undefined);
      assert.ok(data.secureRunner !== undefined);
    });

    it("POST /api/select-directory handles cancellation and custom selection", async () => {
      testEnv.setMockSelectDirectory("__CANCEL__");
      const cancelRes = await adapter.fetch("/api/select-directory", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ defaultPath: "" }),
      });
      assert.equal(cancelRes.status, 200);
      const cancelData = (await cancelRes.json()) as { success: boolean; error: string };
      assert.equal(cancelData.success, false);
      assert.equal(cancelData.error, "Canceled");

      testEnv.setMockSelectDirectory(testEnv.tempDir);
      const successRes = await adapter.fetch("/api/select-directory", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ defaultPath: "" }),
      });
      assert.equal(successRes.status, 200);
      const successData = (await successRes.json()) as { success: boolean; path: string };
      assert.equal(successData.success, true);
      assert.equal(path.normalize(successData.path), path.normalize(testEnv.tempDir));
    });

    it("GET and POST /api/polygon-config stores and reads config", async () => {
      const problemDir = path.join(testEnv.tempDir, "polygon_test_prob");
      fs.mkdirSync(problemDir, { recursive: true });

      const postRes = await adapter.fetch("/api/polygon-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: problemDir,
          config: {
            enableGroups: true,
            tests: { "Test01": 5 },
            groups: {},
          },
        }),
      });
      assert.equal(postRes.status, 200);

      const getRes = await adapter.fetch(
        `/api/polygon-config?path=${encodeURIComponent(problemDir)}`,
      );
      assert.equal(getRes.status, 200);
      const data = (await getRes.json()) as {
        success: boolean;
        data: { enableGroups: boolean; tests: Record<string, number> };
      };
      assert.equal(data.success, true);
      assert.equal(data.data.enableGroups, true);
      assert.equal(data.data.tests["Test01"], 5);
    });

    it("exercises dynamic toolchain routes (:id and :profileId)", async () => {
      // 1. Toolchain install cancel
      const cancelRes = await adapter.fetch(
        "/api/toolchains/gcc-windows-x64/cancel",
        { method: "POST" },
      );
      assert.equal(cancelRes.status, 200);

      // 2. Profile preference update
      const prefRes = await adapter.fetch(
        "/api/toolchains/profiles/cpp-legacy-v1/preference",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "managed" }),
        },
      );
      assert.equal(prefRes.status, 200);

      // 3. Profile diagnose
      const diagRes = await adapter.fetch(
        "/api/toolchains/profiles/cpp-legacy-v1/diagnose",
        { method: "POST" },
      );
      assert.equal(diagRes.status, 200);
    });
  });

  describe("Adverse Paths and Edge Case Contracts", () => {
    it("rejects malformed JSON body with HTTP 400 Bad Request", async () => {
      const res = await adapter.fetch("/api/polygon-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "NOT_VALID_JSON{{{",
      });
      assert.equal(res.status, 400);
    });

    it("rejects missing path query parameter on problem routes with HTTP 400", async () => {
      const contestantsRes = await adapter.fetch("/api/fetch-contestants");
      assert.equal(contestantsRes.status, 400);
      const contestantsData = (await contestantsRes.json()) as { code: string };
      assert.equal(contestantsData.code, "PATH_REQUIRED");

      const problemsRes = await adapter.fetch("/api/fetch-problems");
      assert.equal(problemsRes.status, 400);
      const problemsData = (await problemsRes.json()) as { code: string };
      assert.equal(problemsData.code, "PATH_REQUIRED");

      const testsRes = await adapter.fetch("/api/fetch-tests");
      assert.equal(testsRes.status, 400);
      const testsData = (await testsRes.json()) as { code: string };
      assert.equal(testsData.code, "PATH_REQUIRED");
    });

    it("handles Unicode directory paths correctly without byte-truncation corruption", async () => {
      const unicodeDir = path.join(testEnv.tempDir, "thí_sinh_tiếng_việt_đặc_biệt");
      fs.mkdirSync(path.join(unicodeDir, "bài_nộp_01"), { recursive: true });

      const res = await adapter.fetch(
        `/api/fetch-contestants?path=${encodeURIComponent(unicodeDir)}`,
      );
      assert.equal(res.status, 200);
      const data = (await res.json()) as { success: boolean; data: string[] };
      assert.equal(data.success, true);
      assert.deepEqual(data.data, ["bài_nộp_01"]);
    });

    it("enforces wire export protocol and size limits on POST /api/open-excel", async () => {
      // 1. Wrong MIME type yields HTTP 400
      const wrongMimeRes = await adapter.fetch("/api/open-excel", {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.judgedesk.score-export-bundle",
        },
        body: new Uint8Array(10),
      });
      assert.equal(wrongMimeRes.status, 400);
      const wrongMimeData = (await wrongMimeRes.json()) as {
        success: boolean;
        message: string;
      };
      assert.equal(wrongMimeData.success, false);
      assert.equal(wrongMimeData.message, "Score export payload is required.");

      // 2. Empty payload yields HTTP 400
      const emptyRes = await adapter.fetch("/api/open-excel", {
        method: "POST",
        headers: { "Content-Type": SCORE_EXPORT_CONTENT_TYPE },
        body: new Uint8Array(0),
      });
      assert.equal(emptyRes.status, 400);

      // 3. Oversized payload exceeding 256 MiB yields HTTP 413 Payload Too Large
      const oversizedPayload = Buffer.alloc(MAX_SCORE_EXPORT_PAYLOAD_BYTES + 1);
      const oversizedRes = await adapter.fetch("/api/open-excel", {
        method: "POST",
        headers: { "Content-Type": SCORE_EXPORT_CONTENT_TYPE },
        body: oversizedPayload,
      });
      assert.equal(oversizedRes.status, 413);
    });

    it("validates batch-judge input paths and executor health before admission", async () => {
      const origDescriptor = Object.getOwnPropertyDescriptor(
        executorClient,
        "health",
      );
      try {
        // 1. Unavailable executor: returns 200 with error event
        Object.defineProperty(executorClient, "health", {
          configurable: true,
          get: () => ({
            ready: false,
            mode: "unavailable",
            executorVersion: "unknown",
            diagnostics: ["Executor has not started."],
            networkBlocked: false,
            filesystemIsolated: false,
            processTreeControlled: false,
            memoryLimitSupported: false,
          }),
        });

        const unavailableRes = await adapter.fetch("/api/batch-judge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        assert.equal(unavailableRes.status, 200);
        const text = await unavailableRes.text();
        assert.ok(text.includes("SECURE_RUNNER_UNAVAILABLE"));

        // 2. Available executor with missing paths: returns HTTP 400
        Object.defineProperty(executorClient, "health", {
          configurable: true,
          get: () => ({
            ready: true,
            mode: "windows-lpac-job",
            executorVersion: "1.5.0",
            diagnostics: [],
            networkBlocked: true,
            filesystemIsolated: true,
            processTreeControlled: true,
            memoryLimitSupported: true,
          }),
        });

        const missingRes = await adapter.fetch("/api/batch-judge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        assert.equal(missingRes.status, 400);
        const data = (await missingRes.json()) as {
          success: boolean;
          message: string;
        };
        assert.equal(data.success, false);
        assert.equal(data.message, "Missing thisinhPath or testPath.");
      } finally {
        if (origDescriptor) {
          Object.defineProperty(executorClient, "health", origDescriptor);
        }
      }
    });

    it("verifies pre-admission cancellation identity semantics", async () => {
      const preCancelJobId = `pre_admit_test_${Date.now()}`;

      // 1. Cancel before job is admitted
      const cancelRes = await adapter.fetch("/api/batch-judge/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: preCancelJobId }),
      });
      assert.equal(cancelRes.status, 200);
      const cancelData = (await cancelRes.json()) as {
        success: boolean;
        pending: boolean;
      };
      assert.equal(cancelData.success, true);
      assert.equal(cancelData.pending, true);

      // 2. Ensure mock executor health allows admission check
      const origDescriptor = Object.getOwnPropertyDescriptor(
        executorClient,
        "health",
      );
      try {
        Object.defineProperty(executorClient, "health", {
          configurable: true,
          get: () => ({
            ready: true,
            mode: "windows-lpac-job",
            executorVersion: "1.5.0",
            diagnostics: [],
            networkBlocked: true,
            filesystemIsolated: true,
            processTreeControlled: true,
            memoryLimitSupported: true,
          }),
        });

        const contestantsDir = path.join(testEnv.tempDir, "contestants");
        const problemsDir = path.join(testEnv.tempDir, "problems");
        fs.mkdirSync(contestantsDir, { recursive: true });
        fs.mkdirSync(problemsDir, { recursive: true });

        const batchRes = await adapter.fetch("/api/batch-judge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            thisinhPath: contestantsDir,
            testPath: problemsDir,
            jobId: preCancelJobId,
          }),
        });
        assert.equal(batchRes.status, 200);
        const text = await batchRes.text();
        assert.ok(
          text.includes(
            "JUDGE_CANCELLED: cancellation arrived before this judging request.",
          ),
        );
      } finally {
        if (origDescriptor) {
          Object.defineProperty(executorClient, "health", origDescriptor);
        }
      }
    });

    it("verifies server shutdown drain success (200) vs timeout (503)", async () => {
      // 1. Success path: active session finishes within timeout
      const idleDeps: ServerShutdownDependencies = {
        beginDrain: () => {},
        cancelActiveJudgeJobs: () => 0,
        waitForJudgeSessionsToFinish: async () => true,
        shutdownExecutor: async () => {},
        scheduleProcessExit: () => {},
        activeJudgeSessionCount: () => 0,
        drainTimeoutMs: 100,
      };
      const successResult = await prepareServerShutdown(idleDeps);
      assert.equal(successResult.ok, true);

      // 2. Timeout path: active session does not finish within timeout
      const busyDeps: ServerShutdownDependencies = {
        beginDrain: () => {},
        cancelActiveJudgeJobs: () => 0,
        waitForJudgeSessionsToFinish: async () => false,
        shutdownExecutor: async () => {},
        scheduleProcessExit: () => {},
        activeJudgeSessionCount: () => 2,
        drainTimeoutMs: 10,
      };
      const timeoutResult = await prepareServerShutdown(busyDeps);
      assert.equal(timeoutResult.ok, false);
      if (timeoutResult.ok === false) {
        assert.equal(timeoutResult.code, "JUDGE_DRAIN_TIMEOUT");
        assert.ok(timeoutResult.message.includes("2 active judging session(s)"));
      }
    });

    it("verifies SSE and stream client disconnect lifecycle handling", async () => {
      // 1. SSE /api/osd/events connects and cleans up on client abort
      const controller = new AbortController();
      const sseRes = await adapter.fetch("/api/osd/events", {
        signal: controller.signal,
      });
      assert.equal(sseRes.status, 200);
      assert.equal(sseRes.headers.get("content-type"), "text/event-stream");

      const reader = sseRes.body!.getReader();
      const chunk = await reader.read();
      assert.ok(!chunk.done);
      const text = new TextDecoder().decode(chunk.value);
      assert.ok(text.includes("osd_status"));

      // Disconnect client
      controller.abort();

      // 2. Server remains healthy after disconnect
      const statusRes = await adapter.fetch("/api/osd/status");
      assert.equal(statusRes.status, 200);
      const statusData = (await statusRes.json()) as { success: boolean };
      assert.equal(statusData.success, true);
    });
  });

  describe("Remediation Round 3 Robustness & Teardown Invariants", () => {
    it("refuses to honor JUDGEDESK_TEST_SELECT_DIRECTORY and JUDGEDESK_SUPPRESS_EXCEL_SPAWN in production code", async () => {
      // 1. Static check: neither token exists in production runtime files
      const prodFiles = [
        "server/executor/client.ts",
        "server/platform/directory-picker.ts",
        "server/routes/system-routes.ts",
        "server/export/workbook-opener.ts",
        "server/routes/export-routes.ts",
        "crates/judgedesk-core/src/server/mod.rs",
        "crates/judgedesk-core/src/bin/server.rs",
      ];
      for (const relPath of prodFiles) {
        const fullPath = path.join(repoRoot, relPath);
        assert.ok(fs.existsSync(fullPath), `File ${relPath} must exist`);
        const content = fs.readFileSync(fullPath, "utf8");
        assert.ok(
          !content.includes("JUDGEDESK_TEST_SELECT_DIRECTORY"),
          `Production file ${relPath} must not contain JUDGEDESK_TEST_SELECT_DIRECTORY`,
        );
        assert.ok(
          !content.includes("JUDGEDESK_SUPPRESS_EXCEL_SPAWN"),
          `Production file ${relPath} must not contain JUDGEDESK_SUPPRESS_EXCEL_SPAWN`,
        );
        assert.ok(
          !content.includes("JUDGEDESK_EXECUTOR_TEST_ROOT"),
          `Production file ${relPath} must not contain JUDGEDESK_EXECUTOR_TEST_ROOT`,
        );
      }

      // 2. Runtime behavioral check: system routes ignore JUDGEDESK_TEST_SELECT_DIRECTORY
      const prevEnv = process.env.JUDGEDESK_TEST_SELECT_DIRECTORY;
      process.env.JUDGEDESK_TEST_SELECT_DIRECTORY = path.join(testEnv.tempDir, "untrusted_override_dir");
      try {
        const testApp = express();
        testApp.use(express.json());
        // Injected picker returns null without opening any interactive UI
        registerSystemRoutes(testApp, undefined, () => null);

        const server = await new Promise<import("node:http").Server>((resolve) => {
          const s = testApp.listen(0, "127.0.0.1", () => resolve(s));
        });
        const addr = server.address() as import("node:net").AddressInfo;
        try {
          const res = await fetch(`http://127.0.0.1:${addr.port}/api/select-directory`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ defaultPath: "" }),
          });
          assert.equal(res.status, 200);
          const data = (await res.json()) as { success: boolean; path?: string; error?: string };
          // The route must NOT return the env var override!
          assert.equal(data.success, false);
          assert.equal(data.error, "Canceled");
          assert.equal(data.path, undefined);
        } finally {
          await new Promise<void>((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
          });
        }
      } finally {
        if (prevEnv !== undefined) {
          process.env.JUDGEDESK_TEST_SELECT_DIRECTORY = prevEnv;
        } else {
          delete process.env.JUDGEDESK_TEST_SELECT_DIRECTORY;
        }
      }
    });

    it("ensures adapter startup failure triggers test root cleanup and env restoration", async () => {
      const prevThemisRoot = process.env.THEMIS_ROOT;
      const env = createIsolatedTestEnvironment();
      const rootDir = env.rootDir;
      assert.ok(fs.existsSync(rootDir));

      const failingAdapter: BackendAdapter = {
        name: "node",
        baseUrl: "",
        start: async () => {
          throw new Error("Simulated adapter startup/port bind failure");
        },
        fetch: async () => {
          throw new Error("Unreachable");
        },
        close: async () => {},
      };

      await assert.rejects(async () => {
        try {
          await failingAdapter.start();
        } finally {
          await failingAdapter.close();
          await env.cleanup();
        }
      }, /Simulated adapter startup\/port bind failure/);

      assert.ok(!fs.existsSync(rootDir), `Expected rootDir ${rootDir} to be removed on failure`);
      assert.equal(process.env.THEMIS_ROOT, prevThemisRoot);
    });

    it("throws fail-closed error when test root directory removal fails or is incomplete", async () => {
      // 1. mock removeSync throws EBUSY
      const mockFailingRemove = () => {
        const err = new Error("EBUSY: resource busy or locked");
        (err as unknown as { code: string }).code = "EBUSY";
        throw err;
      };

      const env1 = createIsolatedTestEnvironment({ removeSync: mockFailingRemove });
      const rootDir1 = env1.rootDir;
      assert.ok(fs.existsSync(rootDir1));

      await assert.rejects(
        async () => {
          await env1.cleanup();
        },
        /Fail-closed: failed to fully remove root directory: .* EBUSY/,
      );
      // Clean up directory to prevent leakage
      fs.rmSync(rootDir1, { recursive: true, force: true });

      // 2. mock removeSync is a no-op (leaving directory on disk)
      const mockNoopRemove = () => {};
      const env2 = createIsolatedTestEnvironment({ removeSync: mockNoopRemove });
      const rootDir2 = env2.rootDir;
      assert.ok(fs.existsSync(rootDir2));

      await assert.rejects(
        async () => {
          await env2.cleanup();
        },
        /Fail-closed: failed to fully remove root directory/,
      );
      fs.rmSync(rootDir2, { recursive: true, force: true });

      // 3. cleanContractContext throws fail-closed error when removeFn fails
      const ctxTempDir = path.join(os.tmpdir(), `judgedesk_ctx_fail_${Date.now()}`);
      const ctx: ContractCaseContext = {
        tempDir: ctxTempDir,
        problemDir: path.join(ctxTempDir, "problems"),
        contestantDir: path.join(ctxTempDir, "contestants"),
        exportPayload: new Uint8Array(),
      };
      fs.mkdirSync(ctx.tempDir, { recursive: true });
      assert.throws(
        () => {
          cleanContractContext(ctx, () => {
            throw new Error("EPERM: operation not permitted");
          });
        },
        /cleanContractContext.*Fail-closed: removal failed for .* EPERM/,
      );
      fs.rmSync(ctx.tempDir, { recursive: true, force: true });
    });

    it("guarantees cleanup() is idempotent across repeated calls", async () => {
      const env = createIsolatedTestEnvironment();
      const rootDir = env.rootDir;
      assert.ok(fs.existsSync(rootDir));

      await env.cleanup();
      assert.ok(!fs.existsSync(rootDir));

      // Second invocation
      await assert.doesNotReject(async () => {
        await env.cleanup();
      });

      // Third invocation
      await assert.doesNotReject(async () => {
        await env.cleanup();
      });
    });

    it("quiesces async toolchain background operations before adapter teardown", async () => {
      // 1. Toolchain install route executes and tracks background op
      const localEnv = createIsolatedTestEnvironment();
      const localAdapter = new NodeBackendAdapter(localEnv);
      await localAdapter.start();

      try {
        const res = await localAdapter.fetch("/api/toolchains/gcc-windows-x64/install", {
          method: "POST",
        });
        assert.equal(res.status, 202);
        const body = (await res.json()) as { success: boolean; message: string };
        assert.equal(body.success, true);
        assert.equal(body.message, "Installation started.");
      } finally {
        // close() must settle all background operations before server closes
        await localAdapter.close();
        await localEnv.cleanup();
      }

      // 2. Explicit slow operation tracked in NodeBackendAdapter must be awaited during close()
      const trackingAdapter = new NodeBackendAdapter();
      await trackingAdapter.start();

      let opSettled = false;
      const slowPromise = new Promise<void>((resolve) => {
        setTimeout(() => {
          opSettled = true;
          resolve();
        }, 50);
      });

      trackingAdapter.trackBackgroundOperation(slowPromise);
      assert.equal(opSettled, false);

      await trackingAdapter.close();
      assert.equal(opSettled, true, "adapter.close() must await active background operations to settle");
    });

    it("verifies production release binary does not contain test overrides or bypasses", async () => {
      // 1. Source audit: server.rs has zero test override tokens
      const serverRsPath = path.join(repoRoot, "crates", "judgedesk-core", "src", "bin", "server.rs");
      assert.ok(fs.existsSync(serverRsPath), "server.rs must exist");
      const serverRs = fs.readFileSync(serverRsPath, "utf8");
      assert.ok(!serverRs.includes("JUDGEDESK_TEST_SELECT_DIRECTORY"), "server.rs must not contain JUDGEDESK_TEST_SELECT_DIRECTORY");
      assert.ok(!serverRs.includes("JUDGEDESK_SUPPRESS_EXCEL_SPAWN"), "server.rs must not contain JUDGEDESK_SUPPRESS_EXCEL_SPAWN");
      assert.ok(!serverRs.includes("TestDirectoryPicker"), "server.rs must not contain TestDirectoryPicker");
      assert.ok(!serverRs.includes("TestWorkbookOpener"), "server.rs must not contain TestWorkbookOpener");

      // 2. Cargo feature gate: test-server target cannot be built in release mode without explicit feature
      assert.throws(
        () => {
          execSync(
            "cargo build --release --locked --manifest-path crates/judgedesk-core/Cargo.toml --bin test-server",
            { cwd: repoRoot, stdio: "pipe" },
          );
        },
        /requires the features: `test-server`/,
        "Release build without --features test-server must reject building test-server target",
      );

      // 3. Build release server binary and audit compiled symbols
      execSync(
        "cargo build --release --locked --manifest-path crates/judgedesk-core/Cargo.toml --bin server",
        { cwd: repoRoot, stdio: "pipe" },
      );
      const ext = process.platform === "win32" ? ".exe" : "";
      const binPath = path.join(
        repoRoot,
        "crates",
        "judgedesk-core",
        "target",
        "release",
        `server${ext}`,
      );
      assert.ok(fs.existsSync(binPath), "Release server binary must exist");
      const binBuffer = fs.readFileSync(binPath);
      assert.ok(
        !binBuffer.includes(Buffer.from("JUDGEDESK_TEST_SELECT_DIRECTORY")),
        "Release server binary must not contain JUDGEDESK_TEST_SELECT_DIRECTORY",
      );
      assert.ok(
        !binBuffer.includes(Buffer.from("TestDirectoryPicker")),
        "Release server binary must not contain TestDirectoryPicker symbol",
      );
      assert.ok(
        !binBuffer.includes(Buffer.from("TestWorkbookOpener")),
        "Release server binary must not contain TestWorkbookOpener symbol",
      );
    });

    it("proves nested-root delayed rescan does not mutate outer surrogate AppData", async () => {
      const outerEnv = createIsolatedTestEnvironment();
      try {
        const initialOuterHashes = recordHostAppDataHashes(outerEnv.appDataDir);

        const innerEnv = createIsolatedTestEnvironment();
        const innerAdapter = new NodeBackendAdapter(innerEnv);
        await innerAdapter.start();

        const res = await innerAdapter.fetch("/api/toolchains/rescan", { method: "POST" });
        assert.equal(res.status, 202);

        // Teardown inner environment immediately
        await innerAdapter.close();
        await innerEnv.cleanup();

        // Wait 2000ms to allow any delayed background activity to attempt a late write
        await new Promise((resolve) => setTimeout(resolve, 2000));

        const currentOuterHashes = recordHostAppDataHashes(outerEnv.appDataDir);
        assert.equal(currentOuterHashes.size, initialOuterHashes.size);
        for (const [file, hash] of initialOuterHashes) {
          assert.equal(currentOuterHashes.get(file), hash, `File ${file} in outer surrogate was mutated by late writer!`);
        }
      } finally {
        await outerEnv.cleanup();
      }
    });

    it("fails teardown on unhandled background rejection and prevents unhandledRejection", async () => {
      const trackingAdapter = new NodeBackendAdapter();
      await trackingAdapter.start();

      let unhandledReceived = false;
      const unhandledListener = () => {
        unhandledReceived = true;
      };
      process.on("unhandledRejection", unhandledListener);

      try {
        trackingAdapter.trackBackgroundOperation(Promise.reject(new Error("sentinel-background-failure")));

        await assert.rejects(
          async () => {
            await trackingAdapter.close();
          },
          /sentinel-background-failure/,
        );

        assert.equal(unhandledReceived, false, "Process must not receive unhandledRejection event");
      } finally {
        process.removeListener("unhandledRejection", unhandledListener);
      }
    });

    it("fails teardown when background rejection settles before close() is invoked", async () => {
      const trackingAdapter = new NodeBackendAdapter();
      await trackingAdapter.start();

      trackingAdapter.trackBackgroundOperation(Promise.reject(new Error("settled-before-close")));

      // Wait at least one event-loop turn so the promise settle microtask finishes
      await new Promise((resolve) => setTimeout(resolve, 30));

      await assert.rejects(
        async () => {
          await trackingAdapter.close();
        },
        /settled-before-close/,
      );
    });

    it("stops admission before draining and rejects operations admitted during or after close()", async () => {
      const trackingAdapter = new NodeBackendAdapter();
      await trackingAdapter.start();

      let resolveInFlight!: () => void;
      const inFlightOp = new Promise<string>((resolve) => {
        resolveInFlight = () => resolve("in-flight-work");
      });
      trackingAdapter.trackBackgroundOperation(inFlightOp);

      const closePromise = trackingAdapter.close();

      assert.throws(
        () => {
          trackingAdapter.trackBackgroundOperation(Promise.resolve("admitted-during-close"));
        },
        /Cannot admit background operation: adapter is closing or closed/,
      );

      resolveInFlight();
      await closePromise;

      assert.throws(
        () => {
          trackingAdapter.trackBackgroundOperation(Promise.resolve("admitted-after-close"));
        },
        /Cannot admit background operation: adapter is closing or closed/,
      );
    });

    it("compositional teardown executes all stages and aggregates failures", async () => {
      const dummyEnv = createIsolatedTestEnvironment();
      const dummyDir = dummyEnv.rootDir;
      assert.ok(fs.existsSync(dummyDir));

      let stage2Executed = false;

      await assert.rejects(
        async () => {
          await runCompositionalTeardown([
            {
              name: "failingStage1",
              run: () => {
                throw new Error("Stage 1 deliberate failure");
              },
            },
            {
              name: "stage2",
              run: () => {
                stage2Executed = true;
              },
            },
            {
              name: "cleanupEnvironment",
              run: async () => {
                await dummyEnv.cleanup();
              },
            },
            {
              name: "failingStage4",
              run: () => {
                throw new Error("Stage 4 deliberate failure");
              },
            },
          ]);
        },
        /Compositional teardown failed in 2 stage\(s\)/,
      );

      assert.equal(stage2Executed, true, "Stage 2 must execute even when Stage 1 fails");
      assert.ok(!fs.existsSync(dummyDir), "Environment cleanup must run and remove directory even when other stages fail");
    });

    it("aggregates setup failure and rollback deletion failure, reporting retained path", () => {
      const origWriteFileSync = fs.writeFileSync;
      const origRmSync = fs.rmSync;

      let capturedPath: string | undefined;
      const mockedFs = fs as unknown as {
        writeFileSync: typeof fs.writeFileSync;
        rmSync: typeof fs.rmSync;
      };

      mockedFs.writeFileSync = function (
        targetPath: fs.PathOrFileDescriptor,
        data: string | NodeJS.ArrayBufferView,
        options?: fs.WriteFileOptions,
      ): void {
        if (String(targetPath).includes("toolchains.json")) {
          throw new Error("SENTINEL_SETUP_ERROR");
        }
        return origWriteFileSync(targetPath, data, options as never);
      };

      mockedFs.rmSync = function (targetPath: fs.PathLike): void {
        capturedPath = String(targetPath);
        throw new Error("SENTINEL_ROLLBACK_DELETE_FAILURE");
      };

      try {
        let thrownError: unknown;
        try {
          createIsolatedTestEnvironment();
        } catch (err: unknown) {
          thrownError = err;
        }

        assert.ok(thrownError, "createIsolatedTestEnvironment must throw when setup and rollback fail");
        assert.ok(thrownError instanceof AggregateError, "Must throw AggregateError");
        const msg = thrownError.message;
        assert.ok(msg.includes("SENTINEL_SETUP_ERROR"), "Must include setup error");
        assert.ok(msg.includes("SENTINEL_ROLLBACK_DELETE_FAILURE"), "Must include rollback deletion error");
        assert.ok(msg.includes("Retained path:"), "Must report retained path");
      } finally {
        mockedFs.writeFileSync = origWriteFileSync;
        mockedFs.rmSync = origRmSync;
        if (capturedPath && fs.existsSync(capturedPath)) {
          origRmSync(capturedPath, { recursive: true, force: true });
        }
      }
    });

    it("proves real Node adapter port collision failure path", async () => {
      const blocker = net.createServer();
      const occupiedPort = await new Promise<number>((resolve) => {
        blocker.listen(0, "127.0.0.1", () => {
          resolve((blocker.address() as net.AddressInfo).port);
        });
      });

      const collidingAdapter = new NodeBackendAdapter(undefined, undefined, occupiedPort);
      try {
        await assert.rejects(
          async () => {
            await collidingAdapter.start();
          },
          /EADDRINUSE/,
        );
        assert.throws(
          () => collidingAdapter.baseUrl,
          /NodeBackendAdapter has not been started yet/,
        );
      } finally {
        await new Promise<void>((resolve) => blocker.close(() => resolve()));
        await collidingAdapter.close();
      }
    });

    it("proves real process startup, child process exit observation, and port release/rebind on Rust adapter", async () => {
      const isWin = process.platform === "win32";
      const realServerScript = path.join(os.tmpdir(), `real_mock_server_${Date.now()}.cjs`);
      const launcherScript = path.join(os.tmpdir(), `real_mock_server_${Date.now()}${isWin ? ".cmd" : ".sh"}`);

      const scriptContent = `
const http = require("node:http");
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
});
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  console.log("JUDGEDESK_CORE_PORT=" + port);
});
`;
      fs.writeFileSync(realServerScript, scriptContent, "utf8");
      if (isWin) {
        fs.writeFileSync(launcherScript, `@echo off\r\n"${process.execPath}" "${realServerScript}"\r\n`, "utf8");
      } else {
        fs.writeFileSync(launcherScript, `#!/bin/sh\nexec "${process.execPath}" "${realServerScript}"\n`, "utf8");
        fs.chmodSync(launcherScript, 0o755);
      }

      const adapter = new RustBackendAdapter();
      adapter.customBinPath = launcherScript;
      adapter.startupTimeoutMs = 10000;

      try {
        await adapter.start();
        assert.ok(adapter.baseUrl.startsWith("http://127.0.0.1:"));
        const port = parseInt(new URL(adapter.baseUrl).port, 10);
        assert.ok(port > 0);

        const res = await adapter.fetch("/");
        assert.equal(res.status, 200);

        // Close adapter and verify child process exited and port released
        await adapter.close();

        // Verify port can immediately be rebound
        const rebound = await new Promise<boolean>((resolve) => {
          const s = net.createServer();
          s.once("error", () => resolve(false));
          s.listen(port, "127.0.0.1", () => {
            s.close(() => resolve(true));
          });
        });
        assert.equal(rebound, true, `Port ${port} must be free for immediate rebind after adapter close`);
      } finally {
        await adapter.close();
        fs.rmSync(realServerScript, { force: true });
        fs.rmSync(launcherScript, { force: true });
      }
    });

    it("proves terminateChildProcess rejects when process fails to exit before deadline", async () => {
      const adapter = new RustBackendAdapter();
      const fakeChild = new EventEmitter() as unknown as ChildProcess;
      Object.assign(fakeChild, {
        exitCode: null,
        signalCode: null,
        pid: 999999,
        kill: () => true,
      });

      await assert.rejects(
        async () => {
          await adapter.terminateChildProcess(fakeChild, undefined, 200);
        },
        /failed to exit within 200ms deadline/,
      );
    });

    it("proves terminateChildProcess preserves kill failure errors", async () => {
      const adapter = new RustBackendAdapter();
      const fakeChild = new EventEmitter() as unknown as ChildProcess;
      Object.assign(fakeChild, {
        exitCode: null,
        signalCode: null,
        pid: undefined,
        kill: () => {
          throw new Error("SENTINEL_KILL_FAILURE");
        },
      });

      await assert.rejects(
        async () => {
          await adapter.terminateChildProcess(fakeChild, undefined, 200);
        },
        /SENTINEL_KILL_FAILURE/,
      );
    });

    it("proves real Rust adapter readiness timeout failure path and child cleanup", async () => {
      const isWin = process.platform === "win32";
      const silentScript = path.join(os.tmpdir(), `silent_rust_mock_${Date.now()}${isWin ? ".cmd" : ".sh"}`);
      if (isWin) {
        fs.writeFileSync(silentScript, "@echo off\r\nping 127.0.0.1 -n 5 >nul\r\n", "utf8");
      } else {
        fs.writeFileSync(silentScript, "#!/bin/sh\nsleep 5\n", "utf8");
        fs.chmodSync(silentScript, 0o755);
      }

      const timedOutAdapter = new RustBackendAdapter();
      timedOutAdapter.customBinPath = silentScript;
      timedOutAdapter.startupTimeoutMs = 500;

      try {
        await assert.rejects(
          async () => {
            await timedOutAdapter.start();
          },
          /timed out waiting for readiness signal/,
        );
      } finally {
        await timedOutAdapter.close();
        fs.rmSync(silentScript, { force: true });
      }
    });

    it("proves preference-triggered rescan operation is tracked as background operation and drains on adapter close", async () => {
      let trackedOps = 0;
      const customAdapter = new NodeBackendAdapter(testEnv);
      const originalTrack = customAdapter.trackBackgroundOperation.bind(customAdapter);
      customAdapter.trackBackgroundOperation = (op: Promise<unknown>) => {
        ++trackedOps;
        return originalTrack(op);
      };
      await customAdapter.start();
      try {
        const res = await customAdapter.fetch(
          "/api/toolchains/profiles/python-cpython312/preference",
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode: "managed" }),
          },
        );
        assert.equal(res.status, 200);
        assert.ok(trackedOps >= 1, "Expected preference update to trigger tracked background rescan operation");
      } finally {
        await customAdapter.close();
      }
    });

    it("proves ServerLifecycle stops admission during drain, awaits active ops, and aggregates rejections", async () => {
      const lifecycle = new ServerLifecycle();

      // Track an operation that rejects before drain
      let rejectSettled!: (reason: unknown) => void;
      const settledFail = new Promise<string>((_, reject) => {
        rejectSettled = reject;
      });
      lifecycle.trackBackgroundOperation(settledFail);
      rejectSettled(new Error("settled-early-failure"));
      await new Promise((resolve) => setTimeout(resolve, 30));

      // Track an active in-flight operation that resolves during drain
      let resolveInFlight!: () => void;
      const inFlight = new Promise<string>((resolve) => {
        resolveInFlight = () => resolve("in-flight-ok");
      });
      lifecycle.trackBackgroundOperation(inFlight);

      // Initiate drain
      const drainPromise = lifecycle.drain(100);

      // Attempting to admit background operation during drain must be synchronously rejected
      assert.throws(
        () => {
          lifecycle.trackBackgroundOperation(Promise.resolve("late-drain-admission"));
        },
        /Cannot admit background operation: lifecycle is closing or closed/,
      );

      resolveInFlight();

      // Drain must reject because settledFail rejected
      await assert.rejects(
        async () => {
          await drainPromise;
        },
        /settled-early-failure/,
      );

      // Attempting admission after drain must also be rejected
      assert.throws(
        () => {
          lifecycle.trackBackgroundOperation(Promise.resolve("post-drain-admission"));
        },
        /Cannot admit background operation: lifecycle is closing or closed/,
      );
    });

    it("proves toolchain routes reject background work with 503 when ServerLifecycle is closing", async () => {
      const localLifecycle = new ServerLifecycle();
      localLifecycle.beginDrain();

      const prefFile = getPreferencesFilePath();
      const beforeSnapshot = loadToolchainPreferenceSnapshot();
      const beforeFileContent = fs.existsSync(prefFile) ? fs.readFileSync(prefFile, "utf8") : null;

      const testApp = express();
      testApp.use(express.json());
      registerToolchainRoutes(
        testApp,
        undefined,
        (op) => localLifecycle.trackBackgroundOperation(op),
        localLifecycle,
      );

      const srv = testApp.listen(0, "127.0.0.1");
      await new Promise<void>((resolve) => srv.once("listening", () => resolve()));
      const port = (srv.address() as net.AddressInfo).port;
      const base = `http://127.0.0.1:${port}`;

      try {
        const rescanRes = await fetch(`${base}/api/toolchains/rescan`, { method: "POST" });
        assert.equal(rescanRes.status, 503, "rescan must return 503 when lifecycle is draining");

        const prewarmRes = await fetch(`${base}/api/toolchains/prewarm`, { method: "POST" });
        assert.equal(prewarmRes.status, 503, "prewarm must return 503 when lifecycle is draining");

        // Execution policy
        const policyFile = path.join(getAppDataDir(), "toolchain-execution-policy-v1.json");
        const policyBefore = fs.existsSync(policyFile) ? fs.readFileSync(policyFile, "utf8") : null;
        const policyRes = await fetch(`${base}/api/toolchains/execution-policy`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ allowResourceOnlyLocalExecution: true }),
        });
        assert.equal(policyRes.status, 503, "execution-policy update must return 503 when lifecycle is draining");
        const policyAfter = fs.existsSync(policyFile) ? fs.readFileSync(policyFile, "utf8") : null;
        assert.equal(policyAfter, policyBefore, "execution-policy file must not be modified or created on 503 rejection");

        // Install
        const installRes = await fetch(`${base}/api/toolchains/scratch-windows-x64/install`, {
          method: "POST",
        });
        assert.equal(installRes.status, 503, "install must return 503 when lifecycle is draining");

        // Certification plan
        const planRes = await fetch(`${base}/api/toolchains/profiles/cpp-legacy-v1/certification-plan`, {
          method: "POST",
        });
        assert.equal(planRes.status, 503, "certification-plan must return 503 when lifecycle is draining");

        // Certify
        const certifyRes = await fetch(`${base}/api/toolchains/profiles/cpp-legacy-v1/certify`, {
          method: "POST",
        });
        assert.equal(certifyRes.status, 503, "certify must return 503 when lifecycle is draining");

        // Diagnose
        const diagRes = await fetch(`${base}/api/toolchains/profiles/cpp-legacy-v1/diagnose`, {
          method: "POST",
        });
        assert.equal(diagRes.status, 503, "diagnose must return 503 when lifecycle is draining");

        // Uninstall
        const uninstallRes = await fetch(`${base}/api/toolchains/scratch-windows-x64`, {
          method: "DELETE",
        });
        assert.equal(uninstallRes.status, 503, "delete toolchain must return 503 when lifecycle is draining");

        // Preference update with mode managed
        const prefRes = await fetch(`${base}/api/toolchains/profiles/cpp-legacy-v1/preference`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "managed" }),
        });
        assert.equal(prefRes.status, 503, "preference update must return 503 when lifecycle is draining");

        // Preference update with localPath (must return 503 immediately, NOT 422!)
        const prefLocalRes = await fetch(`${base}/api/toolchains/profiles/cpp-legacy-v1/preference`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "local_path", localPath: "C:\\Windows\\System32\\cmd.exe" }),
        });
        assert.equal(prefLocalRes.status, 503, "preference update with localPath must return 503 when lifecycle is draining");

        // Custom path compatibility route
        const customRes = await fetch(`${base}/api/toolchains/custom-path`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "cpp", preferredSource: "managed" }),
        });
        assert.equal(customRes.status, 503, "custom-path must return 503 when lifecycle is draining");

        const afterSnapshot = loadToolchainPreferenceSnapshot();
        assert.equal(afterSnapshot.revision, beforeSnapshot.revision, "Preference revision must not change on 503 rejection");
        assert.deepEqual(afterSnapshot.preferences, beforeSnapshot.preferences, "Preferences must not mutate on 503 rejection");
        const afterFileContent = fs.existsSync(prefFile) ? fs.readFileSync(prefFile, "utf8") : null;
        assert.equal(afterFileContent, beforeFileContent, "Preference file on disk must remain bitwise identical on 503 rejection");
      } finally {
        await new Promise<void>((resolve) => srv.close(() => resolve()));
      }
    });

    it("proves drainToolchainDiscovery rejects when child process fails to exit before deadline and retains tracking", async () => {
      const hangingChild = new EventEmitter() as unknown as ChildProcess;
      Object.assign(hangingChild, {
        exitCode: null,
        signalCode: null,
        pid: 888888,
        kill: () => true,
      });

      registerDiscoveryChildForTests(hangingChild);
      const initialCount = getActiveDiscoveryChildrenCountForTests();
      assert.ok(initialCount > 0, "Hanging child must be registered");

      await assert.rejects(
        async () => {
          await drainToolchainDiscovery(100);
        },
        /failed to exit within 100ms deadline/,
      );

      // Must NOT remove hanging child from tracking set on deadline failure
      assert.ok(
        getActiveDiscoveryChildrenCountForTests() >= 1,
        "Child process must remain tracked after exit failure",
      );

      // Now simulate child exiting cleanly
      (hangingChild as { exitCode: number | null }).exitCode = 0;
      hangingChild.emit("exit", 0);
      assert.equal(getActiveDiscoveryChildrenCountForTests(), 0);
    });

    it("proves drainToolchainDiscovery preserves child process kill failure errors", async () => {
      const errChild = new EventEmitter() as unknown as ChildProcess;
      Object.assign(errChild, {
        exitCode: null,
        signalCode: null,
        pid: undefined,
        kill: () => {
          throw new Error("SENTINEL_DISCOVERY_KILL_FAIL");
        },
      });

      registerDiscoveryChildForTests(errChild);
      await assert.rejects(
        async () => {
          await drainToolchainDiscovery(100);
        },
        /SENTINEL_DISCOVERY_KILL_FAIL/,
      );

      (errChild as { exitCode: number | null }).exitCode = 0;
      errChild.emit("exit", 0);
      assert.equal(getActiveDiscoveryChildrenCountForTests(), 0);
    });

    it("proves child error event does not clear tracking and rejects deadline without terminal exit", async () => {
      const errChild = new EventEmitter() as unknown as ChildProcess;
      Object.assign(errChild, {
        exitCode: null,
        signalCode: null,
        pid: 999999,
        kill: () => true,
      });
      errChild.on("error", () => {});

      registerDiscoveryChildForTests(errChild);
      assert.ok(getActiveDiscoveryChildrenCountForTests() >= 1);

      try {
        // Emit error event - this must NOT remove child or be treated as exit
        errChild.emit("error", new Error("SPAWN_ERROR"));
        assert.ok(
          getActiveDiscoveryChildrenCountForTests() >= 1,
          "Child must remain tracked after error event without exit",
        );

        // Drain must reject because child has not emitted exit/close with non-null code
        await assert.rejects(
          async () => {
            await drainToolchainDiscovery(100);
          },
          /failed to exit within 100ms deadline/,
        );

        assert.ok(
          getActiveDiscoveryChildrenCountForTests() >= 1,
          "Child must remain tracked after deadline rejection",
        );
      } finally {
        (errChild as { exitCode: number | null }).exitCode = 1;
        errChild.emit("exit", 1);
        assert.equal(getActiveDiscoveryChildrenCountForTests(), 0);
      }
    });

    it("proves compatibility probes are awaited during discovery drain and failures propagated", async () => {
      let rejectProbe!: (err: unknown) => void;
      const probePromise = new Promise<void>((_, reject) => {
        rejectProbe = reject;
      });
      probePromise.catch(() => {});

      registerCompatibilityProbeForTests(probePromise);
      assert.equal(getActiveCompatibilityProbesCountForTests(), 1);

      try {
        // Drain is initiated while probe is pending
        const drainPromise = drainToolchainDiscovery(100);

        // Probe fails
        rejectProbe(new Error("SENTINEL_COMPATIBILITY_PROBE_ERROR"));

        await assert.rejects(
          async () => {
            await drainPromise;
          },
          /SENTINEL_COMPATIBILITY_PROBE_ERROR/,
        );
      } finally {
        assert.equal(getActiveCompatibilityProbesCountForTests(), 0);
      }
    });

    it("proves settled compatibility probe rejections before drain are preserved and reported", async () => {
      const rejectedProbe = Promise.reject(new Error("EARLY_SETTLED_PROBE_ERROR"));
      registerCompatibilityProbeForTests(rejectedProbe);

      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(getActiveCompatibilityProbesCountForTests(), 0);

      await assert.rejects(
        async () => {
          await drainToolchainDiscovery(100);
        },
        /EARLY_SETTLED_PROBE_ERROR/,
      );
    });

    it("proves drainToolchainDiscovery times out bounded by deadlineMs when probe never settles", async () => {
      const neverSettlingProbe = new Promise<void>(() => {});
      registerCompatibilityProbeForTests(neverSettlingProbe);

      const t0 = Date.now();
      await assert.rejects(
        async () => {
          await drainToolchainDiscovery(50);
        },
        /drainToolchainDiscovery timed out after 50ms/,
      );
      const elapsed = Date.now() - t0;
      assert.ok(elapsed < 300, `drainToolchainDiscovery should timeout around 50ms, took ${elapsed}ms`);
      forceClearToolchainDiscoveryRuntimeForTests();
    });

    it("proves ServerLifecycle.drain(timeoutMs) times out bounded by timeoutMs when background op never settles", async () => {
      const lifecycle = new ServerLifecycle();
      const neverSettlingOp = new Promise<void>(() => {});
      lifecycle.trackBackgroundOperation(neverSettlingOp);

      const t0 = Date.now();
      await assert.rejects(
        async () => {
          await lifecycle.drain(50);
        },
        /Timed out waiting for 1 active background operation\(s\) to finish within 50ms drain budget/,
      );
      const elapsed = Date.now() - t0;
      assert.ok(elapsed < 300, `lifecycle.drain should timeout around 50ms, took ${elapsed}ms`);

      await assert.rejects(
        async () => {
          await lifecycle.drain(50);
        },
        /Timed out waiting for 1 active background operation\(s\) to finish within 50ms drain budget/,
      );
    });

    it("proves ServerLifecycle.drain() is idempotent and memoized across concurrent and sequential callers", async () => {
      const lifecycle = new ServerLifecycle();
      let rejectOp!: (err: unknown) => void;
      const failingOp = new Promise<void>((_, reject) => {
        rejectOp = reject;
      });
      lifecycle.trackBackgroundOperation(failingOp);

      const d1 = lifecycle.drain(200);
      const d2 = lifecycle.drain(200);
      assert.equal(d1, d2, "Concurrent drain calls must return identical promise reference");

      rejectOp(new Error("MEMOIZED_DRAIN_ERROR"));

      await assert.rejects(async () => await d1, /MEMOIZED_DRAIN_ERROR/);
      await assert.rejects(async () => await d2, /MEMOIZED_DRAIN_ERROR/);

      const d3 = lifecycle.drain(200);
      assert.equal(d3, d1, "Sequential drain call after settlement must return identical memoized promise");
      await assert.rejects(async () => await d3, /MEMOIZED_DRAIN_ERROR/);
    });

    it("proves test-environment cleanup compositional execution when discovery drain fails", async () => {
      const failingEnv = createIsolatedTestEnvironment();
      const dummyDir = failingEnv.rootDir;
      assert.ok(fs.existsSync(dummyDir));

      // Register a hanging discovery child to force drainToolchainDiscovery to fail
      const hangingChild = new EventEmitter() as unknown as ChildProcess;
      Object.assign(hangingChild, {
        exitCode: null,
        signalCode: null,
        pid: 777777,
        kill: () => true,
      });
      registerDiscoveryChildForTests(hangingChild);

      try {
        await assert.rejects(
          async () => {
            await failingEnv.cleanup();
          },
          /Retained owned test root directory due to failed process\/background quiescence/,
        );

        // Root directory MUST be retained while quiescence is unconfirmed
        assert.ok(fs.existsSync(dummyDir), "Root directory must be retained when discovery drain fails");
      } finally {
        (hangingChild as { exitCode: number | null }).exitCode = 0;
        hangingChild.emit("exit", 0);
        assert.equal(getActiveDiscoveryChildrenCountForTests(), 0);
        await failingEnv.cleanup();
        assert.ok(!fs.existsSync(dummyDir), "Root directory must be cleaned up once quiescence succeeds");
      }
    });

    it("proves scripts/run-all-tests AppData validation rejects host paths and accepts isolated test roots", () => {
      const hostLocalAppData = process.env.LOCALAPPDATA ? path.resolve(process.env.LOCALAPPDATA) : "";
      const hostThemis = hostLocalAppData ? path.join(hostLocalAppData, "ThemisV2") : "";
      if (hostThemis) {
        assert.equal(isSafeTestAppDataDir(hostThemis), false, "Host ThemisV2 must be rejected as unsafe");
        assert.equal(isSafeTestAppDataDir(path.join(hostThemis, "sub")), false, "Subpath of host ThemisV2 must be rejected");
        assert.equal(
          isSafeTestAppDataDir(path.join(hostThemis, "jd_test")),
          false,
          "Host ThemisV2 subfolder with jd_test prefix must still be rejected as unsafe",
        );
      }
      assert.equal(isSafeTestAppDataDir(os.homedir()), false, "Home directory must be rejected as unsafe");
      assert.equal(isSafeTestAppDataDir("C:\\arbitrary\\path\\without\\marker"), false, "Path without test marker must be rejected");

      // Verify specific documents and contest paths are rejected
      const home = os.homedir();
      assert.equal(isSafeTestAppDataDir(path.join(home, "Documents", "test")), false, "Documents/test must be rejected");
      assert.equal(isSafeTestAppDataDir(path.join(home, "Documents", "contest")), false, "Documents/contest must be rejected");

      const safeDir = fs.mkdtempSync(path.join(os.tmpdir(), "jd_test_custom_safe_dir_"));
      try {
        assert.equal(
          isSafeTestAppDataDir(safeDir),
          false,
          "A name prefix alone must not authorize an unmarked test root",
        );
        fs.writeFileSync(path.join(safeDir, ".judgedesk-test-root"), "judgedesk-test-owned\n", "utf8");
        assert.equal(
          isSafeTestAppDataDir(safeDir),
          true,
          "An explicitly marked root inside the OS temp directory must be accepted",
        );
      } finally {
        fs.rmSync(safeDir, { recursive: true, force: true });
        assert.equal(fs.existsSync(safeDir), false);
      }

      if (process.platform === "win32") {
        const testJunctionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jd_junction_test_"));
        const junctionLink = path.join(testJunctionRoot, "junction_escape");
        try {
          const targetDir = hostThemis || os.tmpdir();
          fs.symlinkSync(targetDir, junctionLink, "junction");
          const escapePath = path.join(junctionLink, "missing", "jd_test_escape");
          assert.equal(
            isSafeTestAppDataDir(escapePath),
            false,
            "Non-existent descendant beneath a junction ancestor must be rejected",
          );
        } finally {
          if (fs.existsSync(junctionLink)) fs.unlinkSync(junctionLink);
          fs.rmSync(testJunctionRoot, { recursive: true, force: true });
          assert.equal(fs.existsSync(testJunctionRoot), false);
        }
      }

      if (hostThemis) {
        assert.throws(
          () => resolveTestAppDataDir({ THEMIS_APP_DATA_DIR: hostThemis }),
          /Unsafe THEMIS_APP_DATA_DIR detected/,
        );
      }

      const resolved = resolveTestAppDataDir({});
      assert.ok(resolved.owned);
      assert.ok(resolved.dir.includes("jd_test_server_appdata_"));
      assert.ok(fs.existsSync(resolved.dir));
      fs.rmSync(resolved.dir, { recursive: true, force: true });
    });

    it("proves judge prewarm distinguishes graceful deferral from unexpected failure and propagates failure to lifecycle drain", async () => {
      // 1. Deferral test: when toolchain/discovery is not ready, startBackgroundJudgePrewarm returns status "deferred" without rejecting
      const outcome = await startBackgroundJudgePrewarm(true);
      assert.ok(
        outcome.status === "deferred" || outcome.status === "completed",
        `Expected deferred or completed, got ${outcome.status}`,
      );

      // 2. Failure injection test: inject a deterministic failure through real executeJudgePrewarm dependency
      // and verify that ensureJudgePrewarmReady, startBackgroundJudgePrewarm, and lifecycle drain propagate the exact rejection
      const sentinelError = new Error("SENTINEL_UNEXPECTED_PREWARM_FAILURE");
      resetJudgePrewarmStateForTests();

      try {
        const prewarmTask = startBackgroundJudgePrewarm(true, {
          waitForToolchainDiscovery: async () => {
            throw sentinelError;
          },
        });
        prewarmTask.catch(() => {}); // prevent unhandled rejection warning in Node

        const lifecycle = new ServerLifecycle();
        lifecycle.trackBackgroundOperation(prewarmTask);

        // ensureJudgePrewarmReady must reject with the exact injected error
        await assert.rejects(
          async () => await ensureJudgePrewarmReady(),
          (err: unknown) => {
            assert.equal(err, sentinelError);
            return true;
          },
        );

        // lifecycle.drain must reject with the injected error (wrapped in AggregateError by ServerLifecycle)
        await assert.rejects(
          async () => await lifecycle.drain(200),
          (err: unknown) => {
            if (err instanceof AggregateError) {
              assert.equal(err.errors[0], sentinelError);
              return true;
            }
            assert.equal(err, sentinelError);
            return true;
          },
        );
      } finally {
        resetJudgePrewarmStateForTests();
      }
    });

    it("proves scripts/run-all-tests evaluateChildResult enforces fail-closed signal, status, and cleanup checks", () => {
      // Normal success
      assert.equal(evaluateChildResult({ error: undefined, signal: null, status: 0 }, null), 0);

      // Abnormal termination by signal
      assert.equal(evaluateChildResult({ error: undefined, signal: "SIGKILL", status: 0 }, null), 1);

      // Child terminated with null status (e.g. killed by OS without status code)
      assert.equal(evaluateChildResult({ error: undefined, signal: null, status: null }, null), 1);

      // Non-zero exit code
      assert.equal(evaluateChildResult({ error: undefined, signal: null, status: 42 }, null), 42);

      // Cleanup failure overrides child status 0
      assert.equal(
        evaluateChildResult({ error: undefined, signal: null, status: 0 }, new Error("directory lock")),
        1,
      );
    });

    it("proves staged production executor binary excludes JUDGEDESK_EXECUTOR_TEST_ROOT override logic (R8-F1)", () => {
      const nativeWindowsSource = fs.readFileSync(
        path.join(repoRoot, "native-executor", "src", "platform", "windows.rs"),
        "utf8",
      );
      assert.equal(
        nativeWindowsSource.includes('std::env::var_os("JUDGEDESK_EXECUTOR_TEST_ROOT")'),
        false,
        "Native test initialization must create an owned root by construction instead of accepting a caller-selected filesystem root",
      );

      const stagedBinary = path.join(
        repoRoot,
        "src-tauri",
        "binaries",
        process.platform === "win32"
          ? "judgedesk-executor-x86_64-pc-windows-msvc.exe"
          : process.arch === "arm64"
            ? "judgedesk-executor-aarch64-apple-darwin"
            : "judgedesk-executor-x86_64-apple-darwin",
      );
      if (!fs.existsSync(stagedBinary)) {
        return;
      }
      const buf = fs.readFileSync(stagedBinary);
      assert.equal(
        buf.includes(Buffer.from("JUDGEDESK_EXECUTOR_TEST_ROOT")),
        false,
        "Staged production native executor binary must NOT contain JUDGEDESK_EXECUTOR_TEST_ROOT string or override logic",
      );
    });
  });
});
