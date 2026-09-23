# WP0.2 Independent Verification — Round 8

- Reviewer: Codex (independent)
- Timestamp: `2026-09-21T08:56:35+07:00`
- Workspace: `D:\Minh\Code\judgedesk`
- Source: HEAD `d80f997cdafaf85883e7602de26c32dd355795a1` plus the preserved dirty saved checkout
- Scope: WP0.2 only; WP0.3 was not started
- Verdict: **IN_PROGRESS**

## Decision

Round 8 does not satisfy the WP0.2 acceptance boundary. Most Round 7 lifecycle, discovery, junction, and Rust shutdown changes are present and the normal commands exit with their expected codes, but workflows that emit unresolved cleanup errors are not classified as passing. The production/test boundary and host-state guarantees fail under direct verification. No external dependency blocks remediation, so `BLOCKED` is not appropriate.

## Reviewed source identity

The review began on `main...origin/main`, HEAD `d80f997cdafaf85883e7602de26c32dd355795a1`, with 73 tracked files changed (`2,344` insertions / `1,053` deletions) and the existing untracked migration tree. The complete `git status --short --branch`, `git diff --stat`, `git diff --name-status`, and untracked inventory were captured before test execution and rechecked before documentation edits. Relevant tracked changes included `native-executor/src/{lib.rs,main.rs,platform/windows.rs,workspace.rs}`, `server.ts`, `server/executor/workspace.ts`, `server/judge/background-prewarm.ts`, `server/platform/server-lifecycle.ts`, `server/routes/{system-routes.ts,toolchain-routes.ts}`, `server/toolchains/{discovery.ts,local-execution.ts,manifest.ts}`, and Tauri startup/backend files. Relevant untracked review inputs included `crates/`, `scripts/check-api-contracts.js`, `scripts/check-contract-parity.ts`, `scripts/run-all-tests.js`, `server/api-contracts.test.ts`, `server/test-fixtures/`, and `docs/verification/`.

The checkout also contains UI files unrelated to the WP0.2 backend/executor failures. No desktop suite was run: the reviewed Round 8 claims and every reproduced blocker are in backend, test-harness, or Native Executor paths; no UI acceptance claim was used for the verdict.

## Findings

### R8-F1 — Critical — the production Native Executor reads a test-only root override

`native-executor/src/platform/windows.rs:161-170` reads `JUDGEDESK_EXECUTOR_TEST_ROOT` inside `#[cfg(not(test))]`. The staged production binary `src-tauri/binaries/judgedesk-executor-x86_64-pc-windows-msvc.exe` (920,576 bytes, SHA-256 `E22C5FA6F8215FC174E31A8DAB9AE9E5AD38A0F10FADF5CD7442D9E9C49FF98C`) contains the literal and obeys it. A direct production-binary probe exited 0 and created `JudgeDesk/JudgeDeskExecutor` below `C:\Users\mon\AppData\Local\Temp\jd_prod_executor_override_probe_r8`.

The regression named “production release binary does not contain test overrides” is narrower than its title: `server/api-contracts.test.ts:710-760` audits only the Rust HTTP server binary and never audits the Native Executor. This violates the explicit Round 8 requirement that the production executor must not read the test override.

Acceptance condition: remove the override from production Native Executor behavior or place it behind a genuinely test-only artifact/feature that cannot ship; audit and execute the actual staged production executor in the regression.

### R8-F2 — Critical — the Node parity harness can write to real host Executor AppData

`server/executor/client.ts:65-67,578` snapshots `process.env` when the global singleton is imported. `server/test-fixtures/api-contracts/test-environment.ts:210-220` installs `JUDGEDESK_EXECUTOR_TEST_ROOT` later. Therefore the direct canonical Node parity process starts the production executor with the original host environment.

The first direct Node parity run created `C:\Users\mon\AppData\Local\JudgeDesk\JudgeDeskExecutor`, copied managed toolchains, created workspaces and startup self-test files, and logged cleanup failures against that real root. The root was absent at the initial pre-test existence snapshot. During the run it reached 7,757 files and 731 directories; the final state remains 7,733 files and 696 directories with aggregate SHA-256 `86BA66DF75B8FB624EB2F4C96B4297F1387F9D3DCC3FB5CA1F91A4C6C37AF32C`.

