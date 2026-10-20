# Neutral Remediator Prompt — Macro-Milestone 1 (`M1`: `WP0.6` $\rightarrow$ `G5`)

> **Prepared for human dispatch only (after `N0` reaches `DONE`).** File existence does not authorize execution.
> **Workflow Protocol:** Streamlined High-Rigor 4-Macro-Milestone Protocol (2026-10-17 Adopted Revision in [`docs/pure-rust-core-efficient-execution.md`](../../../pure-rust-core-efficient-execution.md) and [`docs/pure-rust-core-review-workflow.md`](../../../pure-rust-core-review-workflow.md)).

Execute **Macro-Milestone 1 (`M1`: `WP0.6` $\rightarrow$ `G5` — Core Judging, Security, Toolchains, Batch & Interactive Semantics)** in `D:\Minh\Code\judgedesk` and on live Apple Silicon macOS (`judgedesk-mac`).

## 1. Batched Work Packages & Gates in `M1`

- **Phase 0 Remainder:** `WP0.6`, `WP0.7`, `G0`
- **Phase 1 (Security & Boundaries):** `WP1.1`–`WP1.7`, `G1`
- **Phase 2 (Toolchains & Disk Services):** `WP2.1`–`WP2.7`, `G2`
- **Phase 3 (Sandboxed Compilers & 6-Language Runtime Adapters):** `N1`, `WP3.1`–`WP3.3`, `G3`
- **Phase 4 (Config Normalization, Job Registry, Cancellation & SSE Stream):** `WP4.1`–`WP4.5`, `G4`
- **Phase 5 (Exact Rational Scoring, Standard/Custom Checkers & Interactive Runner):** `WP5.1`–`WP5.4`, `G5`

## 2. Ordered TDD Implementation Sub-Slices (`RED` $\rightarrow$ `GREEN` $\rightarrow$ `Refactor`)

Consolidate the existing working-tree Phase A (`Bước 1–5`) implementation in `crates/judgedesk-core` (see [`docs/pure-rust-core-next-steps-audit.md`](../../../pure-rust-core-next-steps-audit.md)) and close every remaining `v1.5.5` parity gap across `WP0.6..G5` in 5 ordered TDD sub-slices:

1. **Sub-slice M1.1 (`WP0.6`, `WP0.7`, `G0`, `WP1.1–1.7`, `G1`):**
   - Revalidate version/build identity and lockfile policy (`WP0.6`) with eight-file app lockstep at `1.5.5` and `crates/judgedesk-core` at `1.5.1`.
   - Verify modular `server/` decomposition (`WP0.7`), `DesktopApiBoundary` (`WP1.2`), native folder dialog without script interpolation (`WP1.3`), `OwnedWorkspace` hostile-path containment (`WP1.6`), truthful `501` capability responses for unimplemented routes (`WP1.5`), and structured log redaction (`WP1.7`).
2. **Sub-slice M1.2 (`WP4.1`, `WP3.1–3.3`, `N1`, `G3` — `ProblemCompileConfig` & 6-Language Compiler/Runtime Closure):**
   - Implement `ProblemCompileConfig` (`schemaVersion: 1`, `profile: "themis" | "modern_ioi_icpc_2025" | "icpc_world_finals" | "custom"`, `flags: { cpp, c }`), `assert_safe_compile_flag`, and `normalize_problem_compile_config` matching [`shared/compile-config.ts`](../../../../shared/compile-config.ts).
   - Enforce `400 INVALID_COMPILE_CONFIG` on `POST /api/polygon-config`, normalize in `GET /api/polygon-config`, and wire `NormalizedProblemConfig.compile.flags` into `crates/judgedesk-core/src/engine/compiler.rs`.
3. **Sub-slice M1.3 (`WP1.4`, `WP5.1–5.4`, `G5` — End-to-End Exact `Rational` Pipeline, `totalScore` Scaling, `JE = 0`, Checkers & Interactive):**
   - Parse custom checker and interactor partial-score outputs directly into `Rational` (`BigUint`) with zero `f64` multiplier intermediate.
   - Add `scoreExact` and `maxScoreExact` to `ProblemSummary`.
   - Implement `totalScore` proportional test-case weight scaling ($\text{totalScore} \times \frac{w_i}{\sum w_j}$ when `enableGroups == false`) and enforce the `JE` zero-score rule (`compileStatus == "JE"` or any testcase `status == "JE"` forces `ProblemSummary.status = "JE"` and total score `0`).
4. **Sub-slice M1.4 (`WP4.2–4.5`, `G4` — Per-`jobId` Cancellation, Stream Ordering & Metadata):**
   - Bind active runs and cancellation strictly per `jobId` (cancelling an inactive `jobId` records only a tombstone for that `jobId` and never cancels another active job; unconfirmed native cancel returns HTTP `500`; validate `jobId <= 256` printable ASCII).
   - Emit `X-JudgeDesk-Job-Id` header on `POST /api/batch-judge`, emit `progress(progress.initializing)` before `metadata`, and enforce `isTextFile` input validation when `testWellFormed == false`.
5. **Sub-slice M1.5 (`WP2.1–2.7`, `G2` — Toolchain Lifecycle, `FreezeRequired` Wiring & Real `rescan`/Install/Certify):**
   - Wire `FreezeRequired` and snapshot/certificate integrity closure into `resolve_toolchain_for_profile` (including `$sig.Status -eq 'Valid'` on Windows Authenticode verification).
   - Implement real `POST /api/toolchains/rescan` (with active-judge `409` lock), `certification-plan`, `certify`, `install`, `uninstall`, legacy bundled toolchain dedup migration, and live `ToolchainStore` status in `GET /api/status`.

## 3. Verification, 1-to-1 `WP*` Traceability Matrix & Handoff

1. **Inner-Loop Speed:** Reuse persistent `target/` build caches on Windows and `/private/tmp/jd-rust-core-mac-dev` on `judgedesk-mac`.
2. **Adversarial Review:** Run a fresh-context 5-axis adversarial review across the `M1` diff and resolve all P0/P1/P2 findings.
3. **Milestone Gate Verification Union (Both Hosts — `Windows x64` & `macOS arm64`):**
   - `npm run check:fast`
   - `npm run test:rust` (`cargo test --locked` + `cargo clippy --all-targets -- -D warnings` across `crates/judgedesk-core`, `native-executor`, and `src-tauri`)
   - `npm run check:full` and `npm run test:security`
   - Verify `before`/`after` protected-root equality and zero orphan processes.
4. **Mandatory 1-to-1 `WP*` Traceability Matrix & JSON-Only Hash Binding:**
   - Write canonical report `docs/verification/pure-rust-core/m1-core-judging-and-toolchains-gate.md` containing a complete **1-to-1 `WP*` Traceability Matrix** (`WP0.6` through `G5` $\rightarrow$ `Rust File/Symbol` $\rightarrow$ `Test Name` $\rightarrow$ `Command Log`).
   - Record all artifact sizes and SHA-256 hashes exclusively in `docs/verification/pure-rust-core/artifacts/m1/<round-id>/evidence-final-manifest.json` (zero prose `(bytes, sha256)` tuples in Markdown).
   - Synchronize `STATUS.md` (`M1` packages $\rightarrow$ `VERIFYING`) and append to `WORKLOG.md` (`Append: true`).
