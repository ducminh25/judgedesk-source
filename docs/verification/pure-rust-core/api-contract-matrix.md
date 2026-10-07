# JudgeDesk Pure Rust Core — Canonical API & Stream Contract Matrix

> **Authoritative Endpoint Contract Matrix for Pure Rust Core Migration**  
> **Plan Reference:** `WP0.2` in `docs/pure-rust-core-detailed-implementation-plan.md`  
> **Generated At:** 2026-09-19T23:37:00+07:00  
> **Total Contracted Endpoints:** 29  
> **Released Baseline:** `v1.5.0` | **Development Target:** `v1.6.0`  

---

## 1. Inventory Summary

- **Contracted Routes in Manifest:** 29
- **Frontend API Callers Discovered:** 34
- **Node Backend Routes Discovered:** 29
- **Rust Backend Routes Discovered:** 29

---

## 2. API Contract Matrix

| ID | Method | Path | Streaming | Status Codes | Frontend Consumer | Concurrency Gates | Persistence | Rust Parity Notes |
|---|---|---|---|---|---|---|---|---|
| `status-get` | **GET** | `/api/status` | `none` | `200` | `src/App.tsx` | — | — | ⚠️ Rust returns partial status without isolate and with hardcoded platform/toolchain fields. |
| `distribution-get` | **GET** | `/api/distribution` | `none` | `200` | `src/features/updates/useAppUpdater.ts` | — | — | ✅ Parity in design |
| `shutdown-post` | **POST** | `/api/shutdown` | `none` | `200, 503` | `src-tauri/src/backend.rs` | serverLifecycle.beginDrain(); cancelAllActiveJudgeJobs(); ACTIVE_JUDGE_DRAIN_TIMEOUT_MS | — | ⚠️ Rust immediately schedules shutdown signal without drain timeout or cancelling active judge sessions. |
| `select-directory-post` | **POST** | `/api/select-directory` | `none` | `200` | `src/platform/directory-picker.ts` | — | — | ⚠️ Rust server/mod.rs interpolates path directly into PowerShell without safe argument boundaries. |
| `fetch-contestants-get` | **GET** | `/api/fetch-contestants` | `none` | `200, 400, 404, 500` | `src/features/workspace/useContestWorkspace.ts` | — | — | ✅ Parity in design |
| `fetch-problems-get` | **GET** | `/api/fetch-problems` | `none` | `200, 400, 404, 500` | `src/features/workspace/useContestWorkspace.ts` | — | — | ✅ Parity in design |
| `fetch-tests-get` | **GET** | `/api/fetch-tests` | `none` | `200, 400, 404, 500` | *Backend/Tauri internal* | — | — | ✅ Parity in design |
| `fetch-polygon-tests-get` | **GET** | `/api/fetch-polygon-tests` | `none` | `200, 400, 404, 500` | `src/features/problem-config/useProblemConfigEditor.ts` | — | — | ⚠️ Rust byte slice on UTF-8 testcase inputs can panic at character boundaries without safe char boundary truncation. |
| `polygon-config-get` | **GET** | `/api/polygon-config` | `none` | `200, 400, 500` | `src/features/problem-config/useProblemConfigEditor.ts` | — | Reads Config.cfg or legacy config.json | ✅ Parity in design |
| `polygon-config-post` | **POST** | `/api/polygon-config` | `none` | `200, 400, 422, 500` | `src/features/problem-config/useProblemConfigEditor.ts` | — | Atomically replaces Config.cfg after validation; validateOnly does not write | ✅ Parity in design |
| `open-excel-post` | **POST** | `/api/open-excel` | `none` | `200, 400, 413, 500` | `src/features/export/useScoreboardExport.ts` | — | Extracts Book.xlsx and diagnostics.json to TEMP_ROOT/exports/<uuid>/ | ⚠️ Rust decodes payload without full score export bundle parity checks. |
| `toolchains-get` | **GET** | `/api/toolchains` | `none` | `200` | `src/App.tsx`, `src/features/toolchains/useToolchains.ts`, `src/features/toolchains/useThemisPromptModal.ts`, `src/features/toolchains/useScratchPromptModal.ts` | — | — | ⚠️ Rust returns in-memory mock toolchains and preferences without persistent revision tracking or recovery document status. |
| `toolchains-rescan-post` | **POST** | `/api/toolchains/rescan` | `none` | `202, 409` | `src/features/toolchains/useToolchains.ts` | toolchainMutationsBlocked() | — | ⚠️ Rust does not block rescan when judging session is active. |
| `toolchains-execution-policy-put` | **PUT** | `/api/toolchains/execution-policy` | `none` | `200, 400, 409, 500` | `src/features/toolchains/useThemisPromptModal.ts`, `src/features/toolchains/useToolchains.ts` | toolchainMutationsBlocked() | Saves execution-policy.json | ⚠️ Rust echoes body in memory without persisting execution policy. |
| `toolchains-prewarm-post` | **POST** | `/api/toolchains/prewarm` | `none` | `200` | `src/features/toolchains/ToolchainManager.tsx` | — | — | ✅ Parity in design |
| `toolchains-preference-put` | **PUT** | `/api/toolchains/profiles/:profileId/preference` | `none` | `200, 400, 404, 409, 422` | `src/features/toolchains/useThemisPromptModal.ts`, `src/features/toolchains/useScratchPromptModal.ts`, `src/features/toolchains/useToolchains.ts` | toolchainMutationsBlocked() | Updates toolchains-v2.json with atomic revision bump | ⚠️ Rust updates in-memory HashMap without atomic storage or revision check. |
| `toolchains-certification-plan-post` | **POST** | `/api/toolchains/profiles/:profileId/certification-plan` | `none` | `200, 404, 409, 422` | `src/features/toolchains/useToolchains.ts` | toolchainMutationsBlocked() | — | ⚠️ Rust returns static mock certification plan. |
| `toolchains-certify-post` | **POST** | `/api/toolchains/profiles/:profileId/certify` | `none` | `200, 404, 409, 422` | `src/features/toolchains/useToolchains.ts` | toolchainMutationsBlocked() | Stores certification record in AppData/certified-toolchains/ | ⚠️ Rust returns hardcoded certification result without compiling probes. |
| `toolchains-diagnose-post` | **POST** | `/api/toolchains/profiles/:profileId/diagnose` | `none` | `200, 404, 409, 500` | `src/features/toolchains/useToolchains.ts` | serverLifecycle.activeJudgeSessionCount > 0 | — | ⚠️ Rust runs diagnostics on local path with ResourceOnly for Pascal/Java/Scratch. |
| `toolchains-custom-path-post` | **POST** | `/api/toolchains/custom-path` | `none` | `200, 400, 409` | *Backend/Tauri internal* | toolchainMutationsBlocked() | Updates toolchain preferences (legacy schema-v1 compatibility) | ✅ Parity in design |
| `toolchains-install-post` | **POST** | `/api/toolchains/:id/install` | `none` | `202, 400, 404, 409, 503` | `src/features/toolchains/useToolchains.ts` | toolchainMutationsBlocked(); assertToolchainMutationAllowed | Extracts toolchain package to AppData/toolchains/<id>/ | ⚠️ Rust simulates install by inserting into in-memory set without downloading or extracting. |
| `toolchains-cancel-post` | **POST** | `/api/toolchains/:id/cancel` | `none` | `200` | `src/features/toolchains/useToolchains.ts` | — | — | ✅ Parity in design |
| `toolchains-uninstall-delete` | **DELETE** | `/api/toolchains/:id` | `none` | `200, 404, 409, 500` | `src/features/toolchains/useToolchains.ts` | toolchainMutationsBlocked() | Deletes toolchain directory and removes installed receipt | ⚠️ Rust removes from in-memory set without disk deletion or receipt checks. |
| `batch-judge-post` | **POST** | `/api/batch-judge` | `ndjson` | `200, 400` | `src/features/judging/useJudgeSession.ts` | SingleJudgeSessionGate (only 1 session); toolchainMaintenanceGate.tryAcquireJudge(); serverLifecycle.acceptsNewJudgeSessions; executorClient.health.ready | Creates temporary workspace in TEMP_ROOT, cleaned up in finally | ⚠️ Rust does not deserialize problemConfigs, lacks SingleJudgeSessionGate, emits metadata before progress, omits python in metadata.toolchains, does not set X-JudgeDesk-Job-Id. |
| `batch-judge-cancel-post` | **POST** | `/api/batch-judge/cancel` | `none` | `200, 500, 503` | `src/features/judging/useJudgeSession.ts` | JudgeJobRegistry.cancelJob(jobId) | — | ⚠️ Rust ignores jobId and mutates a single global AtomicBool cancel flag. |
| `osd-start-post` | **POST** | `/api/osd/start` | `none` | `200, 400` | `src/features/osd/useOsdSession.ts` | — | — | ⚠️ Rust returns static mock OSD status and does not start a real filesystem watcher or queue. |
| `osd-stop-post` | **POST** | `/api/osd/stop` | `none` | `200` | `src/features/osd/useOsdSession.ts` | — | — | ✅ Parity in design |
| `osd-status-get` | **GET** | `/api/osd/status` | `none` | `200` | *Backend/Tauri internal* | — | — | ✅ Parity in design |
| `osd-events-get` | **GET** | `/api/osd/events` | `sse` | `200` | `src/features/osd/useOsdSession.ts` | — | — | ⚠️ Rust returns infinite empty SSE stream without real OSD state push. |

