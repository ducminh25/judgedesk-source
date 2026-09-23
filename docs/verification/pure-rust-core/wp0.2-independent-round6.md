# WP0.2 Independent Verification — Round 6

- **Reviewer:** Codex (independent fresh-context review)
- **Timestamp:** 2026-09-20T23:18:54+07:00
- **Workspace:** `D:\Minh\Code\judgedesk`
- **Source:** HEAD `d80f997cdafaf85883e7602de26c32dd355795a1` plus the preserved dirty tree
- **Scope:** WP0.2 only; no WP0.3 implementation and no version bump
- **Verdict:** **IN_PROGRESS**

## 1. Verdict

Round 6 is not ready for `DONE`. The production/test override boundary and current-turn host AppData isolation are materially improved, and the ordinary gates are green. Independent source review and direct probes nevertheless found lifecycle admission races, root deletion after failed quiescence, discovery work that is not lifecycle-owned, incorrect child-exit accounting, non-idempotent concurrent drain reporting, an unsafe externally supplied test root policy, and Rust test teardown that deletes its root before the server has stopped. The latest provenance/report artifact also does not describe the current discovery-v2 bytes.

WP0.2 returns to `IN_PROGRESS`. WP0.3 remains `NOT_READY`.

## 2. Findings

### F1 — Critical — Work starts or persists before lifecycle admission

- **Evidence:** `server/routes/toolchain-routes.ts:195-198`, `:331-332`, `:527-529`, and `:655-659` start rescan, prewarm, install, or persist a preference before `onBackgroundOperation(...)` can reject admission. `server/api-contracts.test.ts:1156-1188` asserts only HTTP 503 and not absence of side effects.
- **Impact:** a shutdown-time request can receive 503 after an install/rescan/prewarm has already started or preference state has changed. That work is not owned by `ServerLifecycle`.
- **Reproduction:** begin drain, register the production toolchain routes with that lifecycle, and invoke rescan/prewarm/preference. The existing focused test returns 503 while the eager Promise/mutation occurs first.
- **Acceptance condition:** perform lifecycle admission synchronously before invoking a work factory or persistence mutation. Assert the factory was never called, install never started, and preference revision/file did not change when admission is closed.

### F2 — Critical — Cleanup deletes the root after discovery quiescence failed

- **Evidence:** `server/test-fixtures/api-contracts/test-environment.ts:358-363` records a discovery-drain failure, but `:376-405` resets tracking and recursively deletes the root. `server/api-contracts.test.ts:1247-1275` explicitly requires deletion before its fake child emits `exit`.
- **Impact:** a live child can access an already-deleted root, recreating post-teardown ENOENT/write-after-cleanup.
- **Reproduction:** `npx tsx --test server/api-contracts.test.ts`; the passing test `proves test-environment cleanup compositional execution when discovery drain fails` codifies the unsafe order at line 1271.
- **Acceptance condition:** restore global state compositionally, but retain and report the owned root whenever process/background quiescence fails. Delete it only after observed termination.

### F3 — High — A child `error` event is treated as process exit

- **Evidence:** `server/toolchains/discovery.ts:1399-1400` resolves drain on `exit` or `error`; `:1438-1441` removes a child from tracking on `error`.
- **Impact:** drain can report success while the process still has null exit/signal codes.
- **Reproduction:** the direct EventEmitter probe printed `{"before":1,"after":0,"exitCode":null,"signalCode":null}` after emitting only `error`.
- **Acceptance condition:** preserve the error, retain the child until an observed terminal exit/close state, and reject on the deadline if no exit is observed.

### F4 — High — Compatibility probes are fire-and-forget outside lifecycle ownership

- **Evidence:** `server/toolchains/discovery.ts:676` schedules a compatibility probe; `:696-705` fire-and-forgets a dynamic import and its returned Promise.
- **Impact:** rescan/drain can complete while native-executor compatibility work, cache writes, or child processes remain active.
- **Reproduction:** delay a compatibility probe for a valid C/C++/Python candidate, await rescan and discovery drain, and observe that the absent tracking permits it to continue.
- **Acceptance condition:** admit and track compatibility work in the lifecycle/discovery owner, propagate failures, and prove drain awaits or cancels it before deletion.

### F5 — High — Rust test deletes its root before server shutdown completion

