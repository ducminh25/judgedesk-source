# Neutral Independent Reviewer Prompt — Macro-Milestone 1 (`M1`: `WP0.6` $\rightarrow$ `G5`)

> **Prepared for human dispatch only (after `M1` reaches `VERIFYING`).** File existence does not authorize execution.
> **Workflow Protocol:** Streamlined High-Rigor 4-Macro-Milestone Protocol (2026-10-17 Adopted Revision in [`docs/pure-rust-core-efficient-execution.md`](../../../pure-rust-core-efficient-execution.md) and [`docs/pure-rust-core-review-workflow.md`](../../../pure-rust-core-review-workflow.md)).

Independently review and accept or reject **Macro-Milestone 1 (`M1`: `WP0.6` $\rightarrow$ `G5` — Core Judging, Security, Toolchains, Batch & Interactive Semantics)** in fresh context on Windows (`D:\Minh\Code\judgedesk`) and live Apple Silicon macOS (`judgedesk-mac`).

## 1. Intake & 1-to-1 `WP*` Traceability Audit

1. Read [`AGENTS.md`](../../../../AGENTS.md), [`guidelines.md`](../../../../guidelines.md), [`CONSTRAINTS.md`](../../../../CONSTRAINTS.md), [`docs/pure-rust-core-detailed-implementation-plan.md`](../../../pure-rust-core-detailed-implementation-plan.md), [`docs/pure-rust-core-efficient-execution.md`](../../../pure-rust-core-efficient-execution.md), [`docs/pure-rust-core-review-workflow.md`](../../../pure-rust-core-review-workflow.md), [`STATUS.md`](../STATUS.md), and `docs/verification/pure-rust-core/m1-core-judging-and-toolchains-gate.md`.
2. Verify `evidence-final-manifest.json` programmatically.
3. Audit the **1-to-1 `WP*` Traceability Matrix** in `m1-core-judging-and-toolchains-gate.md`: every work package and phase gate in `M1` (`WP0.6`, `WP0.7`, `G0`, `WP1.1–1.7`, `G1`, `WP2.1–2.7`, `G2`, `N1`, `WP3.1–3.3`, `G3`, `WP4.1–4.5`, `G4`, `WP5.1–5.4`, `G5`) must map to real production Rust symbols and falsifiable tests with zero stubs or silent skips.

## 2. Five-Axis Code Review & Dual-Host Milestone Verification

1. Conduct a 5-axis adversarial review (`Correctness`, `Readability & Simplicity`, `Architecture`, `Security`, `Performance`) across all `M1` changes:
   - Verify `ProblemCompileConfig` validation/normalization and compiler flag wiring,
   - Verify end-to-end `Rational` (`BigUint`) scoring without `f64` drift, `totalScore` scaling, and `JE = 0` scoring rules,
   - Verify per-`jobId` cancellation isolation, HTTP `500` on unconfirmed cancel, `X-JudgeDesk-Job-Id`, and SSE event ordering,
   - Verify `FreezeRequired` toolchain snapshot integrity and real `rescan`/install/uninstall/certify behavior,
   - Confirm zero host `Command::new` escapes for untrusted compilation/checkers/submissions and zero `unwrap()`/`expect()` in runtime server/executor paths.
2. Execute the independent `M1` verification union on both hosts (`Windows x64` and `macOS arm64` on `judgedesk-mac`), reusing persistent incremental `target/` caches:
   - `npm run check:fast`
   - `npm run test:rust` (`cargo test --locked` + `cargo clippy --all-targets -- -D warnings`)
   - `npm run check:full` and `npm run test:security`
   - Verify `before`/`after` protected-state equality and immediate + 10s delayed zero owned runtime processes.

## 3. Verdict & Ledger Transition

- Record all review outputs and SHA-256 digests in `docs/verification/pure-rust-core/artifacts/m1/<reviewer-round-id>/evidence-manifest.json` and `verdict.json` (zero prose `(bytes, sha256)` tuples in Markdown).
- If all `M1` requirements pass:
  - Transition all 29 `WP*` packages (`WP0.6`, `WP0.7`, `WP1.1–1.7`, `WP2.1–2.7`, `N1`, `WP3.1–3.3`, `WP4.1–4.5`, `WP5.1–5.4`) and 6 phase gates (`G0`–`G5`) to **`DONE`** in [`STATUS.md`](../STATUS.md) (`Package progress: 35 / 51 DONE`, `Phase gates: 6 / 11 DONE`),
  - Mark **Macro-Milestone 2 (`M2`: `WP6.1a` $\rightarrow$ `G6`)** as `READY` in `STATUS.md`,
  - Append a concise summary to [`WORKLOG.md`](../WORKLOG.md) (`Append: true`).
- If any requirement fails, return the affected items to `IN_PROGRESS` with concrete findings and next-round prompts.
