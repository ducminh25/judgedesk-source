# WP0.5 — Rust gates, CI, and expected-skip policy

## Current state

- Status: **DONE** (LOG-0084; Windows and exact-archive live macOS gates and cleanup PASS)
- Claim: LOG-0083 findings repaired with shared emitted diagnostic rows/aggregate and a real owned-header C compilation failure; native pipeline timing repaired without widening limits
- Implementor and self-reviewer: Codex, explicitly authorized by Mon; different-model review declined
- Current evidence: `artifacts/wp0.5/remediation-review-log0084-codex-20260930/review.md`; closure in `completion-summary.json` and `macos-evidence-verification.json`; historical resume instructions retained
- Workspace: `D:\Minh\Code\judgedesk`, HEAD `8bc8ac9a2161a7468b633c421185d039c97e5a68` plus preserved dirty changes
- Rejected candidate source archive: `docs/verification/pure-rust-core/artifacts/wp0.5/remediation-log0074-source-closure-candidate-v3/judgedesk-wp05-log0074-source-closure-candidate-v3.tar.gz` (42,895,790 bytes, SHA-256 `CAEAB55444F3504A6E41FFE429F99B5CA6165A8AD463922F019242E6557C9F5F`)
- Rejected candidate source freeze: `docs/verification/pure-rust-core/artifacts/wp0.5/remediation-log0074-source-closure-candidate-v3/source-freeze-log0074-source-closure-candidate-v3.json` (3,131 build inputs; revalidated after the Windows gate with 0 mismatches)
- Version: preserve eight-file lockstep `1.5.1`; WP0.5 does not authorize a version bump
- Dependency: WP0.1 and WP0.4 are `DONE`; G0 remains closed
- Rejected LOG-0082 candidate: `artifacts/wp0.5/remediation-log0081/` (3,132 frozen inputs; archive 42,898,302 bytes; SHA-256 `412FAE3E7DB653238BA91651893C9D976F23731DABFB3CA47D4B7674DA2EDE03`); independent evidence in `artifacts/wp0.5/independent-review-log0083-codex-20260930/`

## Falsifiable package claim

Every required Rust regression and every unexpected or release-blocking skip fails the same documented local/package-completion and relevant Windows/macOS CI path. The Rust gate attempts every mandatory crate/component even after an earlier failure, reports an aggregate nonzero result, preserves deterministic inventory, and cannot turn a missing supported runtime, empty selection, identity/name drift, expired exception, production `unwrap()`/`expect()`, prohibited scoring syntax inside the declared scoring boundary, Clippy warning or failing Rust test into green.

## Confirmed opening gaps & resolutions

1. `npm run check:full` previously omitted a complete Rust gate: RESOLVED. `npm run check:full` now directly composes `npm run test:rust` (`node scripts/run-rust-gates.js`), executing complete sequential fmt, clippy, and tests across all 3 components.
2. `.github/workflows/ci.yml` lacked locked tests and clippy across core/native/Tauri: RESOLVED. Windows and macOS CI steps now execute `npm run test:rust` with `rustfmt` and `clippy` components installed.
3. `docs/verification/pure-rust-core/expected-skips.json` was absent: RESOLVED. Built `expected-skips.json` with formal JSON schema `scripts/expected-skips.schema.json` and strict validator `scripts/check-expected-skips.js`.
4. `crates/judgedesk-core/tests/toolchain_diagnose_test.rs` reported all profiles in one monolithic test: RESOLVED. Decomposed into 6 independent profile tests (`cpp`, `c`, `python`, `pascal`, `java`, `scratch`) plus 1 continue-and-aggregate orchestrator test.
5. Existing skip/ignore sites lacked authoritative reconciliation: RESOLVED. All skip sites classified and reconciled against authoritative `server/toolchains/release-scope.ts` and `server/languages/registry.ts`.
6. Subprocess execution in Rust gates was unbounded (Defect 2 from LOG-0072): RESOLVED. Added fail-closed timeouts (`DEFAULT_STEP_TIMEOUT_MS = 600_000`), bounded buffers (`DEFAULT_MAX_BUFFER_BYTES = 16 * 1024 * 1024`), head/tail output truncation (`MAX_RETAINED_OUTPUT_CHARS = 100_000`), step failure tracking (`timedOut`, `outputLimitExceeded`), and continue-and-aggregate aggregate nonzero return in `scripts/run-rust-gates.js`. Structural and mutation tests added in `scripts/structural-gates.test.ts`. RED logs captured in `red-15-hung-child-timeout.log` and `red-16-output-spam-buffer.log`.
7. Host audit comparator had false negatives and PowerShell 5.1 array-wrapping bugs (Defect 1 from LOG-0072): RESOLVED. Fixed JSON array unrolling and hashset union in `compare-host-state.ps1`. Preserved `before-log0071` and `after-log0071` raw deltas. Fixed `[System.BitConverter]` in `snapshot-host-state.ps1`. Fresh baseline and post-run snapshots confirmed `AllEqual = true` and `OwnedStateClean = true` (0 AppData additions/removals/changes, 0 leaked processes, 0 leaked temp roots, 0 new threats).

