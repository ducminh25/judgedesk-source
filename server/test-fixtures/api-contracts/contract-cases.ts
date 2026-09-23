import fs from "node:fs";
import path from "node:path";
import { encodeScoreExportPayload, SCORE_EXPORT_CONTENT_TYPE } from "../../../shared/score-export-wire.js";

export interface ContractCaseContext {
  tempDir: string;
  problemDir: string;
  contestantDir: string;
  exportPayload: Uint8Array;
}

export interface ContractCase {
  id: string;
  name: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: (ctx: ContractCaseContext) => string;
  headers?: (ctx: ContractCaseContext) => Record<string, string>;
  body?: (ctx: ContractCaseContext) => string | Uint8Array | null;
  expectedStatus: number;
  fixtureFile: string;
  streaming?: "none" | "ndjson" | "sse";
  knownRustGap?: string;
  before?: (ctx: ContractCaseContext) => void;
}

export function createContractContext(baseTempDir: string): ContractCaseContext {
  const root = path.join(baseTempDir, `contract_ctx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const contestantDir = path.join(root, "contestants");
  const problemDir = path.join(root, "problems", "aplusb");
  const test1Dir = path.join(problemDir, "1");
  const test2Dir = path.join(problemDir, "2");

  fs.mkdirSync(contestantDir, { recursive: true });
  fs.mkdirSync(test1Dir, { recursive: true });
  fs.mkdirSync(test2Dir, { recursive: true });

  fs.writeFileSync(path.join(contestantDir, "contestant1.cpp"), "int main() { return 0; }", "utf8");
  fs.writeFileSync(path.join(test1Dir, "aplusb.inp"), "1 2\n", "utf8");
  fs.writeFileSync(path.join(test1Dir, "aplusb.out"), "3\n", "utf8");
  fs.writeFileSync(path.join(test2Dir, "aplusb.inp"), "10 20\n", "utf8");
  fs.writeFileSync(path.join(test2Dir, "aplusb.out"), "30\n", "utf8");

  const sampleWorkbook = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]);
  const sampleDiagnostics = JSON.stringify({ version: "1.5.0", timestamp: "2026-09-20T10:00:00Z" });
  const exportPayload = encodeScoreExportPayload(sampleWorkbook, sampleDiagnostics);

  return {
    tempDir: root,
    problemDir,
    contestantDir,
    exportPayload,
  };
}

export function cleanContractContext(
  ctx: ContractCaseContext,
  removeFn: (targetPath: string, options?: fs.RmOptions) => void = fs.rmSync,
): void {
  if (fs.existsSync(ctx.tempDir)) {
    try {
      removeFn(ctx.tempDir, { recursive: true, force: true });
    } catch (err) {
      throw new Error(
        `[cleanContractContext] Fail-closed: removal failed for ${ctx.tempDir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (fs.existsSync(ctx.tempDir)) {
      throw new Error(
        `[cleanContractContext] Fail-closed: unable to remove contract context directory: ${ctx.tempDir}`,
      );
    }
  }
}

export const CANONICAL_CONTRACT_CASES: ContractCase[] = [
  {
    id: "get-status",
    name: "System Status",
    method: "GET",
    path: () => "/api/status",
    expectedStatus: 200,
    fixtureFile: "get-status.json",
  },
  {
    id: "get-distribution",
    name: "Distribution Information",
    method: "GET",
    path: () => "/api/distribution",
    expectedStatus: 200,
    fixtureFile: "get-distribution.json",
  },
  {
    id: "get-toolchains",
    name: "Toolchains Inventory",
    method: "GET",
    path: () => "/api/toolchains",
    expectedStatus: 200,
    fixtureFile: "get-toolchains.json",
  },
  {
    id: "post-toolchains-rescan",
    name: "Toolchain Rescan",
    method: "POST",
    path: () => "/api/toolchains/rescan",
    expectedStatus: 202,
    fixtureFile: "post-toolchains-rescan.json",
    knownRustGap: "Rust does not implement /api/toolchains/rescan (Phase 2)",
  },
  {
    id: "put-toolchains-execution-policy",
    name: "Update Execution Policy",
    method: "PUT",
    path: () => "/api/toolchains/execution-policy",
    headers: () => ({ "Content-Type": "application/json" }),
    body: () => JSON.stringify({ allowResourceOnlyLocalExecution: false }),
    expectedStatus: 200,
    fixtureFile: "put-toolchains-execution-policy.json",
    knownRustGap: "Rust does not persist execution-policy updates (Phase 2)",
  },
  {
    id: "post-toolchains-prewarm",
    name: "Toolchains Prewarm",
    method: "POST",
    path: () => "/api/toolchains/prewarm",
    expectedStatus: 200,
    fixtureFile: "post-toolchains-prewarm.json",
    knownRustGap: "Rust does not implement background prewarm route (Phase 7)",
  },
  {
    id: "put-toolchain-preference",
    name: "Toolchain Preference Update",
    method: "PUT",
    path: () => "/api/toolchains/profiles/cpp-legacy-v1/preference",
    headers: () => ({ "Content-Type": "application/json" }),
    body: () => JSON.stringify({ mode: "managed" }),
    expectedStatus: 200,
    fixtureFile: "put-toolchain-preference.json",
    knownRustGap: "Rust profile preference route not decomposed (Phase 2)",
  },
  {
    id: "post-toolchain-certification-plan",
    name: "Toolchain Certification Plan",
    method: "POST",
    path: () => "/api/toolchains/profiles/cpp-legacy-v1/certification-plan",
    expectedStatus: 422,
    fixtureFile: "post-toolchain-certification-plan.json",
    knownRustGap: "Rust compiler service certification plan not implemented (Phase 3)",
  },
  {
    id: "post-toolchain-certify",
    name: "Toolchain Certify",
    method: "POST",
    path: () => "/api/toolchains/profiles/cpp-legacy-v1/certify",
    expectedStatus: 422,
    fixtureFile: "post-toolchain-certify.json",
    knownRustGap: "Rust toolchain certify route not implemented (Phase 3)",
  },
  {
    id: "post-toolchain-diagnose",
    name: "Toolchain Diagnose Profile",
    method: "POST",
    path: () => "/api/toolchains/profiles/cpp-legacy-v1/diagnose",
    expectedStatus: 200,
    fixtureFile: "post-toolchain-diagnose.json",
    knownRustGap: "Rust toolchain diagnose profile route not implemented (Phase 3)",
  },
  {
    id: "post-toolchain-custom-path",
    name: "Toolchain Set Custom Path",
    method: "POST",
    path: () => "/api/toolchains/custom-path",
    headers: () => ({ "Content-Type": "application/json" }),
    body: (ctx) => JSON.stringify({ kind: "cpp", path: ctx.tempDir }),
    expectedStatus: 200,
    fixtureFile: "post-toolchain-custom-path.json",
    knownRustGap: "Rust custom-path preference update not fully decoupled (Phase 2)",
  },
  {
    id: "post-toolchain-cancel",
    name: "Toolchain Cancel Install",
    method: "POST",
    path: () => "/api/toolchains/gcc-windows-x64/cancel",
    expectedStatus: 200,
    fixtureFile: "post-toolchain-cancel.json",
    knownRustGap: "Rust install cancellation not implemented (Phase 2)",
  },
  {
    id: "post-toolchain-install",
    name: "Toolchain Install",
    method: "POST",
    path: () => "/api/toolchains/fpc-windows-x64/install",
    expectedStatus: 202,
    fixtureFile: "post-toolchain-install.json",
    knownRustGap: "Rust does not implement toolchain download/install (Phase 2)",
  },
  {
    id: "post-select-directory-canceled",
    name: "Directory Picker Canceled",
    method: "POST",
    path: () => "/api/select-directory",
    headers: () => ({
      "Content-Type": "application/json",
    }),
    body: () => JSON.stringify({ defaultPath: "" }),
    expectedStatus: 200,
    fixtureFile: "post-select-directory-canceled.json",
    knownRustGap: "Rust does not implement select-directory route yet (Phase 1)",
    before: () => {
      const mock = process.env.JUDGEDESK_TEST_SELECT_FILE || process.env.JUDGEDESK_TEST_SELECT_DIRECTORY;
      if (mock && fs.existsSync(path.dirname(mock))) {
        fs.writeFileSync(mock, "__CANCEL__", "utf8");
      }
    },
  },
  {
    id: "post-select-directory-success",
    name: "Directory Picker Success",
    method: "POST",
    path: () => "/api/select-directory",
    headers: () => ({
      "Content-Type": "application/json",
    }),
    body: () => JSON.stringify({ defaultPath: "" }),
    expectedStatus: 200,
    fixtureFile: "post-select-directory-success.json",
    knownRustGap: "Rust does not implement select-directory route yet (Phase 1)",
    before: (ctx) => {
      const mock = process.env.JUDGEDESK_TEST_SELECT_FILE || process.env.JUDGEDESK_TEST_SELECT_DIRECTORY;
      if (mock && fs.existsSync(path.dirname(mock))) {
        fs.writeFileSync(mock, ctx.tempDir, "utf8");
      }
    },
  },
  {
    id: "get-fetch-contestants",
    name: "Fetch Contestants",
    method: "GET",
    path: (ctx) => `/api/fetch-contestants?path=${encodeURIComponent(ctx.contestantDir)}`,
    expectedStatus: 200,
    fixtureFile: "get-fetch-contestants.json",
    knownRustGap: "Rust fetch-contestants not exposed on standalone server (Phase 6)",
  },
  {
    id: "get-fetch-problems",
    name: "Fetch Problems",
    method: "GET",
    path: (ctx) => `/api/fetch-problems?path=${encodeURIComponent(path.dirname(ctx.problemDir))}`,
    expectedStatus: 200,
    fixtureFile: "get-fetch-problems.json",
    knownRustGap: "Rust fetch-problems not exposed on standalone server (Phase 6)",
  },
  {
    id: "get-fetch-tests",
    name: "Fetch Problem Tests",
    method: "GET",
    path: (ctx) => `/api/fetch-tests?path=${encodeURIComponent(ctx.problemDir)}`,
    expectedStatus: 200,
    fixtureFile: "get-fetch-tests.json",
    knownRustGap: "Rust fetch-tests returns empty list or incomplete pair validation (Phase 6)",
  },
  {
    id: "get-fetch-polygon-tests",
    name: "Fetch Polygon Tests",
    method: "GET",
    path: (ctx) => `/api/fetch-polygon-tests?path=${encodeURIComponent(ctx.problemDir)}&problem=aplusb`,
    expectedStatus: 200,
    fixtureFile: "get-fetch-polygon-tests.json",
    knownRustGap: "Rust fetch-polygon-tests previews not implemented (Phase 6)",
  },
  {
    id: "post-polygon-config",
    name: "Save Polygon Config",
    method: "POST",
    path: () => "/api/polygon-config",
    headers: () => ({ "Content-Type": "application/json" }),
    body: (ctx) =>
      JSON.stringify({
        path: ctx.problemDir,
        config: {
          enableGroups: false,
          tests: {},
          groups: {},
        },
      }),
    expectedStatus: 200,
    fixtureFile: "post-polygon-config.json",
  },
  {
    id: "get-polygon-config",
    name: "Get Polygon Config",
    method: "GET",
    path: (ctx) => `/api/polygon-config?path=${encodeURIComponent(ctx.problemDir)}`,
    expectedStatus: 200,
    fixtureFile: "get-polygon-config.json",
  },
  {
    id: "post-open-excel",
    name: "Open Scoreboard Excel Export",
    method: "POST",
    path: () => "/api/open-excel",
    headers: () => ({
      "Content-Type": SCORE_EXPORT_CONTENT_TYPE,
    }),
    body: (ctx) => ctx.exportPayload,
    expectedStatus: 200,
    fixtureFile: "post-open-excel.json",
    knownRustGap: "Rust score export parser lacks Excel spawn suppression and diagnostic verification (Phase 6)",
  },
  {
    id: "post-batch-judge",
    name: "Batch Judge Execution Stream",
    method: "POST",
    path: () => "/api/batch-judge",
    headers: () => ({ "Content-Type": "application/json" }),
    body: (ctx) =>
      JSON.stringify({
        thisinhPath: ctx.contestantDir,
        testPath: path.dirname(ctx.problemDir),
        jobId: "contract_canonical_batch_judge_job",
      }),
    expectedStatus: 200,
    streaming: "ndjson",
    fixtureFile: "post-batch-judge-stream.json",
    knownRustGap: "Rust drops problemConfigs and emits metadata before progress (Phase 4)",
  },
  {
    id: "post-batch-judge-cancel",
    name: "Cancel Batch Judge Job",
    method: "POST",
    path: () => "/api/batch-judge/cancel",
    headers: () => ({ "Content-Type": "application/json" }),
    body: () => JSON.stringify({ jobId: "job_pre_cancel_test" }),
    expectedStatus: 200,
    fixtureFile: "post-batch-judge-cancel.json",
    knownRustGap: "Rust cancel ignores jobId and lacks pending pre-admission registration (Phase 4)",
  },
  {
    id: "get-osd-status",
    name: "OSD Status",
    method: "GET",
    path: () => "/api/osd/status",
    expectedStatus: 200,
    fixtureFile: "get-osd-status.json",
  },
  {
    id: "post-osd-start",
    name: "OSD Start Watching",
    method: "POST",
    path: () => "/api/osd/start",
    headers: () => ({ "Content-Type": "application/json" }),
    body: (ctx) =>
      JSON.stringify({
        osdPath: ctx.tempDir,
        contestantsPath: ctx.contestantDir,
        testPath: path.dirname(ctx.problemDir),
        enableLog: false,
      }),
    expectedStatus: 200,
    fixtureFile: "post-osd-start.json",
    knownRustGap: "Rust OSD watcher not integrated (Phase 6)",
  },
  {
    id: "post-osd-stop",
    name: "OSD Stop Watching",
    method: "POST",
    path: () => "/api/osd/stop",
    expectedStatus: 200,
    fixtureFile: "post-osd-stop.json",
    knownRustGap: "Rust OSD stop watcher not integrated (Phase 6)",
  },
  {
    id: "get-osd-events",
    name: "OSD Event Stream",
    method: "GET",
    path: () => "/api/osd/events",
    expectedStatus: 200,
    streaming: "sse",
    fixtureFile: "get-osd-events.json",
    knownRustGap: "Rust OSD SSE event stream not fully integrated (Phase 6)",
  },
  {
    id: "delete-toolchain",
    name: "Toolchain Uninstall",
    method: "DELETE",
    path: () => "/api/toolchains/fpc-windows-x64",
    expectedStatus: 200,
    fixtureFile: "delete-toolchain.json",
    knownRustGap: "Rust uninstall route not implemented (Phase 2)",
  },
  {
    id: "post-shutdown",
    name: "Server Shutdown Initiation",
    method: "POST",
    path: () => "/api/shutdown",
    expectedStatus: 200,
    fixtureFile: "post-shutdown.json",
    knownRustGap: "Rust shutdown lacks graceful active session drain check (Phase 1)",
  },
];