---

## 3. Streaming and Event Contracts

### 3.1 `/api/batch-judge` (NDJSON Stream)
- **Framing:** Newline-delimited JSON (`application/x-ndjson`), line terminated by `\n`.
- **Header requirement:** `X-JudgeDesk-Job-Id: <job-id>` must be returned in the response headers.
- **Event Order Contract:**
  1. `progress` with `{ contestant: "", problem: "", action: "progress.initializing", percent: 0 }`
  2. `metadata` with `RunMetadata` containing `build`, `executor`, and `toolchains` (`cpp` AND `python`)
  3. Zero or more test execution `progress` events
  4. Per-problem `problem_completed` events with `{ contestant, problemResult }`
  5. Terminating event: `done` (`{ success: true }`) on success, or `error` (`{ message: string }`) on failure.

### 3.2 `/api/osd/events` (Server-Sent Events)
- **Framing:** W3C Server-Sent Events (`text/event-stream`), `Cache-Control: no-cache`, `Connection: keep-alive`.
- **Payload:** `data: <JSON>\n\n` with heartbeat comments `:\n\n`.

---

## 4. Known Discrepancies and Authority Resolutions

| Conflict Area | Legacy Documentation / Migration Plan | Shipped Node Backend & Frontend Code | Canonical Resolution (WP0.2 Contract) |
|---|---|---|---|
| Judging Endpoint Path | Some prose cites `/api/judge/session` | `/api/batch-judge` called by `src/features/judging/useJudgeSession.ts` | **`/api/batch-judge`** is authoritative. |
| Judging Stream Protocol | Some prose refers to SSE `EventSource` | `apiFetch` + `ReadableStream` line parser consuming NDJSON | **Newline-delimited JSON (`application/x-ndjson`)** is authoritative. |
| Batch Judge Events | Prose cites `job_start`, `test_progress`, `job_complete` | Code consumes `metadata`, `progress`, `problem_completed`, `done`, `error` | Shipped event names `metadata`, `progress`, `problem_completed`, `done`, `error` are authoritative. |
| Exporter Metadata Dependency | Exporter assumed toolchains is optional | `src/features/export/score-workbook.ts` reads `metadata.toolchains.python` directly | Rust must emit `toolchains.python` in `metadata` event. |
| Job Registry & Cancellation | Prose omits pre-admission cancellation | `JudgeJobRegistry` records pending cancellations and attaches/detaches runs | Job ID and registration boundary are mandatory. |
| Folder Selection Shell | Native dialog | Node uses `selectDirectory`, Rust used unsanitized PowerShell string | Safe, bounded folder selection is mandatory. |
| Score Export Wire Protocol | Legacy text cited `score-export-bundle` / 25MB | `shared/score-export-wire.ts` defines `score-export-v1` / 256 MiB limit | Shipped MIME `application/vnd.judgedesk.score-export-v1` and 256 MiB limit are authoritative. |