## Required acceptance matrix

| ID | Required property | Implementor evidence | Independent result |
|---|---|---|---|
| A | One documented Rust gate runs `cargo fmt --check`, locked all-target Clippy with `-D warnings`, and locked tests for core, native executor and Tauri in a safe sequential order; it attempts every mandatory component, aggregates failures and exits nonzero | LOG-0084 Windows Rust 9/9; actual mutation-core-gate.json attempts all nine despite core test and Clippy rejection; structural real hung/spam bounds 8/8. | PASS (LOG-0084 same-session review authorized by Mon) |
| B | The package-completion path invokes the Rust gate, and relevant Windows/macOS CI jobs invoke the same contract without silently weakening Linux or release workflows | Current package and CI composition inspected; structural 8/8 and enclosing Windows check:full PASS. | PASS (LOG-0084 same-session review authorized by Mon) |
| C | Compiler-backed Clippy policy rejects production Rust runtime `unwrap()`/`expect()`; a declared and inventory-checked scoring-source boundary rejects prohibited float types/operations with representative syntactic mutations, without claiming whole-program alias analysis | Actual production unwrap and warning Clippy mutants rejected; runtime/scoring-boundary mutation validators PASS. | PASS (LOG-0084 same-session review authorized by Mon) |
| D | `expected-skips.json` has a validated schema and complete discovered mapping with separate stable policy ID and observed test identity/name/source fingerprint, runner, target tuple/source mode, owner, machine-readable prerequisite predicate, ISO expiry and machine-readable removal predicate | Current skip schema/inventory/fingerprints validated; only changed compiler-test fingerprints refreshed. | PASS (LOG-0084 same-session review authorized by Mon) |
| E | Existing production release sources (`server/toolchains/release-scope.ts` plus registered profiles/hosts/roles in `server/languages/registry.ts`) define required target tuples; the skip system imports and reconciles them rather than creating a second authority. A waiver is valid only while prerequisite=true, removal=false and expiry is future. Unknown, identity/name-drifted, duplicate, expired, stale, unobserved and required-target skips fail closed; empty/overbroad or incomplete suite selection cannot pass | Production release authorities remain read-only; waiver/identity/expiry/prerequisite/removal/required-target mutation validators PASS. | PASS (LOG-0084 same-session review authorized by Mon) |
| F | Toolchain diagnostics are independently named and reported per authoritative release profile/source mode; the runner continues after a profile failure, records every row and returns aggregate nonzero | Shared emitted ordered report returns exit_code 1 for real owned stdio.h C failure; only C failed, all later profiles passed; diagnostics 8/8. | PASS (LOG-0084 same-session review authorized by Mon) |
| G | RED mutations prove a failing core test, Clippy warning, prohibited runtime unwrap/expect, prohibited float-scoring use, new skip and missing supported runtime each fail the intended gate; mutations are absent from final source | Actual compiler-backed failures, policy/scoring/skip mutations and missing-runtime corpus regression reject as required. Source restored; stale Cargo mutation binary was rebuilt and rejected enclosure retained. | PASS (LOG-0084 same-session review authorized by Mon) |
| H | Final frozen candidate passes one enclosing `check:full` whose log proves successful fast/Rust/server/parity/version children, plus only non-enclosed structural/mutation/platform checks; required live macOS commands run against identical source without duplicate final child runs | Windows final check:full PASS: Rust 9/9, server 664 pass / 0 fail / 10 registered skips, parity 67/67, version 1.5.1. Exact archive live macOS quality/ARM64 builds and Rust 9/9 PASS (180660 ms); all 3132 extracted inputs match before/after. Rejected cache/lipo attempts retained separately. | PASS (LOG-0084) |
| I | Test/skip/profile inventories, exact commands, durations, counts and all skip reasons are machine-readable and linked. Every test/gate entry point found in package scripts, workflows and directly invoked scripts is classified as canonical coverage, alias/composition, platform/live gate or explicit non-test exclusion; canonical filesystem/Cargo roots reconcile to selected inventory so an omitted entry point/suite/file/target fails even when other tests still run | Entry-point/inventory/structural validators and mutations pass; machine-readable skip, native gate, diagnostics and freeze records retained in LOG-0084 artifacts. | PASS (LOG-0084 same-session review authorized by Mon) |
| J | Before/after host audit and delayed cleanup show no owned processes, listeners, roots or unintended AppData changes from stateful diagnostics | Windows OwnedStateClean=true, zero protected-state changes/leaks; overlapping snapshot timing and exact ambient cleanup deltas disclosed. macos-cleanup.json confirms marker/absolute path, removed root and no owned processes before removal or after 15s. | PASS (LOG-0084, stated snapshot limits) |

