# WP0.2 Independent Verification — Round 5

- **Reviewer:** Codex
- **Timestamp:** 2026-09-20T22:17:03+07:00
- **Source:** Windows HEAD `d80f997cdafaf85883e7602de26c32dd355795a1` plus the preserved shared dirty tree
- **Scope:** WP0.2 only; no WP0.3 implementation and no version bump
- **Verdict:** `IN_PROGRESS`

## Findings

### F1 — Critical — production Node background work has no lifecycle owner

`server.ts:77` calls `registerToolchainRoutes(app)` without the `onBackgroundOperation` owner used by the test adapter, while `server.ts:80-81` separately starts discovery and prewarm without retaining either promise. The callback in `server/routes/toolchain-routes.ts:185` remains optional, and the rescan, prewarm, install, and preference-rescan paths only register work when it is supplied (`:195-198`, `:324-327`, `:514-516`, `:641-644`). The production signal handler only shuts down the executor (`server.ts:111-115`).

**Impact:** the Round 5 tests prove the test adapter's lifecycle, not the production server's lifecycle. Production install/rescan/prewarm work can outlive HTTP shutdown and process state restoration, so the canonical `POST /api/toolchains/:id/install` acceptance condition is not met.

**Reproduction:** `rg -n -C 5 "registerToolchainRoutes\\(|startInitialToolchainDiscovery|startBackgroundJudgePrewarm" server.ts server --glob '!**/*.test.*'` shows the only production registration omits the owner.

**Acceptance:** make production admission, shutdown, and background ownership share one mandatory lifecycle owner; stop admission first, then await/cancel/drain every operation and propagate failures. Add a production-construction failure/race probe, not only a `NodeBackendAdapter` probe.

### F2 — High — discovery drain still resolves without observed process exit and suppresses kill failures

`server/toolchains/discovery.ts:1334-1343` ignores `taskkill` status/stderr and catches every kill exception. `drainToolchainDiscovery()` treats `child.killed` as equivalent to exit (`:1361`), resolves its waiter after a fixed one-second timer (`:1373`), then clears `activeDiscoveryChildren` and runtime state (`:1393-1394`). `ChildProcess.killed` only records that a signal was sent; it is not an observed `exit`.

**Impact:** teardown may delete an isolated root while a compiler probe/process tree is still alive, and a failed `taskkill` can still produce a successful drain. This directly contradicts the Round 5 report and provenance audit claim that all children are awaited through observed exit.

**Reproduction:** inspect the cited lines; the only timeout path calls `resolve`, never `reject`, and kill errors never enter the aggregate error list.

**Acceptance:** retain every child until `exit`/terminal `error`, reject on deadline, validate `taskkill` failure, aggregate kill/wait failures, and add a real non-exiting/failing-kill discovery-child test that proves the root is not removed early.

### F3 — High — the locked Rust core suite opens real Excel and leaks export state while reporting green

`crates/judgedesk-core/tests/server_test.rs:56` still sets `JUDGEDESK_SUPPRESS_EXCEL_SPAWN`, although production correctly stopped reading that variable. The test starts `AppState::default()` through `start_embedded_server()` at `:57`, posts a deliberately invalid workbook to `/api/open-excel` at `:349-368`, and removes only `test_root` at `:375`. The production opener spawns the OS viewer at `crates/judgedesk-core/src/server/mod.rs:161-180`; the handler writes `export_<pid>` and ignores the opener result at `:1467-1488`.

**Impact:** `cargo test --locked --manifest-path crates/judgedesk-core/Cargo.toml -- --test-threads=1` exited 0 with 38/38, but created `C:\Users\mon\AppData\Local\Temp\export_33380\Book.xlsx`, invoked real Excel, and the user observed an Excel error dialog. A green test therefore caused an uncontrolled GUI side effect and left state outside an owned root.

**Reproduction:** run the locked core suite on Windows while Excel is installed and observe `/api/open-excel`; the environment variable no longer suppresses production behavior.

**Acceptance:** construct the Rust test server with an injected no-spawn `WorkbookOpener`, put all export files under an owned isolated root, fail on opener/cleanup error, and assert no Excel process/window and no new `export_*` root.

### F4 — High — host AppData before/after is not stable

The before manifest at 21:03 had 17,730 files, 826 directories, and SHA-256 `DEEC7D434E851AF94802B554C7B11DD73910D932CB5BF0D1739F5C460B68F09F`. The after manifest has the same counts but SHA-256 `7DBD3B68E5ABE50827B62A97F119C4444793383CDF1187DC1090692EA5059F8D` and four manifest-line differences:

