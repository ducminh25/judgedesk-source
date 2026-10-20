# Neutral Next-Round Remediator Prompt — N0 Bounded Remediation (`N0-C10-GATE-R1` Scoped Re-verification)

> **Prepared for human dispatch only.** File existence does not authorize execution.
> **Workflow Protocol:** Streamlined High-Rigor Protocol (2026-10-17 Adopted Revision in [`docs/pure-rust-core-efficient-execution.md`](../../../pure-rust-core-efficient-execution.md) and [`docs/pure-rust-core-review-workflow.md`](../../../pure-rust-core-review-workflow.md)): **Scoped Re-verification + Persistent Incremental Build Caches + JSON-Only Hash Binding**.

Execute bounded remediation for **`N0: Mac native interactive baseline prerequisite`** in `D:\Minh\Code\judgedesk` and on live Apple Silicon macOS (`judgedesk-mac`) under the 2026-10-17 Adopted Streamlined High-Rigor Workflow.

## 1. Mandatory Reading & Authority

Read these files first:
1. [`AGENTS.md`](../../../../AGENTS.md), [`guidelines.md`](../../../../guidelines.md), [`CONSTRAINTS.md`](../../../../CONSTRAINTS.md)
2. [`docs/pure-rust-core-efficient-execution.md`](../../../pure-rust-core-efficient-execution.md) and [`docs/pure-rust-core-review-workflow.md`](../../../pure-rust-core-review-workflow.md)
3. [`docs/verification/pure-rust-core/STATUS.md`](../STATUS.md) and the tail of [`docs/verification/pure-rust-core/WORKLOG.md`](../WORKLOG.md)
4. [`docs/verification/pure-rust-core/artifacts/n0/codex-review-closure-20261017T065802Z/closure-review.md`](../artifacts/n0/codex-review-closure-20261017T065802Z/closure-review.md) and [`findings.json`](../artifacts/n0/codex-review-closure-20261017T065802Z/findings.json)
5. [`scripts/macos-process-supervisor-gate.sh`](../../../../scripts/macos-process-supervisor-gate.sh), [`native-executor/src/main.rs`](../../../../native-executor/src/main.rs), and [`server/judge/background-prewarm.ts`](../../../../server/judge/background-prewarm.ts)

## 2. Exact Bounded Scope (`N0-C10-GATE-R1`)

- **Retained Independently Verified Baseline (`evidenceMode: reference`):**
  In `codex-independent-review-20261017T054000Z` + `codex-review-closure-20261017T065802Z`, Codex independently verified and closed:
  - `N0-C09-GATE-R1` (`74/74` Mac focused union PASS, `0` skips, including `"submission process quota remains independent of its peer"`),
  - Mac `check:fast`, `OSD 8/8`, `test:server` (`950/958` PASS, `8` skips), `harmless 23/23`, `logger falsifier`, `91-row production` (`92/92` + `1/1`), `check:full` (`9/9` Rust + `950/958` server), `test:security` (`17/20` PASS),
  - Windows `check:fast`, `OSD 8/8`, `test:server` (`948/958` PASS, `10` skips), and all 7 packet resolutions + compiler/OSD fixes.