## Remediation LOG-0073 (Post-LOG-0072)

1. **Defect 1 Remediated (Truthful Host Audit):**
   - Corrected PowerShell 5.1 JSON array unrolling bug in `compare-host-state.ps1` via `Read-JsonContent`.
   - Corrected key union bug where PowerShell stringified hashtable keys into a single delimited string.
   - Fixed `[System.Convert]::ToHexString` to `[System.BitConverter]::ToString().Replace('-', '')` in `snapshot-host-state.ps1` for PowerShell 5.1 compatibility.
   - Preserved previous raw snapshots as `before-log0071` and `after-log0071`.
   - Re-executed fresh `before` and `after` snapshots around the single enclosing `npm run check:full`.
   - Result: `AllEqual = True, OwnedStateClean = True` with 0 AppData additions/removals/modifications, 0 reparse points, 0 leaked processes, 0 leaked temp roots, 0 new Defender threats (`docs/verification/pure-rust-core/artifacts/wp0.5/host-comparison.json`).

2. **Defect 2 Remediated (Bounded Fail-Closed Subprocess Execution in Rust Gates):**
   - Added `DEFAULT_STEP_TIMEOUT_MS = 600_000`, `DEFAULT_MAX_BUFFER_BYTES = 16 * 1024 * 1024`, `MAX_RETAINED_OUTPUT_CHARS = 100_000` to `scripts/run-rust-gates.js`.
   - Added bounded head/tail truncation via `truncateBoundedOutput()`.
   - Added fail-closed timeout and buffer-exceeded handling to `runStep()`.
   - Added structural validation and mutation coverage (hung child test, output-spam child test, mutations 10–13) to `scripts/structural-gates.test.ts` (all 7 tests PASS).
   - Generated RED logs `red-15-hung-child-timeout.log` and `red-16-output-spam-buffer.log`.

3. **Source Freeze and Package Archive:**
   - Fixed Unicode path handling for `tar.exe` in `pack-source-archive.ps1` so all 3,126 candidate build inputs (including 3 corpus files with Vietnamese diacritics) are archived without errors.
   - Refroze 3,126 candidate build inputs to `docs/verification/pure-rust-core/artifacts/wp0.5/source-freeze-log0070.json`.
   - Packaged candidate source archive `docs/verification/pure-rust-core/artifacts/wp0.5/judgedesk-wp05-source.tar.gz` (42,895,685 bytes, SHA-256 `E773E2A3E9B1A7E3ECAB5B205A5DEA10FF10CFC649F11D9E4C93DB8450D80120`).
   - Verified live macOS gate against identical archive on `judgedesk-mac` (9/9 steps PASS in 58,683ms, `macos-gate-final.log`).

## Scope limits

WP0.5 edited gate scripts, tests, package scripts, relevant CI workflows, the skip registry/schema, diagnostic test decomposition, this report, bounded LOG-0070/LOG-0071/LOG-0073 STATUS/WORKLOG handoff fields, owned evidence/index artifacts, and next-round WP0.5 prompts. The production release/profile authorities in `server/toolchains/release-scope.ts` and `server/languages/registry.ts` were maintained as read-only inputs. Existing dependencies and built-in primitives were strictly reused; no npm or Cargo dependencies were added. Version numbers remain locked at `1.5.1` across all 8 files. WP0.6, WP0.7, and G0 remain closed.

## Independent re-verification LOG-0074

- Archive identity was confirmed: 42,895,685 bytes, SHA-256 `E773E2A3E9B1A7E3ECAB5B205A5DEA10FF10CFC649F11D9E4C93DB8450D80120`, and 3,126 members.
- Codex recomputed size, content SHA-256 and UTC mtime ticks for every freeze record before and after diagnostic probes: 0 mismatches both times.
- Expected-skips, runtime-invariant, scoring-boundary, entry-point graph and all seven structural-gate tests passed. The corrected host comparison reports `AllEqual=true` and `OwnedStateClean=true`; it does not override functional failures.
- Independent `npm run test:rust -- --json` attempted all nine steps. Native executor and Tauri passed; core fmt and Clippy passed; core tests failed with exit 101. A focused rerun reproduces the `toolchain_diagnose_test` orchestrator failure, while `engine_execution_test` passes in isolation.
- Verdict: **IN_PROGRESS**. Do not run `npm run check:full` or claim the archived macOS run proves this candidate until supported Python and Java diagnostics are deterministic and a fresh candidate is frozen.