- **Evidence:** the handler defers shutdown by 50 ms at `crates/judgedesk-core/src/server/mod.rs:544-549`. The test receives HTTP 200, removes `test_root`, and only then aborts an unawaited task at `crates/judgedesk-core/tests/server_test.rs:403-410`. Its `:394-401` assertions do not check absence of external `export_*`, despite the report's claim.
- **Impact:** the test can pass while the server remains alive and may access the deleted root or retain its port.
- **Reproduction:** assert `server_task.is_finished()` immediately before line 408; the handler contract allows it to remain false.
- **Acceptance condition:** await graceful termination and port release, then delete the root; await any abort fallback. Add the claimed external-root assertion.

### F6 — High — `run-all-tests` accepts arbitrary user paths by substring

- **Evidence:** `scripts/run-all-tests.js:54-76` accepts any basename containing `test`; `:79-86` trusts it as a non-owned root. There is no ownership marker, canonical temp containment, junction resolution, or case-insensitive Windows comparison.
- **Impact:** aggregate tests can mutate a user directory or a case-variant/junction into real AppData.
- **Reproduction:** the direct probe returned `safe:true` for `C:\Users\mon\Documents\test`, `C:\Users\mon\Documents\contest`, and `C:\Users\mon\AppData\Local\THEMISV2\jd_test`.
- **Acceptance condition:** prefer always-owned `mkdtemp`; otherwise require canonical containment in an approved temp parent plus an ownership marker and reject reparse/case escapes.

### F7 — High — Concurrent drains disagree and production shutdown masks failure

- **Evidence:** `server/platform/server-lifecycle.ts:113-114` destructively consumes settled errors without memoizing one drain result. `server.ts:18-24` and `:114-116` force exit code 0 even when drain rejects.
- **Impact:** overlapping shutdown callers can see contradictory success/failure, and a failed teardown can still exit successfully.
- **Reproduction:** one settled rejected operation plus two concurrent `drain()` calls produced one `rejected` and one `fulfilled` result.
- **Acceptance condition:** memoize an idempotent drain Promise/result, make all callers observe the same failure, close/cancel owned resources consistently, and exit nonzero on failed production teardown.

### F8 — High — Background prewarm errors are converted into success

- **Evidence:** `server/judge/background-prewarm.ts:150-152` catches every error and fulfills. Node parity printed `Background pre-warm error: TOOLCHAIN_NOT_SANDBOX_COMPATIBLE` but reported 30/30 and zero background errors.
- **Impact:** verification can be green while a lifecycle-owned operation failed.
- **Reproduction:** `npx tsx scripts/check-contract-parity.ts --adapter=node`.
- **Acceptance condition:** distinguish intentional deferral from unexpected failure and reject/record the latter so adapter close/parity fails.

### F9 — Medium — Native Executor's default locked suite is nondeterministic

- **Evidence:** the first default locked run failed 50/51 in `test_scratch_execution` with `os error 183` creating the workspace cache. The focused test passed, and a serial rerun passed 54/54.
- **Impact:** a relevant required gate is flaky under its default invocation.
- **Reproduction:** `cargo test --locked --manifest-path native-executor/Cargo.toml`.
- **Acceptance condition:** isolate per-test cache ownership or serialize the canonical gate; repeated canonical runs must be deterministic.

### F10 — Medium — Discovery-v2 provenance/report evidence is stale

- **Evidence:** the provenance audit says current host SHA-256 `5314E7...BEC58`; the current file is `5C0AA6...6459F1`. The controlled artifact is `654958...397B32`, not byte-equal. They become semantically equal only after excluding timestamps and `pathRank`.
- **Impact:** the report does not establish whether the current bytes came from a trusted restore/canonical regeneration, although the file was stable during this review.
- **Reproduction:** hash the host file, audit JSON, and controlled artifact; compare parsed JSON with/without volatile fields.
- **Acceptance condition:** record exact current hashes, generation command/source state, explicit semantic-diff rules, and a truthful origin statement without fabricating lost WP0.1 bytes.

## 3. Remediation claims independently confirmed

- Production Node/Rust source no longer reads the old test override tokens; the only Rust read is in feature-gated `src/bin/test_server.rs`.
- Building `test-server` without its non-default feature fails as intended.
- Focused contracts pass 40/40, with no delayed root/process/Excel after 8 seconds.
- Node parity is 30/30. Rust strict parity truthfully exits 1 at 9/30; report-only exits 0 with the same 21 gaps. WP0.2 action 4 requires incomplete Rust routes to fail, so strict is a signal, not a command pass.
- Rust core tests use an injected opener and did not open Excel.
- Host `ThemisV2` AppData was byte-stable before/after all mutation-capable checks.
- Inventory is deterministic across two runs; all eight version files remain at 1.5.0.

## 4. Verification matrix

