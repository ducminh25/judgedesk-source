# WP0.2 Independent Verification — Round 7

- **Reviewer:** Codex (independent review with fresh-context adversarial audit)
- **Timestamp:** 2026-09-21T00:12:21+07:00
- **Workspace:** `D:\Minh\Code\judgedesk`
- **Source:** HEAD `d80f997cdafaf85883e7602de26c32dd355795a1` plus the preserved dirty tree
- **Scope:** WP0.2 only; no WP0.3 implementation and no version bump
- **Verdict:** **IN_PROGRESS**

## 1. Verdict

Round 7 is not ready for `DONE`. Inventory, Node parity, focused contracts, Rust tests, the full server suite, version lockstep, and the `ThemisV2` before/after snapshot are green. Direct production-path probes and source review nevertheless disprove several remediation claims: mutating routes still start work or write state before/without lifecycle admission; compatibility failures can disappear before drain; drain deadlines do not bound background work; production discovery launchers still remove children on `error`; a nonexistent descendant below a junction is accepted as a safe test root; and the reported default Native Executor test command writes to real host executor AppData. The Rust shutdown test and the Native cache race fix also remain fail-open.

WP0.2 returns to `IN_PROGRESS`. WP0.3 remains `NOT_READY`. Every blocker is actionable inside the repository; `BLOCKED` is not appropriate.

## 2. Findings

### F1 — Critical — Toolchain work and mutations still occur before or without lifecycle admission

- **Evidence:** install reads preferences and awaits the remote manifest at `server/routes/toolchain-routes.ts:461-475`, but checks `lifecycle.assertAdmissible()` only at `:537`. Local-path preference clears caches and verifies an executable at `:641-646` before admission at `:656`. Execution policy (`:303-324`), certification (`:350-402`), uninstall (`:569-585`), and legacy custom-path persistence (`:694-754`) have no local lifecycle admission.
- **Impact:** shutdown-time requests can perform network I/O, cache mutation, filesystem writes, certification, or deletion after admission has closed. Such work is not guaranteed to be tracked or drained.
- **Reproduction:** with a drained lifecycle, the install probe made one request to a sentinel manifest server before returning 503: `{"status":503,"requests":1}`. A local-path preference returned 422 after verification instead of immediate 503. Execution-policy mutation returned 200 and created `toolchain-execution-policy-v1.json`.
- **Acceptance condition:** admit synchronously before every side effect or asynchronous factory on every mutating/diagnostic route, then track the created operation atomically. Add branch-specific tests proving zero invocation, zero network requests, zero cache changes, and zero file/revision changes when closing.

### F2 — Critical — Default Native Executor tests mutate real host executor AppData

- **Evidence:** `native-executor/src/platform/windows.rs:108-111` derives the executor root from `LOCALAPPDATA`; `native-executor/src/workspace.rs:14-20` recursively resets `workspaces`, `artifacts`, and `profiles`; `test_pascal_execution` calls production initialization at `native-executor/src/platform/windows.rs:2418-2423`. The submitter command did not redirect `LOCALAPPDATA`, and the reported audit covered only `C:\Users\mon\AppData\Local\ThemisV2`.
- **Impact:** a green test can delete or replace live executor workspaces/artifacts/profiles outside the audited tree.
- **Reproduction:** running the exact reported default command updated `C:\Users\mon\AppData\Local\JudgeDesk\JudgeDeskExecutor` at 2026-09-21 00:09:17+07:00 and left `workspaces\startup_self_test`. A later rerun with `LOCALAPPDATA` redirected into the marked verifier root passed 54/54 twice without touching that host path.
- **Acceptance condition:** Native tests must inject/use an owned temporary platform root by construction; the canonical command must not depend on the caller remembering an environment override. Audit both persistent JudgeDesk roots before/after and add a sentinel-preservation regression.

### F3 — High — Production discovery launchers still treat child `error` as exit