## Handoff rule

LOG-0073 is rejected. WP0.5 is `IN_PROGRESS`; STATUS, WORKLOG and this report are synchronized to that verdict. Antigravity remediates only under `docs/verification/pure-rust-core/prompts/wp0.5-antigravity-remediate-log0074.md`, then stops at a new frozen `VERIFYING` submission for a fresh review under `docs/verification/pure-rust-core/prompts/wp0.5-codex-reverify-log0074.md`.

## LOG-0074 remediation status

- The regression was isolated to diagnostic execution policy: managed Python and Java shared the submission-style 3,000 ms and 5,000 ms wall budgets, which the native executor enforces exactly. `diagnostic_wall_time_ms()` now retains 3,000 ms for compiled diagnostics and 5,000 ms for Scratch, while assigning only managed Python 10,000 ms and Java 15,000 ms cold-start headroom. Submission runner limits, runtime selection, sandbox grants, process/thread caps, and continue-and-aggregate behavior are unchanged.
- RED: the new policy regression test failed to compile before the helper existed. GREEN: `managed_runtime_diagnostics_have_cold_start_headroom` passed, and the focused six-profile diagnostic test passed 7/7 in 22.16 s.
- Windows verification passed: remediation Rust gate 9/9; non-enclosed structural/mutation tests 7/7; expected-skip, runtime invariant, scoring boundary, and entry-point checks all passed. One enclosing `npm run check:full` passed fast/quality, Rust 9/9, server 658 pass / 10 registered skips, four-tier parity 67/67, and version lockstep 1.5.1. Logs are in `artifacts/wp0.5/remediation-log0074/`.
- Host audit is clean: `host-comparison.json` reports `AllEqual=true` and `OwnedStateClean=true`, with zero AppData additions/removals/changes, reparse points, owned-process leaks, temporary-root leaks, or new Defender detections.
- Historical LOG-0074 archive macOS gate was **NOT RUN** while Tailscale was unavailable. It is superseded by the v3 exact-archive macOS evidence below; only v3 is the `VERIFYING` candidate.

## LOG-0074 Source-Closure Candidate v3

- Canonical freeze structural coverage now requires `.nvmrc`, `rust-toolchain.toml`, `sea-config.json`, `server-bootstrap.ts`, and `server.ts`; structural gates pass 8/8.
- Candidate archive: `artifacts/wp0.5/remediation-log0074-source-closure-candidate-v3/judgedesk-wp05-log0074-source-closure-candidate-v3.tar.gz`, 42,895,790 bytes, SHA-256 `CAEAB55444F3504A6E41FFE429F99B5CA6165A8AD463922F019242E6557C9F5F`, with 3,131 freeze records/members and 0 post-Windows revalidation mismatches.
- One enclosing Windows `npm run check:full` passed fast quality, Rust 9/9, server 659 pass / 10 registered skips, parity 67/67, and version lockstep 1.5.1.
- Exact archive macOS evidence confirms `npm ci --ignore-scripts`, ARM64 executor/server builds, `lipo` ARM64 verification, and `node scripts/run-rust-gates.js --json` exit 0 with all 9 steps passing.
- Host audit is truthful: `OwnedStateClean=true`; AppData, semantic state, owned processes, temp roots, and Defender are clean. `AllEqual=false` only because four pre-existing Antigravity IDE/language-server listeners disappeared during the interval; raw before/after data is retained.
- Status: **VERIFYING** for fresh Codex review under `prompts/wp0.5-codex-reverify-log0074.md`.

## Independent re-verification LOG-0077