| Command/probe | Isolated root | Expected | Actual | Exit | Result |
|---|---|---|---|---:|---|
| inventory run 1 | N/A | deterministic | 29/33/29/29 | 0 | PASS |
| inventory run 2 | N/A | byte-identical | same counts/hashes | 0 | PASS |
| Node parity + 8 s | owned `jd_contract_env_*` | 30/30, clean | 30/30; swallowed prewarm error; no residue | 0 | PARTIAL / F8 |
| focused contracts + 8 s | owned nested contract roots | all cases | 40/40; no residue | 0 | PASS counts; F1/F2 remain |
| Rust parity strict | owned `jd_contract_env_*` | nonzero on gaps | 9/30, 21 gaps | 1 | EXPECTED STRICT FAILURE |
| Rust `--report-only` + 8 s | owned root | report | 9/30; no residue | 0 | PASS workflow |
| locked Rust core + 8 s | Rust-owned temp | all | 38/38; no Excel/export residue | 0 | PASS |
| locked Native Executor, default | executor workspaces | deterministic pass | 50/51; cache collision | 101 | FAIL / F9 |
| focused Scratch; serial Native suite | executor workspaces | diagnose | 1/1; 54/54 | 0/0 | PASS reruns only |
| `npm run check:fast` | N/A | green | green | 0 | PASS |
| `npm run test:server` + 10 s | owned server/contract roots | green/clean | 572/0/10; no residue | 0 | PASS |
| `npm run check:full` + 10 s | same | full gate | 572/0/10 + version 1.5.0; no residue | 0 | PASS |
| `npm run release:check-version` | N/A | eight at 1.5.0 | 1.5.0 | 0 | PASS |
| unsafe-root probe | no writes | reject | three unsafe paths accepted | 0 | FAIL / F6 |
| child `error` probe | synthetic child | retain | count 1 -> 0 with null exit | 0 | FAIL / F3 |
| concurrent drain probe | in-memory | same result | rejected + fulfilled | 0 | FAIL / F7 |

## 5. Inventory counts and hashes

| Run | Manifest | Callers | Node | Rust | Inventory SHA-256 | Matrix SHA-256 |
|---|---:|---:|---:|---:|---|---|
| 1 | 29 | 33 | 29 | 29 | `F76EE7266FCBDE85CCD452127B888BAF247516BFE5EB72611CC85BC78508806C` | `96B7786278759568A3E88F5972169A1EE3291BFE920711C9CEDE8DE51E7EA026` |
| 2 | 29 | 33 | 29 | 29 | `F76EE7266FCBDE85CCD452127B888BAF247516BFE5EB72611CC85BC78508806C` | `96B7786278759568A3E88F5972169A1EE3291BFE920711C9CEDE8DE51E7EA026` |

## 6. Host AppData

- **Path:** `C:\Users\mon\AppData\Local\ThemisV2`.
- **Before/after:** 17,730 files + 826 directories = 18,556 entries; CSV SHA-256 `106B37FC00C43948EF4D51BBB519EE54F21E574BC8D25F315173651522A9690E` both times; semantic diff 0.
- **Discovery v2:** 5,539 bytes; SHA-256 `5C0AA69EA06E3C08D4529D6EFA8E584DF04310EF610B2C08AAB3418BEB6459F1` before and after.
- **Interpretation:** no current-review host mutation. The controlled artifact is semantically equivalent after excluding timestamps and environment-dependent `pathRank`, but F10 remains because the provenance record names different current bytes and does not prove their origin.

## 7. Cleanup audit

- Final `jd_contract_env_*`, `jd_test_server_appdata_*`, `%TEMP%\export_*`: 0.
- Relevant Node/server/Cargo/Rust/executor/Excel processes and listening ports: 0.
- No delayed output during 8–10 second observations.
- `check:full` logged one deferred executor workspace cleanup due to `EPERM`; the exact path no longer existed at final audit and its parent was empty.
- The review's own marked evidence root was removed after recording evidence.

## 8. Documents updated

- `STATUS.md`; `WORKLOG.md` (`LOG-0026`, append-only); `wp0.2-api-stream-contract.md`; this report.

## 9. WP0.3 state

`WP0.3 = NOT_READY`. No WP0.3 work was performed.

## 10. Not verified

- `test:desktop` / Computer Use: not run because WP0.2 remediation changes backend verification/lifecycle code, not WP0.2 UI/Tauri behavior. Excel non-spawn was observed around relevant gates.
- macOS SSH: not run because the blockers are platform-independent and cannot be cleared by a macOS result.
- Repository opt-in real-toolchain gates remained skipped and are outside WP0.2 contract-inventory exit criteria.