- **Evidence:** both production launch paths delete the child from `activeDiscoveryChildren` on `error` at `server/toolchains/discovery.ts:842-874` and `:877-906`. The Round 7 helper at `:1455-1463` behaves differently, and the regression exercises only that helper.
- **Impact:** drain can report quiescence while a real child still has null exit/signal state.
- **Reproduction:** inject an `execFile` child that emits `error` without terminal `exit`/`close`; the production listener removes it immediately, unlike the synthetic helper.
- **Acceptance condition:** use the same terminal-state accounting in production and tests; preserve the launch error and retain tracking until observed exit/close or a failing deadline.

### F4 — High — Compatibility-probe failure preservation and deadlines are incomplete

- **Evidence:** settled probes are removed at `server/toolchains/discovery.ts:706-709`; drain only snapshots the still-active set at `:1433-1440`. Runtime and compatibility promises are awaited with raw `Promise.allSettled` at `:1425-1435`; `deadlineMs` bounds only child listeners.
- **Impact:** an early failure is forgotten, while a hung probe prevents cleanup from returning and prevents the retained-root failure from being reported.
- **Reproduction:** an already-rejected registered probe yielded `{"beforeDrain":0,"outcome":"DRAIN_RESOLVED"}`. A never-settling probe with `drainToolchainDiscovery(50)` was still pending after 250 ms.
- **Acceptance condition:** retain settled errors until the memoized drain consumes/reports them, and apply one bounded deadline/cancellation policy to runtime promises, compatibility probes, and child exits. Cover rejected-before-drain and never-settling cases.

### F5 — High — `ServerLifecycle.drain(timeoutMs)` is memoized but not bounded

- **Evidence:** `server/platform/server-lifecycle.ts:141-149` awaits background operations without a deadline; discovery drain at `:151-155` uses its own default; executor shutdown at `:166-169` is also unbounded. The supplied timeout is used only for judge sessions at `:157`.
- **Impact:** a hung install/prewarm/executor makes every drain caller and production signal handler wait forever, so fail-closed exit logic is never reached.
- **Reproduction:** one tracked never-settling promise plus `drain(50)` remained pending after 250 ms.
- **Acceptance condition:** enforce a shared bounded shutdown budget across all phases, preserve the memoized result, retain owned roots/resources on timeout, and test a real never-settling background operation and executor shutdown.

### F6 — High — Test-root validation accepts a nonexistent path through a junction ancestor

- **Evidence:** for a nonexistent target, `scripts/run-all-tests.js:67-74` canonicalizes only an existing immediate parent; if that parent is also absent, validation falls back to the lexical path. Temp containment and basename authorization then pass at `:105-121`.
- **Impact:** recursive creation beneath `%TEMP%\junction\missing\jd_test_*` can traverse a junction into host state.
- **Reproduction:** a verifier-owned junction under `%TEMP%` pointing to host `ThemisV2` was created without writing through it. `isSafeTestAppDataDir(<junction>\missing\jd_test_escape)` returned `true`. The junction was then removed and the host target remained present.
- **Acceptance condition:** canonicalize the nearest existing ancestor and reject any reparse point in the full ancestor chain; require an owned marker rooted in the canonical approved temp tree. Add the exact nonexistent-descendant junction regression.

### F7 — High — Rust shutdown verification passes after panic or forced abort

- **Evidence:** `crates/judgedesk-core/tests/server_test.rs:409-416` discards a completed task's `JoinError`; on timeout it aborts the task and continues. The subsequent port check succeeds after forced abort and therefore does not prove graceful shutdown.
- **Impact:** a panicking or permanently hanging shutdown path can satisfy the claimed lifecycle gate.
- **Reproduction:** make the server task panic or remain pending after the shutdown response; the current match ignores/aborts it and proceeds.
- **Acceptance condition:** fail the test on timeout, panic, cancellation, or server error; require graceful task completion before port release and root deletion.

### F8 — High — Native `AlreadyExists` handling trusts an unchecked race winner

- **Evidence:** after validating and deleting a cache directory, `native-executor/src/workspace.rs:50-65` treats `create_dir` returning `AlreadyExists` as success without re-running `symlink_metadata`.
- **Impact:** a sibling process can replace the path with a file or junction between deletion and creation, and initialization accepts an untrusted cache root.
- **Reproduction:** race initialization with a creator at the same cache path; the `AlreadyExists` branch returns `Ok(())` regardless of entry type.
- **Acceptance condition:** revalidate the race winner as a non-reparse directory owned by the expected root, or serialize initialization across processes with an authoritative lock. Add a deterministic race-winner test.