- **Verdict: IN_PROGRESS.** No implementation source, package script, CI workflow, test, version file, accepted WP0.1–WP0.4 boundary, reset/stash/clean, commit, or push was changed by the reviewer.
- **Intake passed:** all 3,131 working-tree freeze records match on content SHA-256, size, and UTC mtime tick. Archive size/hash/member count match the v3 claim. Direct TAR/PAX parsing (rather than Windows `tar.exe` console output) finds 3,131 file entries with zero missing paths, zero extras, and zero per-member content-hash mismatches. A console-codepage false positive during review was rejected and left no ledger change.
- **Independent non-final checks passed:** focused `toolchain_diagnose_test` passed all seven tests, including independently named managed Python and Java profiles; expected-skip, runtime-invariant, scoring-boundary, and entry-point graph validators passed; structural gates passed 8/8 and exercised bounded timeout/output handling plus continue-and-aggregate failure behavior. Raw host snapshots preserve the four disappeared `127.0.0.1` listeners (ports 59496–59499) while all owned-state categories are clean; this does not override functional results.
- **Decisive final-gate failure:** the one enclosing Windows `npm run check:full` passed fast quality and Rust 9/9, then failed in `test:server`. `server/test-fixtures/corpus/corpus.test.ts` case `c_mle_stdio` expected compilation `OK` but received `COMPILER_TIMEOUT`; the suite result was 658 pass, 1 fail, 10 registered skips. Because `check:full` composes commands with `&&`, Themis parity and version-lockstep children did not execute. The post-gate freeze revalidation still has zero mismatches.
- **Required next action:** remediate only under `prompts/wp0.5-antigravity-remediate-log0077.md`, re-freeze one new candidate, and hand it to a fresh re-review under `prompts/wp0.5-codex-reverify-log0077.md`. A new macOS gate is ineligible until a replacement candidate passes its single enclosing Windows gate.

## LOG-0078 remediation candidate

- **Root cause and fix:** production prewarm previously considered only C++ requirements. Managed C submissions therefore paid the cold-start cost during the first real C compile and could hit the existing 60-second compiler watchdog. `nativeCompilerKindsToPrewarm()` now selects required native kinds in deterministic `[cpp, c]` order; `executeJudgePrewarm()` resolves, validates, prepares and no-op compiles managed C alongside existing C++ preparation. Windows prewarm skips toolchains that are not execution-ready or are outside the managed sandbox root. `runJudgeSession()` triggers prewarm for C submissions and C/C++ checkers. No compiler watchdog, sandbox/resource limit, fallback, or diagnostic policy was widened.
- **Regression/TDD evidence:** `server/judge/background-prewarm.regression.test.ts` was RED before the export existed and is GREEN with 2/2 tests. The compiler watchdog regression passes; the isolated corpus oracle passes all expectations including `c_mle_stdio` (compile OK, runtime MLE). The sequential full server suite passes 661/0/10.
- **Compiler/executor diagnostic:** `compiler-diagnostic-log0077.json` records managed GCC 14.2.0 at the protected ThemisV2 toolchain path; the custom C argv begins `-std=c11 -O0 -pipe` and retains static/stack/math protections; compiler wall time is 15,000 ms, memory is 1 GiB, and source/output/diagnostics remain inside the executor workspace. The observed focused result is compile `OK`, then runtime MLE.
- **Focused commands:** `npx tsc --noEmit --pretty false`; `npm run check:fast`; `node --import tsx --test server/judge/background-prewarm.regression.test.ts`; `node --import tsx --test server/judge/compiler.test.ts --test-name-pattern="compiler watchdog terminates a stuck compiler"`; and the isolated corpus command all pass.
- **Fresh source identity:** `artifacts/wp0.5/remediation-log0077/source-freeze-log0077.json` contains 3,132 records. `artifacts/wp0.5/remediation-log0077/judgedesk-wp05-log0077-source.tar.gz` is 42,898,854 bytes with SHA-256 `72C8F2431D8E001EB709A8DC10CC4F9B56719B20C08481E8DCEE4378C9EF5F44`. Independent post-gate verification recomputes every source content/size/mtime record and every extracted archive member path/content hash: 3,132/3,132, zero mismatches (`freeze-archive-verification.json`).
- **Windows final gate:** exactly one enclosing `npm run check:full` ran after the fresh pre-snapshot and exited 0. The log records quality invariants clean, Rust gates 9/9, server 661 passed / 0 failed / 10 registered skips, Themis parity 67/67, and version lockstep 1.5.1 (`artifacts/wp0.5/remediation-log0077/check-full-windows.log`).
- **Live macOS gate:** the exact archive was transferred to `judgedesk-mac` (Apple Silicon identity in `artifacts/wp0.5/remediation-log0077/macos-identity.log`), extracted cleanly, installed with `npm ci --ignore-scripts`, passed the quality gate, built ARM64 executor/server sidecars, passed both `lipo -verify_arch arm64` checks, and passed the same Rust gate 9/9 (`artifacts/wp0.5/remediation-log0077/macos-gate.log`). Remote archive/workspace cleanup was verified.
- **Owned-host evidence:** fresh before/after snapshots around the single Windows gate compare `AllEqual=true` and `OwnedStateClean=true`. ThemisV2 has 18,556 unchanged entries; JudgeDeskExecutor has 22,766 unchanged entries; zero AppData additions/removals/changes, reparse points, owned-process leaks, temp-root leaks, or new Defender detections (`artifacts/wp0.5/remediation-log0077/host-comparison.json`).
- **Handoff:** implementation owner stopped editing. WP0.5 is `VERIFYING` for fresh Codex review under `prompts/wp0.5-codex-reverify-log0077.md`; WP0.6, WP0.7 and G0 remain closed.