The Native sentinel regression is also structurally invalid: `native-executor/src/platform/windows.rs:2532-2573` creates the real host executor directory and writes/deletes `sentinel.txt` as part of a test that claims the host root is untouched. It leaves any newly created parent directories behind.

Acceptance condition: configure executor environment before singleton construction or inject a per-adapter executor client; make all Native tests use a verifier-owned marked root without creating or writing the host root; reproduce byte-identical before/after snapshots of both AppData roots.

### R8-F3 — High — cleanup errors are logged but the parity workflow returns success

The isolated Node parity rerun reached 30/30 and exit 0, but emitted repeated `Workspace cleanup deferred: EPERM` errors for executor workspaces. The focused suite and `check:full` emitted the same class of errors while still returning exit 0. This conflicts with the fail-closed cleanup requirement: a verifier cannot treat an observed deletion failure as a clean pass merely because a parent runner may later remove a broader directory.

Acceptance condition: await retry/quarantine cleanup to a terminal result and make unresolved workspace deletion failure fail the adapter/suite with the retained owned path reported.

### R8-F4 — Medium — the prewarm regression does not exercise an actual prewarm rejection

Production source now propagates the active prewarm promise (`server/judge/background-prewarm.ts:187-200`), which is an improvement. However, `server/api-contracts.test.ts:1561-1578` accepts either `deferred` or `completed` from the real call, then creates an unrelated `Promise.reject`, registers that promise directly with a new lifecycle, and proves only that the unrelated promise rejects. No failure is injected through `executeJudgePrewarm` / `startBackgroundJudgePrewarm` / `ensureJudgePrewarmReady`.

Acceptance condition: inject a deterministic failure in the real prewarm dependency and prove that the same rejection crosses the production ensure/prewarm/lifecycle path to the caller.

### R8-F5 — Medium — `AlreadyExists` validation lacks the required Windows substitution coverage

`native-executor/src/workspace.rs:38-84` contains the intended revalidation and rejects Windows reparse points. However, `native-executor/src/workspace.rs:195-207` places a regular file before calling `reset_directory`; the initial `symlink_metadata` check rejects it before `fs::create_dir`, so it does not exercise the `AlreadyExists` winner branch. The symlink test is Unix-only and there is no deterministic file, symlink, or Windows junction substitution probe that reaches the `AlreadyExists` branch.

Acceptance condition: add deterministic file, symlink, and real Windows junction winner probes and verify that the outside sentinel/target is untouched.

## Remediation claims supported by source review and rerun

These are source/test observations, not a substitute for every independent branch-specific probe required by the contract:

| Round 7 item | Source evidence | Rerun evidence | Acceptance assessment |
|---|---|---|---|
| F1 route admission | synchronous guards reviewed in `server/routes/toolchain-routes.ts` | focused test “toolchain routes reject background work with 503” passed | supported, but no separate verifier-owned side-effect sentinel for every route |
| F3 child tracking | `server/toolchains/discovery.ts` removes only after non-null exit/signal | focused `error`-without-exit deadline test passed | supported |
| F4 discovery work | abort/deadline and settled error collections reviewed in discovery/local-execution | settled rejection, never-settling probe, and cleanup-composition tests passed | supported |
| F5 lifecycle drain | one `remainingBudget()` and memoized drain reviewed in `server/platform/server-lifecycle.ts` | bounded never-settling and identical-promise tests passed | supported |
| F6 containment | nearest-existing-ancestor walk reviewed in `scripts/run-all-tests.js` | Windows test created a real junction and rejected its nonexistent descendant | supported |
| F7 Rust shutdown | fatal timeout/join handling reviewed at `crates/judgedesk-core/tests/server_test.rs:408-422` | locked core suite and port rebind test passed | supported by current test path; failure branches were not separately fault-injected by this reviewer |
| F8 race validation | revalidation exists in `native-executor/src/workspace.rs:79-83` | no test reaches the `AlreadyExists` winner branch | not accepted; R8-F5 |
| F9 prewarm propagation | active promise is awaited at `server/judge/background-prewarm.ts:187-200` | test uses an unrelated rejected promise | not accepted; R8-F4 |

## Command evidence