### F9 — Medium — Prewarm and route regression tests do not exercise the claimed production failures

- **Evidence:** `server/api-contracts.test.ts:1192-1203` tests only preference mode `managed`, missing local-path verification and every other mutating route. The F8 test at `:1426-1441` accepts either completed/deferred and then injects an unrelated rejecting promise rather than causing `startBackgroundJudgePrewarm()` to fail. `ensureJudgePrewarmReady` still logs and swallows at `server/judge/background-prewarm.ts:192-197`.
- **Impact:** admission and unexpected-prewarm failure regressions remain green while production behavior is wrong.
- **Reproduction:** the focused suite passed 44/44 while F1 direct probes failed immediately.
- **Acceptance condition:** inject production dependencies at the route/prewarm boundary and assert actual work factories, network, filesystem, and prewarm errors are blocked or propagated.

## 3. Remediation claims independently confirmed

- Old production test overrides are absent from production Node/Rust paths; the remaining Rust read is in the test-only binary. The production-mode negative test passed.
- Node parity is 30/30 with no delayed error. Focused contracts pass 44/44, including startup failure, retained-root, cleanup-error, and memoized-drain cases.
- Test-environment root retention after failed discovery quiescence is materially improved.
- Inventory is deterministic across two same-source runs.
- Rust strict parity truthfully exits 1 at 9/30 with 21 documented WP0.2 baseline gaps; report-only exits 0. The strict command is not described as a pass.
- Rust core passes 38/38 and did not spawn Excel or leak `export_*` roots.
- Native tests pass 54/54 twice under default parallel scheduling when `LOCALAPPDATA` is explicitly isolated.
- Discovery-v2 provenance now records the current host hash and a truthful semantic-comparison rule; `ThemisV2` stayed byte-identical during this review.
- All eight version files remain synchronized at 1.5.0.

## 4. Verification matrix

| Command / probe | Isolated root | Expected | Actual | Exit | Result |
|---|---|---|---|---:|---|
| `node scripts/check-api-contracts.js` run 1 | N/A | deterministic | 29 manifest / 33 callers / 29 Node / 29 Rust | 0 | PASS |
| inventory run 2 | N/A | same bytes/counts | same counts and hashes | 0 | PASS |
| Node parity + 5 s observation | owned `jd_contract_env_*` | 30/30, no delayed errors | 30/30; clean | 0 | PASS |
| focused contracts + 5 s observation | owned nested contract roots | all cases, clean teardown | 44/44; no delayed output | 0 | PASS counts; coverage gaps F1/F9 |
| Rust parity strict + 5 s | owned `jd_contract_env_*` | nonzero on known gaps | 9/30, 21 gaps | 1 | EXPECTED STRICT FAILURE |
| Rust parity `--report-only` + 5 s | owned `jd_contract_env_*` | report succeeds | 9/30 recorded | 0 | PASS workflow |
| locked Rust core, serial | Rust-owned temp root | all | 38/38 | 0 | PASS |
| locked Native Executor, exact submitter command, twice | **real host executor AppData** | must be isolated | 54/54 twice; host root timestamp/workspace changed | 0 | FAIL isolation / F2 |
| locked Native Executor twice with redirected `LOCALAPPDATA` | marked verifier root | 54/54 twice | 54/54 twice | 0 | PASS rerun |
| `npm run check:fast` | N/A | green | green | 0 | PASS |
| `npm run test:server` + 5 s | runner-owned AppData/contract roots | green, clean | 576 pass / 0 fail / 10 skip | 0 | PASS |
| `npm run release:check-version` | N/A | all eight at 1.5.0 | 1.5.0 | 0 | PASS |
| closing install sentinel | verifier AppData + loopback server | no request, immediate 503 | 1 request before 503 | 0 | FAIL / F1 |
| closing execution-policy mutation | verifier AppData | immediate 503, no file | 200; file created | 0 | FAIL / F1 |
| settled compatibility rejection | in-memory | drain rejects | drain resolved | 0 | FAIL / F4 |
| discovery hung-probe deadline | in-memory | reject by 50 ms | pending after 250 ms | 0 | FAIL / F4 |
| lifecycle hung-operation deadline | in-memory | reject by 50 ms | pending after 250 ms | 0 | FAIL / F5 |
| junction descendant validator | verifier-owned junction; no target write | reject | accepted `true` | 0 | FAIL / F6 |