## Independent re-verification LOG-0079

- **Verdict: IN_PROGRESS.** The LOG-0078 candidate is rejected. The reviewer did not modify implementation, tests, scripts, workflows, version files, dependencies, git state, or candidate artifacts.
- **Intake passed:** all 3,132 source-freeze records match SHA-256, byte size, and UTC mtime ticks. The archive is 42,898,854 bytes, hashes to `72C8F2431D8E001EB709A8DC10CC4F9B56719B20C08481E8DCEE4378C9EF5F44`, and direct .NET TAR stream parsing verifies 3,132 normalized regular-file paths with zero duplicate, missing, extra, unsafe, size, or content-hash mismatches. Post-probe source revalidation remains 3,132/3,132 with zero mismatches.
- **Decisive precondition failure:** `node scripts/run-all-tests.js --filter=corpus` reached `c_mle_stdio`, then failed after 115,547 ms: expected compiler status `OK`, actual `CE / COMPILER_TIMEOUT`. The invocation reported 13 passing and 1 failing test. The submitted prior Windows/macOS gates do not override this direct reproduction.
- **Not run:** remaining A–J preconditions, a new enclosing Windows `npm run check:full`, and a live macOS gate. The failure is sufficient to make those gates ineligible. `runJudgeSession()`-scoped C prewarm versus the corpus oracle's direct `compileSubmission()` call is a remediation hypothesis to test, not an accepted root cause.
- **Required next action:** remediate only under `prompts/wp0.5-antigravity-remediate-log0079.md`, submit one new frozen `VERIFYING` candidate, and hand it to a fresh review under `prompts/wp0.5-codex-reverify-log0079.md`. WP0.6, WP0.7, and G0 remain closed.

## LOG-0080 remediation candidate

- `compileSubmission()` now warms the receipt-pinned managed C compiler directly with JudgeDesk-owned source before its first Windows managed-C submission. The student invocation still uses the 15-second compiler watchdog and unchanged executor limits, isolation and fail-closed behavior.
- Focused direct-path and stuck-watchdog tests pass; the corpus oracle exits 0 with `c_mle_stdio` compile OK then runtime MLE. All seven diagnostics, including managed Python and Java, pass.
- New freeze/archive: 3,132 records/members, 42,899,386 bytes, SHA-256 `6CD5F45944B46785979F306469090C3A865DE75ACA808ED1A7612E7E68124F77`, with zero pre/post-Windows source or archive mismatches.
- One Windows `npm run check:full` exits 0; host comparison is `AllEqual=true`, `OwnedStateClean=true`. The exact archive passes live macOS quality, ARM64 builds, architecture checks and Rust 9/9 in 190,721 ms; remote cleanup is verified. An initial `lipo` argument-order command failed before Rust ran and is preserved separately; the corrected retry used the same extracted archive.
- WP0.5 is `VERIFYING` for fresh Codex review under `prompts/wp0.5-codex-reverify-log0079.md`.

## Independent re-verification LOG-0081

- **Verdict: IN_PROGRESS.** The reviewer did not modify implementation, tests, scripts, workflows, versions, dependencies, or the frozen candidate source. Two next-round WP0.5 handoff prompts were created.
- **Intake passed independently:** all 3,132 frozen working-tree records match SHA-256, bytes and UTC mtime ticks. Direct gzip/TAR stream parsing finds exactly 3,132 normalized regular files, with no unsafe/duplicate/missing/extra paths and no content or size mismatch. Archive identity is 42,899,386 bytes, SHA-256 `6CD5F45944B46785979F306469090C3A865DE75ACA808ED1A7612E7E68124F77`.
- **Functional preconditions passed:** the direct corpus exits 0 (14/14, 149,272 ms) and records `c_mle_stdio` as runtime `MLE` after successful compilation; the compiler watchdog passes; all seven toolchain diagnostic tests pass, including independently reported managed Python and Java. Expected-skips, runtime/scoring boundaries, entry-point graph, bounded timeout/output structural regressions, and raw owned-host snapshots pass.
- **Release-blocking gap:** `crates/judgedesk-core/tests/toolchain_diagnose_test.rs` has six success-only individual tests and an orchestrator that only asserts success after iterating. It never induces a real profile failure. The candidate consequently does not prove a genuine failed diagnostic leaves later profiles attempted and separately reported, then returns an aggregate nonzero result.
- **Not run:** a new enclosing Windows `npm run check:full` and a live macOS gate are ineligible. Historical LOG-0080 final-gate logs remain historical evidence only.
- **Required next action:** remediate only under `prompts/wp0.5-antigravity-remediate-log0081.md`, freeze one new `VERIFYING` candidate, and hand it to a fresh review under `prompts/wp0.5-codex-reverify-log0081.md`.

