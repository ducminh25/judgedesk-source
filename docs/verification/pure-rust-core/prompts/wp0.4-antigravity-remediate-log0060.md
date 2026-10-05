# WP0.4-only remediation — LOG-0060 findings

You own remediation of the fresh independent WP0.4 review recorded in `docs/verification/pure-rust-core/wp0.4-executor-boundary.md` Section 9 and `artifacts/wp0.4/independent-review-log0060-codex-20260927/review-findings.md`.

## Scope and checkout rules

- Work only on WP0.4 findings F5 and the inaccurate/incomplete F4 lifecycle evidence. Do not start WP0.5, close G0, change application version, or broaden the migration.
- Use the saved dirty checkout `D:\Minh\Code\judgedesk` and preserve all existing product changes, LOG-0058/0059 evidence, accepted WP0.3 evidence, and reviewer artifacts. Do not reset, stash, clean, commit, push, or rewrite history.
- Keep application version `1.5.1` synchronized across the eight required version files.
- Do not remove the prior LOG-0058 `owned-runtime` directory or use it as a test root.

## Required remediation

1. **F5 production panic audit:** Trace every `unwrap()` and `expect()` in the normal production paths of `crates/judgedesk-core` and `native-executor`, including feature-gated platform paths. At minimum resolve the runtime hits identified at:
   - `native-executor/src/main.rs:436,499` (`accepted_runs.lock().unwrap()` in Run and InteractiveRun request handlers).
   - `native-executor/src/platform/mod.rs:123` and Windows runtime sites `platform/windows.rs:522,536,644,865,880,891,994`.
   - `crates/judgedesk-core/src/engine/session.rs:339` and `src/server/mod.rs:621,1564`.
   Classify test-only, unreachable helper, invariant-proven, and fallible runtime uses explicitly. Replace fallible runtime panics with controlled `Result` propagation/diagnostics consistent with AGENTS.md; do not suppress Clippy or weaken the invariant. Add focused regression coverage for poisoned/failed synchronization and malformed external input where applicable.

2. **F4 real lifecycle proofs:** Replace the current serialization-only/fixture-only assertions with tests that drive the real production boundary:
   - Start an executor with valid parent and generation guard; accept a native run, cancel it, and assert the response waits for the worker/process-tree drain barrier.
   - Hold a shared generation lock in a live executor and prove an updater's exclusive acquisition blocks, then succeeds after executor exit. Cover supported OS behavior or clearly scope the platform-specific contract and evidence.
   - Invoke the actual Node rollback client against the same staged compatible executor and generation lock, proving the expected wire schema/readiness and mutual exclusion with the Rust client.
   - Repair `protocol_failure_drains_before_replacement`: supply valid mandatory guard variables, prove readiness/request-loop entry before sending a truncated or malformed frame, then assert terminal admission closure, child reaping and no overlapping replacement. Do not allow startup rejection to satisfy the protocol assertion.
   - Reconcile every claimed boundary test name with the checked-in file. Remove nonexistent names and claims that exceed assertions; add direct assertions where the contract requires them.

3. **Evidence and submission:** First demonstrate RED against the submitted source, then GREEN after the fix. Run focused boundary tests followed by required Rust tests, all-target Clippy, Rust formatting checks, `npm run check:fast`, `npm run release:check-version`, `npm run test:themis-parity`, and `npm run check:full` as required by project policy. Obtain real macOS evidence for macOS-specific claims or mark it NOT_RUN without claiming cross-platform completion. Take complete before/after snapshots of both required AppData roots around stateful work, include delayed observation, temp roots, processes, ports and security state, and ensure helper output serializes empty arrays. Freeze all source/test/build/package inputs and executable identities before and after; invalidate results if relevant inputs change.

Update STATUS, WORKLOG, the WP0.4 report, and ADR 0001 truthfully. Do not self-accept. Set WP0.4 to a new formal `VERIFYING` handoff only when source and evidence are frozen and consistent; otherwise leave it `IN_PROGRESS`. Stop after handoff for fresh independent Codex review.