`npm run check:full` was not rerun: the required constituent project gates and narrower affected gates had already completed, and direct acceptance blockers made a duplicate aggregate run non-dispositive. `test:desktop` was not run because Round 7 WP0.2 changes are backend/test lifecycle code; no WP0.2 UI/Tauri behavior changed.

## 5. Inventory counts and hashes

| Run | Manifest | Callers | Node | Rust | Inventory SHA-256 | Matrix SHA-256 |
|---|---:|---:|---:|---:|---|---|
| 1 | 29 | 33 | 29 | 29 | `F76EE7266FCBDE85CCD452127B888BAF247516BFE5EB72611CC85BC78508806C` | `96B7786278759568A3E88F5972169A1EE3291BFE920711C9CEDE8DE51E7EA026` |
| 2 | 29 | 33 | 29 | 29 | `F76EE7266FCBDE85CCD452127B888BAF247516BFE5EB72611CC85BC78508806C` | `96B7786278759568A3E88F5972169A1EE3291BFE920711C9CEDE8DE51E7EA026` |

## 6. AppData

- **Primary JudgeDesk data:** `C:\Users\mon\AppData\Local\ThemisV2`.
- **Before/final:** 17,730 files + 826 directories = 18,556 entries; CSV SHA-256 `106B37FC00C43948EF4D51BBB519EE54F21E574BC8D25F315173651522A9690E` both times; semantic diff 0.
- **Receipts/config/discovery:** discovery v2 5,539 bytes, `5C0AA69EA06E3C08D4529D6EFA8E584DF04310EF610B2C08AAB3418BEB6459F1`; `toolchains.json` `5F1BE9EF03B198D9672124B7E194822250B818842C8C392C054EE0B7605F5A7C`; execution policy `55E1D245F8376B9D1F52A2C8C50A51C8AC0909A21792FF374EFACB9F67A9C4B2`; distribution state `AE7ED359D988A3EE4D2A19D497F777E01DF725E08A60488776A39A3308F590EA`. All stayed identical.
- **Additional host executor data:** `C:\Users\mon\AppData\Local\JudgeDesk\JudgeDeskExecutor` was not included in the submitter audit. The exact default Native test command mutated it during review (F2), so no honest before/after semantic equality can be claimed for that root and no fabricated restoration was attempted.

## 7. Cleanup audit

- Final `jd_contract_env_*`, `jd_test_server_appdata_*`, and `%TEMP%\export_*`: 0.
- Relevant test server/parity/executor processes: 0. Observed test ports were released. Excel processes: 0.
- No delayed output/errors during the 5-second observations after Node parity, focused contracts, Rust parity, and the full server suite.
- The verifier-created junction was removed without traversing its target. The marked verifier evidence root was removed after documentation was recorded.
- Host executor AppData mutation is not counted as successful cleanup; it is F2.

## 8. Documents updated

- `docs/verification/pure-rust-core/STATUS.md`
- `docs/verification/pure-rust-core/WORKLOG.md` (`LOG-0028`, append-only)
- `docs/verification/pure-rust-core/wp0.2-api-stream-contract.md`
- `docs/verification/pure-rust-core/wp0.2-independent-round7.md`

## 9. WP0.3 state

`WP0.3 = NOT_READY`. No WP0.3 work was performed.

## 10. Not verified

- `npm run check:full`: not duplicated for the reason recorded in the matrix; `check:fast`, `test:server`, version, Rust, parity, and focused gates were run directly.
- `test:desktop` / Computer Use: not run because no Round 7 WP0.2 UI/Tauri behavior was changed and the backend blockers are independently conclusive.
- macOS SSH: not run because the accepted blockers reproduce on the current Windows checkout and are not cleared by a platform-specific result.
- A destructive race exploit for F8 was not executed against host state; the unchecked `AlreadyExists` branch is established by source review and requires a repository-owned deterministic regression.