## LOG-0082 remediation candidate

- **Regression:** `test_genuine_toolchain_diagnostics_orchestrator_continues_after_profile_failure` uses an isolated `OwnedTestEnvironment`, copies the test Rust compiler into that owned root, selects it only for the supported `c` local-path source mode, and exercises every HTTP diagnostic endpoint in authoritative order. The real compiler phase returns a named `c` compilation failure with its diagnostic; `cpp`, `python`, `pascal`, `java`, and `scratch` remain independently reported; exactly one profile fails; and the expected aggregate exit is nonzero. The focused RED run failed because all rows succeeded without the injected state; GREEN passed after the owned route-state injection. No production limits, fallback policy, host toolchain, or dependency changed.
- **Focused verification:** all 8 diagnostic tests pass serially; the corpus suite passes 14/14 with `c_mle_stdio` compiling `OK` and reaching runtime `MLE`; compiler watchdog coverage passes; expected-skips, runtime invariants, scoring boundary, entry-point graph, and structural gates pass; `npm run test:rust -- --json` passes all 9 steps.
- **Windows final gate:** exactly one enclosing `npm run check:full` exits 0. The log records fast quality, Rust 9/9, server 662 pass / 0 fail / 10 registered skips, Themis parity 67/67, and version lockstep 1.5.1.
- **macOS final gate:** the exact frozen archive is transferred to `judgedesk-mac`; `npm ci --ignore-scripts`, quality, ARM64 executor/server builds, and Rust 9/9 pass. The remote archive/workspace is removed and verified absent. Host identity and the frozen archive hash are recorded in `artifacts/wp0.5/remediation-log0081/macos-identity.log`.
- **Freeze/archive:** `source-freeze-log0081.json` and `judgedesk-wp05-log0081-source.tar.gz` contain 3,132 inputs/members. Independent pre/post-gate verification has zero source or archive mismatches; archive size is 42,898,302 bytes and SHA-256 is `412FAE3E7DB653238BA91651893C9D976F23731DABFB3CA47D4B7674DA2EDE03`.
- **Host audit:** `OwnedStateClean=true`, zero protected AppData deltas, semantic deltas, reparse points, owned process/temp-root leaks, and new Defender detections. `AllEqual=false` is retained because the Defender event-list hash changed as its rolling two-day window advanced.
- **Handoff:** implementation owner stopped editing. STATUS, WORKLOG, this report, artifacts, and `prompts/wp0.5-codex-reverify-log0081.md` identify this single LOG-0082 `VERIFYING` candidate. WP0.6, WP0.7, and G0 remain closed.

## Independent re-verification LOG-0083

- **Current verdict: IN_PROGRESS.** LOG-0082 is rejected. Frozen source/archive intake independently passes 3,132/3,132 with zero hash/size/mtime/member-path errors; post-probe intake remains clean. Implementation and candidate artifacts were preserved.
- **Checks:** diagnostics 8/8, isolated expected-failure test 1/1, watchdog 1/1, fast quality, skip/runtime/scoring/entry-point validators and structural mutations 8/8 pass. Concurrent corpus run failed c_mle_stdio with COMPILER_TIMEOUT; sequential rerun passes 14/14 with compile OK/runtime MLE. Both logs retained; no root cause is inferred.
- **Matrix F FAIL:** the genuine-failure test does not emit its six in-memory rows or real C diagnostic and computes only a test-local aggregate flag. It does not use the success orchestrator's reporting/aggregate path. The copied PATH rustc is a rustup proxy renamed invalid-c-compiler; independent owned probe returns unknown proxy name before source compilation. A passing regression does not prove the specified reporting/nonzero runner contract.
- **A–J limits:** current structural/validator checks and caller audit are recorded; full Rust/server and destructive compiler-backed mutation reruns were not claimed. No new enclosing Windows check:full or byte-identical live macOS gate ran because F failed. Candidate-owner raw host records independently match except eight old Defender events removed from the rolling window; these are not fresh review before/after snapshots.
- **Evidence and next action:** `artifacts/wp0.5/independent-review-log0083-codex-20260930/review.md`; remediate only under `prompts/wp0.5-antigravity-remediate-log0083.md`, then freeze a new VERIFYING candidate for `prompts/wp0.5-codex-reverify-log0083.md`. WP0.6/WP0.7/G0 remain closed. Earlier owner PASS claims above are historical and superseded by this verdict.