- **Single Open Finding to Resolve (`N0-C10-GATE-R1`):**
  - During `npm run test:macos-process-supervisor` on `judgedesk-mac`, `scripts/macos-process-supervisor-gate.sh` (`lines 414–415`) failed with:
    `macOS process-supervisor gate failed: executor does not hold exactly one generation guard`
  - Post-failure `lsof` inspection showed executor PID `60115` holding two file descriptors (`3u` and `5u`) to the generation guard file (`generation-1.guard`) because `native-executor` opens a session-level `GenerationGuard` at startup (`main.rs`) and also opens a per-run `GenerationGuard` inside `handle_run_request` / `handle_run_interactive_request` (e.g. when background compiler prewarm or a run is active during the gate's 10-second `lsof` check window).
- **Root-Cause & Fix Requirements:**
  1. Passively inspect the preserved failure log in `artifacts/n0/codex-independent-review-20261017T054000Z/` / `codex-review-closure-20261017T065802Z/` and trace why two descriptors to `generation-1.guard` were open during `macos-process-supervisor-gate.sh` (and why the executor remained alive after the parent died if a run/guardian pipe kept stdin/stdout open or if per-run `GenerationGuard` duplicated the session guard).
  2. Formulate a minimal, fail-closed root-cause fix (following `.agents/skills/debugging-and-error-recovery/SKILL.md` and `.agents/skills/test-driven-development/SKILL.md`) that:
     - Preserves ADR-0001 exclusive executor-owner lease and generation-guard semantics through native drain,
     - Ensures `macos-process-supervisor-gate.sh` deterministically observes the exact expected generation-guard invariant and zero orphan processes (`executor`, `node`, `guardian`) after `SIGKILL` of the parent `.app`,
     - Does NOT weaken any sandbox, process-group drain, or generation-guard check.
  3. Write a focused deterministic regression test (`RED` $\rightarrow$ `GREEN`) and conduct a fresh-context 5-axis adversarial review (`doubt-driven-development` + `code-review-and-quality`).

## 3. Scoped Re-verification Matrix (No Redundant 90-Minute Re-runs)

Under the 2026-10-17 Adopted Scoped Re-verification Protocol, **reuse persistent incremental build caches** and execute **only**:
1. **Both Hosts (`Windows x64` & `macOS arm64`):**
   - `npm run check:fast`
   - `npm run test:rust` (or `cargo test --locked --manifest-path native-executor/Cargo.toml` + `cargo clippy --manifest-path native-executor/Cargo.toml --all-targets -- -D warnings`)
   - Refreeze `docs/reports/executor-freeze-2026-10-12.json` if `native-executor/src/*` changed.
2. **macOS (`judgedesk-mac`) Scoped Gate Union:**
   - Rebuild the signed local `.app` (`npm run build:macos:core:local` + `codesign --verify --deep --strict --verbose=2`),
   - Run `npm run test:macos-process-supervisor` across **5 consecutive repetitions (`5/5` PASS)** to prove zero intermittency,
   - Run the packaged checkers + port-rebind gate (`scripts/macos-packaged-checkers-smoke.sh`) to confirm packaged `.app` parity,
   - Run the focused native-executor/supervisor unit & integration tests (`npm run test:N0:focused-union` if `native-executor/src/*` was touched).
3. **Retained by Reference (`evidenceMode: reference`):**
   - Link Windows `test:server`, `check:full`, `test:security`, `build:windows:local`, `resource512/1024`, and Mac `test:server`, `91-row production`, `check:full`, `test:security` from `antigravity-remediator-20261016T170225Z` (`R10`) and `codex-review-closure-20261017T065802Z` (`V7`) with explicit file-diff justification showing those subsystems were not invalidated.
4. **Protected-State & Cleanup Verification:**
   - Because `build:macos:core:local` and `test:macos-process-supervisor` launch the packaged `.app`, verify `before`/`after` equality of the Mac protected roots (`/Users/mac/Library/Application Support/ThemisV2` and `$TMPDIR/JudgeDeskExecutor`) and verify immediate + 10s delayed zero owned runtime processes.

## 4. JSON-Only Hash Binding & Handoff Output

- **DO NOT write hardcoded `(bytes, sha256)` tuples in Markdown prose** (`n0-native-interactive-baseline.md`, `STATUS.md`, `WORKLOG.md`, or next prompts).
- Record all artifact sizes and SHA-256 digests exclusively in `docs/verification/pure-rust-core/artifacts/n0/<round-id>/evidence-final-manifest.json` and `command-coverage.json`.
- Update `docs/verification/pure-rust-core/n0-native-interactive-baseline.md`, synchronize `docs/verification/pure-rust-core/STATUS.md` (`N0 -> VERIFYING`), and append a concise summary to `docs/verification/pure-rust-core/WORKLOG.md` (`Append: true`, preserving all existing bytes).
- Do not self-accept (`DONE`), commit, push, or auto-dispatch any chat.