| Command / probe | Root | Expected | Actual | Exit / verdict |
|---|---|---|---|---|
| `node scripts/check-api-contracts.js` twice | saved checkout | deterministic inventory | both 29 manifest / 33 callers / 29 Node / 29 Rust; identical hashes | 0 / PASS |
| `npx tsx scripts/check-contract-parity.ts --adapter=node` (direct first run) | harness-created `jd_contract_env_XpNIIR` | 30 cases and no host mutation | all cases ran; real host Executor AppData was populated; wrapper did not emit a final summary before tool return | FAIL isolation / completion inconclusive |
| `$env:LOCALAPPDATA=<owned>; $env:APPDATA=<owned>; npx tsx scripts/check-contract-parity.ts --adapter=node` | `jd_verifier_r8_nodeparity` | 30/30, no host write, fail-closed cleanup | 30/30; repeated workspace cleanup `EPERM` errors | 0 / overall FAIL (fail-open cleanup) |
| `node scripts/run-all-tests.js --filter=api-contracts.test.ts` | owned `jd_test_server_appdata_*` | focused WP0.2 plus fail-closed cleanup | 47/47, 0 test fail; repeated executor cleanup errors were observed | 0 / overall FAIL (fail-open cleanup) |
| `$env:LOCALAPPDATA=<owned>; $env:APPDATA=<owned>; npx tsx scripts/check-contract-parity.ts --adapter=rust` | `jd_verifier_r8_rustparity` | strict mismatch signal allowed by WP0.2 freeze plan | 9/30, 21 documented gaps | 1 / expected strict FAIL, not called a pass |
| `$env:LOCALAPPDATA=<owned>; $env:APPDATA=<owned>; npx tsx scripts/check-contract-parity.ts --adapter=rust --report-only` | `jd_verifier_r8_rustparity_report` | report generation | 9/30, 21 gaps | 0 / PASS report mode only |
| `cargo test --locked --manifest-path crates/judgedesk-core/Cargo.toml -- --test-threads=1` | isolated test roots | locked core tests | 38/38 | 0 / PASS |
| `cargo test --locked --manifest-path native-executor/Cargo.toml` twice | canonical/default environment | tests plus host isolation | 53 lib + 3 binary tests on each run; sentinel itself writes host path | 0 / test PASS, isolation FAIL |
| `npm run check:fast` | saved checkout | types + quality | clean | 0 / PASS |
| `npm run test:server` | runner-owned isolated root | full server suite and fail-closed cleanup | 579 pass, 0 fail, 10 existing platform/privilege/real-toolchain skips; cleanup errors observed | 0 / overall FAIL (fail-open cleanup) |
| `npm run release:check-version` | saved checkout | 8-file lockstep | version 1.5.0 | 0 / PASS |
| `npm run check:full` | runner-owned isolated root | full boundary gate including cleanup | check:fast + 579/0/10 + version 1.5.0, but cleanup errors observed | 0 / overall FAIL (fail-open cleanup) |
| `$env:JUDGEDESK_EXECUTOR_TEST_ROOT=<owned>; & src-tauri\binaries\judgedesk-executor-x86_64-pc-windows-msvc.exe` with stdin EOF | `jd_prod_executor_override_probe_r8` | production must ignore test override | binary created executor state below override root | 0 / FAIL |

No user Excel process was touched.

## Production/test-boundary audit

The exact static audit used `rg` over `server`, `server.ts`, `scripts`, `crates`, `native-executor`, and `src-tauri`, excluding docs, build outputs, dependencies, and target directories. `JUDGEDESK_TEST_SELECT_DIRECTORY`, `JUDGEDESK_TEST_SELECT_FILE`, and `JUDGEDESK_SUPPRESS_EXCEL_SPAWN` were confined to test fixtures/tests and the feature-gated Rust `test_server`; the focused negative production-mode route probe passed. No test-only HTTP header was found. `JUDGEDESK_EXECUTOR_TEST_ROOT` was found in test fixtures and, incorrectly, in `native-executor/src/platform/windows.rs:163` under `#[cfg(not(test))]`; the staged-binary negative probe failed as R8-F1 records. The `JUDGEDESK_TEST_VISIBLE` occurrence is test data inside a macOS launcher unit test, not a production branch.

## Inventory reproducibility

Both runs produced:

