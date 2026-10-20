# Neutral Next-Round Independent Reviewer Prompt — N0 Bounded Review (`N0-C10-GATE-R1` Scoped Re-verification)

> **Prepared for human dispatch only.** File existence does not authorize execution.
> **Workflow Protocol:** Streamlined High-Rigor Protocol (2026-10-17 Adopted Revision in [`docs/pure-rust-core-efficient-execution.md`](../../../pure-rust-core-efficient-execution.md) and [`docs/pure-rust-core-review-workflow.md`](../../../pure-rust-core-review-workflow.md)): **Scoped Re-verification + Persistent Incremental Build Caches + JSON-Only Hash Binding**.

Independently review and accept or reject **`N0: Mac native interactive baseline prerequisite`** in fresh context on Windows (`D:\Minh\Code\judgedesk`) and live Apple Silicon macOS (`judgedesk-mac`) under the 2026-10-17 Adopted Streamlined High-Rigor Workflow.

## 1. Mandatory Reading & Intake

1. Read [`AGENTS.md`](../../../../AGENTS.md), [`guidelines.md`](../../../../guidelines.md), [`CONSTRAINTS.md`](../../../../CONSTRAINTS.md), [`docs/pure-rust-core-efficient-execution.md`](../../../pure-rust-core-efficient-execution.md), [`docs/pure-rust-core-review-workflow.md`](../../../pure-rust-core-review-workflow.md), [`docs/verification/pure-rust-core/STATUS.md`](../STATUS.md), and the latest entry in [`docs/verification/pure-rust-core/WORKLOG.md`](../WORKLOG.md).
2. Verify that `STATUS.md` is in state `VERIFYING` for `N0` and points to the remediator's sealed round directory (`evidence-final-manifest.json`, `command-coverage.json`, `finding-disposition.json`).
3. Verify the JSON manifest hashes programmatically (`evidence-final-manifest.json`) without modifying any historical artifact directory.

## 2. Five-Axis Code Review & Scoped Independent Verification

1. **Five-Axis Code Review (`Correctness`, `Readability & Simplicity`, `Architecture`, `Security`, `Performance`):**
   - Inspect the exact `git diff` against `final-source-10` (`artifacts/n0/antigravity-remediator-20261016T170225Z/final-source-10`).
   - Verify that the `N0-C10-GATE-R1` fix preserves ADR-0001 generation-guard and executor-owner lease invariants, does not weaken sandbox/guardian containment, and introduces zero panics (`unwrap`/`expect`) in production paths.
2. **Scoped Independent Execution (No Redundant Unrelated Suite Re-runs):**
   - **Windows x64:** Run `npm run check:fast` and `cargo test --locked --manifest-path native-executor/Cargo.toml` (if `native-executor` changed).
   - **macOS arm64 (`judgedesk-mac`):**
     - Run `npm run check:fast` and `cargo test --locked --manifest-path native-executor/Cargo.toml` (plus `npm run test:N0:focused-union` if `native-executor/src/*` changed).
     - Build/verify the signed `.app` (`npm run build:macos:core:local` + `codesign --verify --deep --strict --verbose=2`).
     - Independently execute `npm run test:macos-process-supervisor` (at least `3/3` consecutive runs) and `scripts/macos-packaged-checkers-smoke.sh`.
   - **Retained Independent Evidence (`evidenceMode: reference`):**
     - If the file diff is strictly confined to the `N0-C10-GATE-R1` scope, retain your prior independent PASS results from `codex-independent-review-20261017T054000Z` / `codex-review-closure-20261017T065802Z` (`N0-C09-GATE-R1` `74/74` focused union, `91/91` production, Windows `948/958` & Mac `950/958` `test:server`, `check:full`, `test:security`) by `evidenceMode: reference`.
3. **Protected-State & Cleanup Audit:**
   - Verify `before`/`after` equality of the Mac protected roots around the packaged `.app` supervisor/checker runs, verify immediate + 10s delayed zero owned runtime processes, and clean up temporary test directories.

## 3. Verdict & JSON-Only Hash Binding

- Write your review artifacts (`review.md`, `verdict.json`, `findings.json`, `command-coverage.json`, `evidence-manifest.json`) in `docs/verification/pure-rust-core/artifacts/n0/<reviewer-round-id>/`.
- **DO NOT embed `(bytes, sha256)` tuples in Markdown prose.**
- If all checks pass:
  - Transition **`N0` $\rightarrow$ `DONE`** in [`docs/verification/pure-rust-core/STATUS.md`](../STATUS.md) (`Package progress: 6 / 51 DONE`),
  - Mark **Macro-Milestone 1 (`M1`: `WP0.6` $\rightarrow$ `G5`)** as the next eligible milestone in `STATUS.md` pointing to [`prompts/m1-milestone-remediator-20261017.md`](m1-milestone-remediator-20261017.md),
  - Append a concise entry to [`docs/verification/pure-rust-core/WORKLOG.md`](../WORKLOG.md) (`Append: true`).
- If rejected, return `N0` to `IN_PROGRESS` with concrete findings and streamlined next-round prompts. Never edit product/test code, commit, push, or auto-dispatch chats.