## LOG-0084 authorized remediation and self-review

Mon authorized Codex to remediate and self-review until WP0.5 DONE, declined different-model review, and authorized pausing after Windows work until Mac is online. This does not waive the live macOS gate. Current verdict is VERIFYING.

Both diagnostic scenarios now share one ordered HTTP validation/report/aggregate path. All six rows and actual C compilation diagnostics are emitted; success returns exit_code 0, the owned real C header failure returns exit_code 1, and later Python/Pascal/Java/Scratch rows pass independently. No renamed compiler/proxy is used. Explicit HTTP/native shutdown and environment restoration are verified. Diagnostics pass 8/8.

Tracing also found trusted preparation time incorrectly deducted from the native compile/link budget. The pipeline now subtracts validated native wallTimeUs only. Actual pipeline regression and watchdog tests pass; all shared callers were audited. The tracked C/C++ recipe had a 60-second request despite the documented 15-second watchdog; it now requests 15 seconds. No ceiling was widened. Corpus after repair passes 14/14 with c_mle_stdio compile OK/runtime MLE.

Structural tests pass 8/8; skip/runtime/scoring/entry-point mutation validators and real compiler-backed mutants pass. The synthetic constant assertion also correctly trips Clippy. A stale Cargo mutation binary caused the first Windows enclosure to fail after byte/mtime restoration; its log remains preserved. A forced clean-source rebuild passes the two real core lib tests, and the evidence harness now rebuilds before restoring frozen mtime. This failure is not represented as PASS or hidden by a skipped/deleted test.

Candidate: 3,132 source records/members, archive 42,899,125 bytes, SHA-256 `583BD30F3FCA3A0900351E35CAD978B62339163EBD27C8EF7F2C5B33A28D9234`. Direct stream intake has zero source hash/size/mtime or archive member errors, including after cache repair. Final clean-cache Windows enclosure and raw host comparison are retained in the current evidence directory. The snapshot timing limitation (recursive captures overlap gate activity) is disclosed in review.md. Live macOS evidence is pending; old macOS logs cannot satisfy this candidate. Versions remain 1.5.1; WP0.6/WP0.7/G0 stay closed.

Final Windows check:full PASS: Rust 9/9, server 664 pass / 0 fail / 10 registered skips, four-tier parity 67/67, version 1.5.1. Post-gate intake matches all 3,132 files. Host comparison OwnedStateClean=true with zero protected AppData changes/leaks/new threats; AllEqual=false only for completed test processes and cleaned test-owned roots (exact raw deltas retained). Windows work is complete. Pause until Mon reports Mac online, then run the exact-archive gate and verify remote cleanup under resume-macos.md. Status remains VERIFYING.

## LOG-0084 final acceptance — WP0.5 DONE

Mon reported Mac online and the same immutable archive completed live macOS verification. Quality, executor/server builds and both ARM64 checks pass. Platform diagnostics pass 8/8 in 32.40 s, emitting the genuine C owned-header compilation failure, all later profile successes and shared aggregate exit_code 1. The full sequential Rust gate passes 9/9 with zero skips/timeouts/output overflows in 180,660 ms. Every extracted frozen input matches before and after (3,132/3,132); final local archive/content/size/mtime intake remains unchanged.

Current evidence: `macos-identity.log`, `macos-diagnostics.log`, `macos-rust-gate.log`, `macos-evidence-verification.json`, `macos-source-pre.json`, `macos-source-post.json`, `macos-cleanup.json`, `intake-macos-post.json` and `completion-summary.json` under the LOG-0084 artifact directory. The initial lipo argument-order failure was corrected before Rust on the same source; its log is preserved. The evidence parser initially expected null for optional metrics omitted by serde; corrected explicit absence assertions validate the production contract, with no candidate-source/test change.

Remote cleanup verifies the physical absolute owned root and marker before removal, then confirms the root absent and zero owned processes after 15 seconds. Windows snapshot timing limitations remain documented; its protected-state equality and final cleanup pass. A–J and multi-axis self-review are accepted under Mon's explicit same-session authority; different-model review was declined. **WP0.5 DONE**, version lockstep 1.5.1. No later package or G0 was opened and no dependency/commit/push was added.