- `toolchain-discovery-v2.json`: `5314E7F8...` -> `8D5B0661...`, still 5,539 bytes;
- `toolchain-distribution-state-v1.json`: `8E784761...`, 93 bytes -> `AE7ED359...`, 86 bytes.

The installed JudgeDesk process `C:\Program Files\JudgeDesk\server.exe` started at 21:36:57 and the discovery file was written at 21:36:59, establishing the source of that discovery regeneration. Its candidate path/family/version/error semantics still match the controlled canonical artifact, while timestamps and six PATH ranks changed. The distribution file was written at 21:19:02 and now records Core; the exact writer process was no longer available when audited. No content was fabricated and no guessed restoration was attempted.

**Impact:** the mandatory host-integrity criterion fails, even though the isolated parity roots themselves were removed.

**Acceptance:** close/quiesce host JudgeDesk before the next snapshot, establish the expected state of both changed files from trustworthy canonical evidence, then rerun the entire mutation-capable matrix with identical before/after manifests.

### F5 — Medium — failure cleanup remains non-compositional or suppressed

`server/test-fixtures/api-contracts/test-environment.ts:356-401` awaits discovery drain before restoring the health descriptor/environment and deleting the root. If drain or descriptor restoration throws, every later stage is skipped. The new tests also suppress cleanup failures at `server/api-contracts.test.ts:907` and `:982`; the latter can hide a Rust adapter termination/port-release failure. In `server/test-fixtures/api-contracts/backend-adapter.ts:293-299`, the readiness timeout drops the promise returned by `.finally()`, so a termination rejection can become a separate unhandled rejection while the startup failure is rewritten as a timeout.

**Impact:** failure paths can leave global process state, roots, or children behind while the test either reports an incomplete error or passes.

**Acceptance:** make environment cleanup internally compositional and idempotent, aggregate all stages, await/catch the timeout termination path, and remove all empty/suppressing cleanup catches from verification tests.

### F6 — Medium — aggregate test runner can reuse an unsafe root and report a signalled child as success

`scripts/run-all-tests.js:111-116` creates an owned root only when `THEMIS_APP_DATA_DIR` is absent; a pre-existing value is trusted without proving it is an owned non-host root. At `:153`, `result.status === null` falls back to exit 0, so a child terminated by signal can be reported as success.

**Impact:** the aggregate gate is not fail-closed under hostile/misconfigured environment or abnormal child termination.

**Acceptance:** always create an owned test root (or strictly validate an explicitly supplied owned root), treat null status/signal as failure, and add isolated probes for both cases plus deletion failure.

### F7 — Medium — remediation evidence overstates the implemented guarantees

`docs/verification/pure-rust-core/artifacts/wp0.2/discovery-v2-provenance-audit.json` says discovery waits for all child exits and propagates failures, contradicted by F2. The test named “during or after close” in `server/api-contracts.test.ts:812-824` only admits work after `await close()` has completed. Round 5 also added `catch (err: any)` in `backend-adapter.ts:393` and several `any` casts in the new tests despite the repository strict-type rule.

**Impact:** the report and green tests cannot support approval, and the quality gate currently misses these explicit project constraints.

**Acceptance:** correct the report, add the actual concurrent-close admission test, remove new `any`, and strengthen the quality gate if needed.

## Independently confirmed remediation claims

- Production Node/Rust source and the release `server.exe` no longer contain the old directory-picker/workbook test overrides; the Rust `test-server` target requires its non-default feature.
- Settled Node adapter background rejections are retained through `close()` and late admission after close is rejected.
- The Rust adapter's direct termination tests now wait for observed exit, preserve direct kill errors, and verify port rebind in the covered paths.
- Preference-triggered rescan is tracked by the test adapter.
- Inventory output is deterministic across two runs.
- Node parity, focused contract cases, Rust tests, server tests, fast/full gates, and eight-file version lockstep pass by command exit/count. These green results do not override F1-F7.

## Verification matrix