- manifest routes: 29
- frontend callers: 33
- Node routes: 29
- Rust routes: 29
- `api-contract-inventory.json` SHA-256: `F76EE7266FCBDE85CCD452127B888BAF247516BFE5EB72611CC85BC78508806C`
- `api-contract-matrix.md` SHA-256: `96B7786278759568A3E88F5972169A1EE3291BFE920711C9CEDE8DE51E7EA026`

The two executions were byte/semantic stable and match LOG-0029.

## Host-state comparison

The snapshot canonical form is sorted `relative-path<TAB>type<TAB>size<TAB>file-sha256`, hashed with SHA-256. Timestamps are not used in the decision.

| Root | Before | After | Result |
|---|---|---|---|
| `C:\Users\mon\AppData\Local\ThemisV2` | 17,730 files / 826 dirs / `6EC74C1D8836358EB33226378CC95BB288D24BC6C5D8C485A8E9C5640479FCAF` | identical counts and hash | byte-identical, 0 path/type/size/content diffs |
| `C:\Users\mon\AppData\Local\JudgeDesk\JudgeDeskExecutor` | absent at initial pre-test existence/content boundary; empty aggregate is SHA-256 `E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855` | 7,733 files / 696 dirs / `86BA66DF75B8FB624EB2F4C96B4297F1387F9D3DCC3FB5CA1F91A4C6C37AF32C` | host mutation; FAIL |

The retained intermediate JSON named `before-JudgeDeskExecutor.json` was captured at `08:37:09` after the root had already been created during the first direct Node run, so it is not used as the true pre-test baseline. The initial absence check establishes an empty tree, but no separate durable pre-test JSON survives for that check; therefore a future acceptance rerun must create and preserve both full snapshots before any command. Compared with the intermediate snapshot, the final tree has the same counts but three changed files: `workspaces/startup_self_test/probe.exe`, `probe.stderr`, and `probe.stdout`.

`toolchain-discovery-v2.json` stayed valid JSON, 5,539 bytes, SHA-256 `5C0AA69EA06E3C08D4529D6EFA8E584DF04310EF610B2C08AAB3418BEB6459F1`; the full ThemisV2 semantic/content diff is zero. The historical WP0.1 bytes are not reconstructed or fabricated.

## Cleanup audit

After a 7-second observation window:

- no relevant executor/test-server/compiler/toolchain child process remained;
- no listening test port in 63800–63999 remained;
- no Excel process was present or started;
- no `jd_contract_env_*`, `jd_test_server_appdata_*`, `jd_test_executor_*`, or `export_*` root from normal suite ownership remained;
- four verifier-owned roots remained: `jd_prod_executor_override_probe_r8`, `jd_verifier_r8_nodeparity`, `jd_verifier_r8_rustparity`, and `jd_verifier_r8_rustparity_report`. Removal was attempted only after exact absolute-path validation, but the execution policy rejected the recursive deletion command. They are reported, not hidden.

The host Executor AppData mutation is intentionally not “restored” or overwritten to manufacture a matching hash.

## State transition and next action

- WP0.2: `VERIFYING` -> `IN_PROGRESS`
- WP0.3: remains `NOT_READY`
- Next owner: remediation agent
- Required next action: remediate R8-F1 through R8-F5, rerun direct isolated workflows, and repeat a fresh independent review with byte-complete snapshots of both AppData roots.

## Documentation updated

- `docs/verification/pure-rust-core/STATUS.md`
- `docs/verification/pure-rust-core/WORKLOG.md` (`LOG-0030`, append-only)
- `docs/verification/pure-rust-core/wp0.2-api-stream-contract.md`
- this report

## Not fully verified

- A valid durable pre-test JSON for the initially absent host Executor root was not preserved; this does not weaken the observed host mutation, but prevents claiming a complete reusable before artifact.
- Separate verifier-owned fault injection was not added for every F1/F3/F4/F5/F7 branch; current support combines direct source review with named focused regressions. These claims are not used to override the blockers.
- The per-route manifest/caller/Node/Rust matrix and fixture assertions were regenerated twice with stable hashes, and the inventory checker reported no uncovered manifest route; individual rows were not reprinted in this report. No new documentation/implementation conflict was found beyond the production/test-boundary contradictions recorded above.
- No cross-model review was performed, per the user's explicit direction. The required fresh-context same-model adversarial review was reconciled into this report.
