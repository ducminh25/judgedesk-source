# Prompt — fresh Codex review of WP0.4 after LOG-0061 remediation

You are the independent verifier for JudgeDesk WP0.4. Begin only after Antigravity has completed remediation of LOG-0060, reconciled STATUS/WORKLOG/report/ADR, and submitted a new frozen `VERIFYING` handoff. Use a fresh Codex conversation in the saved dirty checkout `D:/Minh/Code/judgedesk`. Do not create a worktree, reset/stash/clean, commit/push, edit implementation to self-accept, change version, close G0, or start WP0.5.

Read the current project protocol, `guidelines.md`, `CONSTRAINTS.md`, implementation plan and efficient-execution protocol, STATUS/WORKLOG, ADR 0001, WP0.4 report Section 10, LOG-0060 findings, and the remediation evidence under `artifacts/wp0.4/remediation-log0061-antigravity-20260927/`. Treat previous submitter gate output as claims until its provenance and exact source identity are reproduced. Derive the next actual LOG ID from the append-only WORKLOG; do not assume the number.

## Intake and source freeze

1. Require synchronized `VERIFYING` state in STATUS, WORKLOG, report Section 10, ADR 0001, and source identity. Confirm the saved checkout and all existing dirty work are preserved.
2. Freeze and compare all production, test, build, packaging and staged executable inputs to the submission's SHA-256, size and UTC mtimes (`artifacts/wp0.4/remediation-log0061-antigravity-20260927/source-freeze-log0061.json`). Compare the accepted WP0.3 baseline. Observe semantically coupled source identities throughout the review and invalidate dependent evidence on change.
3. Before any build/runtime/stateful command, take complete owned-root snapshots of `C:/Users/mon/AppData/Local/ThemisV2` and `C:/Users/mon/AppData/Local/JudgeDesk/JudgeDeskExecutor`, including per-entry path/type/size/SHA-256, aggregate, semantic state, process/port inventories, owned temp roots and security state. Verify owner and containment; preserve existing roots. Repeat after 5–10 seconds of final observation. Snapshot helpers must preserve empty arrays.

## Required adversarial verification

- **F5:** Trace production call graphs and feature gates. Search all `unwrap()`/`expect()` uses in core and native executor and classify test-only/helper/runtime paths. Directly verify the poisoned mutex recovery regression test (`native-executor/src/main.rs: tests::poisoned_mutex_synchronization_does_not_panic`) and prove there is no actionable production runtime panic path.
- **F4 cancellation/drain:** Launch a valid guarded packaged executor, exercise a real accepted and active native run (e.g. `crates/judgedesk-core/tests/executor_boundary_test.rs: cancel_covers_reserved_and_active_runs`), cancel, and demonstrate that response completion follows verified worker/process-tree drainage.
- **F4 updater:** Prove exclusive updater lock contention against a live executor holding the real shared generation lock (`updater_exclusive_handoff_waits_for_native_tree`), with release and reacquisition evidence. Cover applicable platforms.
- **F4 Node rollback:** Exercise the actual Node rollback client and compatible staged executor (`node_rollback_reaches_compatible_executor`, `node_rollback_client_generation_contention`), and establish shared protocol/readiness and mutual generation ownership with the Rust client.
- **F4 protocol failure:** Ensure malformed/truncated/oversized/unknown responses are sent only after valid guarded startup and readiness (`protocol_failure_drains_before_replacement`). Verify terminal admission closure, pending request completion, tree reap and clean replacement startup.
- Reconcile test names and claims against their assertions across the 21 dedicated boundary tests in `crates/judgedesk-core/tests/executor_boundary_test.rs`. Maintain the full (a)-(j) matrix and clearly mark PASS/PARTIAL/FAIL/NOT_RUN. Windows results alone do not prove macOS behavior.
- Run focused probes before broad Rust/Node gates. Stop expensive gates once an actionable defect is decisive under the efficient-execution protocol. Never turn NOT_RUN or submitter-only output into reviewer PASS.

## Verdict and handoff

Use exactly one evidence-backed verdict: `DONE` only when every WP0.4 exit criterion is independently proven; `IN_PROGRESS` when an actionable defect or missing required proof remains; `BLOCKED` only for a genuine external prerequisite. Update STATUS, WP0.4 report, ADR 0001 and append the actual LOG entry to WORKLOG. On `IN_PROGRESS`, create the next English Antigravity remediation prompt and fresh-Codex review prompt. On `DONE`, do not begin WP0.5 without its separately authorized handoff. Preserve every earlier log and evidence artifact. Stop after recording the report and handoff.