| Command / probe | Isolated root | Expected | Actual | Exit | Verdict |
|---|---|---|---|---:|---|
| `node scripts/check-api-contracts.js` x2 | `jd_wp02_round5_inventory_77cca7c3e808491abc20cd63921b55e1` for logs | deterministic counts/hashes | 29 manifest / 33 callers / 29 Node / 29 Rust both runs | 0 / 0 | PASS |
| `npx tsx scripts/check-contract-parity.ts --adapter=node` | `jd_contract_env_gVRait` | 30/30, clean teardown | 30/30; root/process released | 0 | PASS |
| `npx tsx --test server/api-contracts.test.ts` + delayed observation | nested `jd_contract_env_lkB12D/.../RayHmW` | 33/33, no delayed failure | 33/33; no remaining contract root/process after observation | 0 | PASS |
| `npx tsx scripts/check-contract-parity.ts --adapter=rust` | `jd_contract_env_jg6b7A` | strict nonzero for documented gaps | 9/30, 21 gaps | 1 | EXPECTED STRICT SIGNAL |
| same with `--report-only` | `jd_contract_env_FxE276` | report, exit 0 | 9/30, 21 gaps | 0 | PASS |
| `cargo test --locked --manifest-path crates/judgedesk-core/Cargo.toml -- --test-threads=1` | no outer owned AppData/export root | 38/38 without external effects | 38/38, but real Excel invoked and `export_33380` retained | 0 | FAIL acceptance |
| `cargo test --locked --manifest-path native-executor/Cargo.toml -- --test-threads=1` | native test roots | 54/54 | 54/54 | 0 | PASS |
| `npm run check:fast` | N/A | pass | pass | 0 | PASS |
| `npm run test:server` + 8-second observation | owned `jd_test_server_appdata_*` and nested contract roots | green, no late output/root/process | 565 passed / 0 failed / 10 skipped; no late test root/process | 0 | PASS |
| `npm run check:full` | same automatic roots | all constituent gates pass | 565/0/10 plus fast/version pass | 0 | PASS by command; does not cover findings |
| `npm run release:check-version` | N/A | eight files at 1.5.0 | 1.5.0 | 0 | PASS |
| host AppData before/after | real AppData read-only snapshots | identical | two files changed; tree hash changed | N/A | FAIL |

## Inventory determinism

| Run | Manifest | Callers | Node | Rust | Inventory SHA-256 | Matrix SHA-256 |
|---|---:|---:|---:|---:|---|---|
| 1 | 29 | 33 | 29 | 29 | `F76EE7266FCBDE85CCD452127B888BAF247516BFE5EB72611CC85BC78508806C` | `96B7786278759568A3E88F5972169A1EE3291BFE920711C9CEDE8DE51E7EA026` |
| 2 | 29 | 33 | 29 | 29 | `F76EE7266FCBDE85CCD452127B888BAF247516BFE5EB72611CC85BC78508806C` | `96B7786278759568A3E88F5972169A1EE3291BFE920711C9CEDE8DE51E7EA026` |

## AppData and cleanup

- Path: `C:\Users\mon\AppData\Local\ThemisV2`.
- Before: 17,730 files / 826 directories / 18,556 entries; manifest SHA-256 `DEEC7D434E851AF94802B554C7B11DD73910D932CB5BF0D1739F5C460B68F09F`.
- After: 17,730 files / 826 directories / 18,556 entries; manifest SHA-256 `7DBD3B68E5ABE50827B62A97F119C4444793383CDF1187DC1090692EA5059F8D`.
- Semantic diff: discovery retains the same 11 candidate path/family/version/error tuples but has regenerated timestamps/PATH ranks; distribution now records Core. This is not a byte-stable result.
- Evidence: `artifacts/wp0.2/independent-round5/appdata-before.csv` and `appdata-after.csv`.
- Contract/server test roots after delayed observation: zero `jd_contract_env_*` and zero `jd_test_server_appdata_*`.
- Test processes/listeners: zero Node/Cargo/`test-server` verifier processes and all test ports released. The user's installed JudgeDesk app remained active at `127.0.0.1:60430`; it was not terminated.
- Rust core test side effect: `export_33380` retained and Excel displayed an error. Existing Excel instances were not killed to avoid data loss.
- No delayed Node-suite ENOENT/unhandled error was observed. The Excel/UI side effect is independently observable and fails cleanup quality.

## Not verified

- No desktop suite or Computer Use matrix was run: WP0.2 introduced no intended UI behavior, and the observed Excel launch is already a failing unintended side effect.
- No macOS SSH run was performed: the blocking lifecycle/isolation defects reproduce in shared cross-platform code and Windows-specific Rust test behavior; macOS cannot change the verdict.
- The exact writer of the 21:19 distribution-state update could not be recovered after that process exited. The later discovery writer is correlated exactly with the installed JudgeDesk process start.
- A fresh-context adversarial sub-review was attempted as required by the review skill but could not run because the workspace reported exhausted agent credits. The user had already declined an additional external cross-model CLI review.

## Decision

WP0.2 returns from `VERIFYING` to `IN_PROGRESS`. WP0.3 remains `NOT_READY`. These are actionable repository defects, so `BLOCKED` is not appropriate.
