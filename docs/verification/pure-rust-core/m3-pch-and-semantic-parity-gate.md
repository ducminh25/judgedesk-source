# Macro-Milestone 3 (`M3`: `WP7.1` $\rightarrow$ `G8`) — Universal PCH, Selective Prewarm & 100% Node-vs-Rust Semantic Parity Gate Report

- **Milestone ID:** `M3` (`WP7.1..G8` — 7 Work Packages + 2 Phase Exit Gates)
- **Candidate:** `m3-candidate01`
- **Remediation Round:** `antigravity-m3-remediator-20261019T013100Z`
- **Protocol Authority:** Streamlined High-Rigor 4-Macro-Milestone Protocol (2026-10-17 Adopted Revision in [`docs/pure-rust-core-efficient-execution.md`](../../pure-rust-core-efficient-execution.md) and [`docs/pure-rust-core-review-workflow.md`](../../pure-rust-core-review-workflow.md))
- **Application Version Lockstep:** `1.5.5` across all 8 application version files; `crates/judgedesk-core/Cargo.toml` at `1.5.1`
- **Artifact & Digest Binding:** Exclusively bound in [`artifacts/m3/antigravity-m3-remediator-20261019T013100Z/evidence-final-manifest.json`](artifacts/m3/antigravity-m3-remediator-20261019T013100Z/evidence-final-manifest.json) under the JSON-Only Hash Binding rule.

---

## 1. Executive Summary & Sub-Slice Closure

Macro-Milestone 3 (`M3`) delivers complete Pure Rust Core (`crates/judgedesk-core`) parity for Phase 7 (`WP7.1`, `WP7.2`, `WP7.3`, `WP7.4`, `G7` — Universal C++ Precompiled Headers & Selective Toolchain Prewarm) and Phase 8 (`WP8.1`, `WP8.2`, `WP8.3`, `G8` — 100% Node-vs-Rust Differential Corpus & Contract Parity):

1. **Sub-slice `M3.1` (`WP7.1` — Baseline Performance & 4-Tuple PCH Cache Identity):**
   - Implemented deterministic 4-tuple PCH cache identity `compute_pch_key(compiler_path, version_output, effective_flags, header_content)` and strict PCH flag extraction `extract_pch_compiler_flags(raw_flags)` in [`crates/judgedesk-core/src/toolchains/pch.rs`](../../../crates/judgedesk-core/src/toolchains/pch.rs).
   - Benchmark telemetry recorded across cold C++ `#include <bits/stdc++.h>` compilation, warm PCH-assisted compilation, and corrupted-PCH fallback compilation on both Windows x64 (`1.69x` speedup) and macOS arm64 (`2.03x` speedup).
2. **Sub-slice `M3.2` (`WP7.2` — Single-Flight Atomic PCH Generation & Sandbox-Readable Staging):**
   - Implemented `ensure_cpp_pch_in` with an in-process single-flight mutex (`PCH_BUILD_LOCK`), isolated per-build `OwnedWorkspace::create_in_temp("pch_build")` inside the native executor's sandbox, Clang relocatable PCH embedding (`-Xclang -fmodules-embed-all-files`), and atomic temp-directory promotion (`pch_stage_<pid>_<nanos>` $\rightarrow$ `<cache_dir>/<key>`) in [`crates/judgedesk-core/src/toolchains/pch.rs`](../../../crates/judgedesk-core/src/toolchains/pch.rs).
   - Implemented `stage_cpp_pch_into_workspace` to copy the verified `stdc++.h` umbrella header and precompiled `.gch`/`.pch` artifact into `<submission_workspace>/compiler-pch/bits/` so strict sandboxed compiler runs (`SandboxBoundary::EphemeralAppContainer` on Windows, Seatbelt on macOS) consume the PCH from their own authorized workspace without cross-directory ACL leaks.
3. **Sub-slice `M3.3` (`WP7.3` — Safe PCH Consumption, Fail-Open Fallback & Cache Invalidation):**
   - Integrated PCH staging and compiler flag injection (`-Icompiler-pch -Winvalid-pch` on GCC; `-Xclang -fno-validate-pch -include-pch compiler-pch/bits/stdc++.h.pch` on Clang) into `compile_submission` in [`crates/judgedesk-core/src/engine/compiler.rs`](../../../crates/judgedesk-core/src/engine/compiler.rs).
   - Implemented automatic fail-open retry without PCH if PCH-assisted compilation fails, paired with immediate `invalidate_pch_cache_dir` eviction of any corrupted cached PCH directory so subsequent compilations cleanly regenerate a valid PCH.
4. **Sub-slice `M3.4` (`WP7.4` & `G7` — Selective Background Prewarm & Phase 7 Exit Gate):**
   - Implemented `execute_selective_prewarm_in` and `execute_selective_prewarm_with_builder` in [`crates/judgedesk-core/src/toolchains/prewarm.rs`](../../../crates/judgedesk-core/src/toolchains/prewarm.rs) and wired `POST /api/toolchains/prewarm` in [`crates/judgedesk-core/src/server/routes/toolchains.rs`](../../../crates/judgedesk-core/src/server/routes/toolchains.rs) to warm only caller-requested profiles, check cancellation before and after each profile build, and reject prewarm with `503 SERVICE_UNAVAILABLE` when the server is draining/stopping.
5. **Sub-slice `M3.5` (`WP8.1`, `WP8.2`, `WP8.3` & `G8` — 100% Node-vs-Rust Semantic & Contract Parity):**
   - Upgraded `scripts/check-contract-parity.ts` and `crates/judgedesk-core` route handlers (`system.rs`, `toolchains.rs`, `judge.rs`, `session.rs`, `diagnostics.rs`, `discovery.rs`, `executor_client.rs`, `test_server.rs`) so that all `30/30` HTTP/SSE contract cases pass with `0` mismatches against both `--adapter=node` and `--adapter=rust` on Windows x64 and macOS arm64.
   - Implemented `ParitySubmissionSnapshot`, `ParityTestCaseSnapshot`, `ParityDimensionMismatch`, `ParityComparisonReport`, `compare_parity_snapshots`, and `write_mismatch_artifact` in [`crates/judgedesk-core/src/toolchains/pch.rs`](../../../crates/judgedesk-core/src/toolchains/pch.rs), verified by [`crates/judgedesk-core/tests/step8_differential_parity_test.rs`](../../../crates/judgedesk-core/tests/step8_differential_parity_test.rs) across all release languages, standard/custom checkers, interactive problems, and failure modes (`AC`, `WA`, `TLE`, `MLE`, `RTE`, `CE`, `PARTIAL`).

---

## 2. Mandatory 1-to-1 `WP*` Traceability Matrix (`WP7.1` $\rightarrow$ `G8`)

| ID | Work Package / Gate | Rust / TS File & Symbol | Verification Test Suite & Test Name | Command Log Reference |
|---|---|---|---|---|
| `WP7.1` | Baseline performance benchmark & 4-tuple PCH cache key | [`crates/judgedesk-core/src/toolchains/pch.rs`](../../../crates/judgedesk-core/src/toolchains/pch.rs) (`compute_pch_key`, `extract_pch_compiler_flags`, `PchBenchmarkMetrics`) | `step7_pch_and_perf_test::wp7_1_pch_cache_key_changes_Across_all_four_tuple_dimensions`, `step7_pch_and_perf_test::wp7_2_and_7_3_and_g7_live_pch_generation_warm_hit_corrupted_fallback_and_benchmark` | `logs/windows-step7-pch-perf.log`, `logs/mac-step7-pch-perf.log`, `logs/windows-test-rust.log`, `logs/mac-test-rust.log` |
| `WP7.2` | PCH cache identity, single-flight lock & atomic generation | [`crates/judgedesk-core/src/toolchains/pch.rs`](../../../crates/judgedesk-core/src/toolchains/pch.rs) (`ensure_cpp_pch_in`, `stage_cpp_pch_into_workspace`, `pch_artifact_filename`) | `step7_pch_and_perf_test::wp7_2_and_7_3_and_g7_live_pch_generation_warm_hit_corrupted_fallback_and_benchmark` | `logs/windows-step7-pch-perf.log`, `logs/mac-step7-pch-perf.log`, `logs/windows-test-rust.log`, `logs/mac-test-rust.log` |
| `WP7.3` | PCH safe consumption, fail-open fallback & cache eviction | [`crates/judgedesk-core/src/engine/compiler.rs`](../../../crates/judgedesk-core/src/engine/compiler.rs) (`compile_submission`), [`crates/judgedesk-core/src/toolchains/pch.rs`](../../../crates/judgedesk-core/src/toolchains/pch.rs) (`invalidate_pch_cache_dir`, `pch_include_args`) | `step7_pch_and_perf_test::wp7_2_and_7_3_and_g7_live_pch_generation_warm_hit_corrupted_fallback_and_benchmark` | `logs/windows-step7-pch-perf.log`, `logs/mac-step7-pch-perf.log`, `logs/windows-test-rust.log`, `logs/mac-test-rust.log` |
| `WP7.4` | Selective background prewarm & cancellation responsiveness | [`crates/judgedesk-core/src/toolchains/prewarm.rs`](../../../crates/judgedesk-core/src/toolchains/prewarm.rs) (`execute_selective_prewarm_in`, `execute_selective_prewarm_with_builder`), [`crates/judgedesk-core/src/server/routes/toolchains.rs`](../../../crates/judgedesk-core/src/server/routes/toolchains.rs) (`handle_prewarm`) | `step7_pch_and_perf_test::wp7_4_selective_prewarm_warms_only_requested_profiles_and_respects_cancellation` | `logs/windows-step7-pch-perf.log`, `logs/mac-step7-pch-perf.log`, `logs/windows-test-rust.log`, `logs/mac-test-rust.log` |
| `G7` | Phase 7 performance & PCH reliability gate | [`crates/judgedesk-core/tests/step7_pch_and_perf_test.rs`](../../../crates/judgedesk-core/tests/step7_pch_and_perf_test.rs) | `step7_pch_and_perf_test` (3/3 tests on Windows x64 and macOS arm64) | `logs/windows-step7-pch-perf.log`, `logs/mac-step7-pch-perf.log`, `logs/windows-check-full.log`, `logs/mac-check-full.log` |
| `WP8.1` | Isolated sequential Node-vs-Rust parity harness | [`scripts/check-contract-parity.ts`](../../../scripts/check-contract-parity.ts), [`crates/judgedesk-core/tests/step8_differential_parity_test.rs`](../../../crates/judgedesk-core/tests/step8_differential_parity_test.rs) (`wp8_1_and_8_2_and_g8_sequential_corpus_parity_across_all_languages_and_verdicts`) | `step8_differential_parity_test::wp8_1_and_8_2_and_g8_sequential_corpus_parity_across_all_languages_and_verdicts`, `check-contract-parity.ts` (`30/30` cases) | `logs/windows-step8-parity.log`, `logs/mac-step8-parity.log`, `logs/windows-contract-parity-node.log`, `logs/windows-contract-parity-rust.log`, `logs/mac-contract-parity-node.log`, `logs/mac-contract-parity-rust.log` |
| `WP8.2` | 7-dimension parity comparator & rational score equality | [`crates/judgedesk-core/src/toolchains/pch.rs`](../../../crates/judgedesk-core/src/toolchains/pch.rs) (`compare_parity_snapshots`, `ParitySubmissionSnapshot`, `ParityTestCaseSnapshot`, `ParityDimensionMismatch`) | `step8_differential_parity_test::wp8_1_and_8_2_and_g8_sequential_corpus_parity_across_all_languages_and_verdicts` | `logs/windows-step8-parity.log`, `logs/mac-step8-parity.log`, `logs/windows-test-rust.log`, `logs/mac-test-rust.log` |
| `WP8.3` | Structured mismatch artifact & fail-closed non-zero exit | [`crates/judgedesk-core/src/toolchains/pch.rs`](../../../crates/judgedesk-core/src/toolchains/pch.rs) (`write_mismatch_artifact`, `ParityComparisonReport`), [`scripts/check-contract-parity.ts`](../../../scripts/check-contract-parity.ts) | `step8_differential_parity_test::wp8_3_parity_comparator_detects_every_dimension_drift_and_writes_mismatch_artifact` | `logs/windows-step8-parity.log`, `logs/mac-step8-parity.log`, `logs/windows-test-rust.log`, `logs/mac-test-rust.log` |
| `G8` | Phase 8 100% Node-vs-Rust semantic & contract parity gate | [`crates/judgedesk-core/tests/step8_differential_parity_test.rs`](../../../crates/judgedesk-core/tests/step8_differential_parity_test.rs), [`scripts/check-contract-parity.ts`](../../../scripts/check-contract-parity.ts) | `step8_differential_parity_test` (2/2 tests) + `check-contract-parity.ts` (`30/30` Node & `30/30` Rust on Windows & macOS) | `logs/windows-step8-parity.log`, `logs/mac-step8-parity.log`, `logs/windows-contract-parity-rust.log`, `logs/mac-contract-parity-rust.log`, `logs/windows-check-full.log`, `logs/mac-check-full.log` |

---

## 3. 5-Axis Adversarial Code Review Summary & Dispositions

A fresh-context 5-axis adversarial review (`doubt-driven-development` + `code-review-and-quality`) was conducted via an independent subagent (`640cb014-4421-4680-82f1-223b8cb984f3`) across all `M3` files. All 5 findings were resolved in-place prior to running the final Milestone Gate Verification Union:

| Finding ID | Axis | Location | Summary | Disposition |
|---|---|---|---|---|
| `M3-REV-01` | Concurrency / Atomicity | [`crates/judgedesk-core/src/toolchains/pch.rs`](../../../crates/judgedesk-core/src/toolchains/pch.rs) | Concurrent PCH compilations for the same 4-tuple key could race on `<cache_dir>/<key>`. | **RESOLVED:** Added an in-process single-flight lock (`PCH_BUILD_LOCK`), double-checked cache hit after acquiring the lock, and staged outputs in `pch_stage_<pid>_<nanos>` before atomic `fs::rename` promotion to `<cache_dir>/<key>`. |
| `M3-REV-02` | Security / Flag Hygiene | [`crates/judgedesk-core/src/toolchains/pch.rs`](../../../crates/judgedesk-core/src/toolchains/pch.rs) | `extract_pch_compiler_flags` needed to reject dangerous output/file-consuming flags (`-o`, `-include`, `-include-pch`, `-x`, `@file`, path arguments) so PCH generation cannot be redirected. | **RESOLVED:** Restricted `extract_pch_compiler_flags` to safe language-standard, optimization, warning, and `-D`/`-U`/`-f`/`-m` flags while skipping flag-argument pairs (`-o`, `-include`, `-include-pch`, `-isystem`, `-I`, `-L`, `-x`). |
| `M3-REV-03` | Concurrency / Cancellation | [`crates/judgedesk-core/src/toolchains/prewarm.rs`](../../../crates/judgedesk-core/src/toolchains/prewarm.rs), [`crates/judgedesk-core/src/server/routes/toolchains.rs`](../../../crates/judgedesk-core/src/server/routes/toolchains.rs) | Selective prewarm needed to check cancellation both before and after an in-flight PCH build and reject prewarm requests when the server is draining/stopping. | **RESOLVED:** Added `execute_selective_prewarm_with_builder` with pre- and post-build cancellation checks and a `ServerLifecyclePhase::Running` guard in `handle_prewarm` returning `503 SERVICE_UNAVAILABLE` during shutdown drain. |
| `M3-REV-04` | Reliability / Self-Healing | [`crates/judgedesk-core/src/engine/compiler.rs`](../../../crates/judgedesk-core/src/engine/compiler.rs), [`crates/judgedesk-core/src/toolchains/pch.rs`](../../../crates/judgedesk-core/src/toolchains/pch.rs) | When a corrupted cached PCH triggered fail-open fallback to cold compilation, the corrupted PCH file remained on disk for future runs. | **RESOLVED:** Added `invalidate_pch_cache_dir(&pch.pch_file)` on PCH compilation fallback so the corrupted cache entry is immediately evicted and regenerated cleanly on the next build. |
| `M3-REV-05` | Code Quality | [`crates/judgedesk-core/src/server/routes/toolchains.rs`](../../../crates/judgedesk-core/src/server/routes/toolchains.rs), [`crates/judgedesk-core/src/toolchains/diagnostics.rs`](../../../crates/judgedesk-core/src/toolchains/diagnostics.rs) | Avoid `.expect()` in response construction and diagnostics helpers. | **RESOLVED:** Replaced `.expect()` with fail-closed fallback response construction in `sse_From_events` and `let Some(...) = ... else` in `diagnostics.rs`. |

---

## 4. Dual-Host Performance (`G7`) & Semantic Parity (`G8`) Summary

### 4.1 Phase 7 Performance & Universal PCH Telemetry (`G7`)

| Host | Compiler | Cold Compile (`ms`) | Warm PCH Compile (`ms`) | Speedup Ratio | Corrupted PCH Fallback (`ms`) | Verdict Parity |
|---|---|---|---|---|---|---|
| Windows x64 (`WinSta0\Default`) | MinGW-w64 `g++.exe` `14.2.0` (`-std=c++14 -O2`) | `895` | `531` | `1.69x` | `762` | `AC` / `AC` / `AC` (`42`) |
| macOS arm64 (`judgedesk-mac`) | Apple `clang++` `17.0.0` (`-std=c++14 -O2`) | `373` | `184` | `2.03x` | `292` | `AC` / `AC` / `AC` (`42`) |

### 4.2 Phase 8 Differential Corpus & Contract Parity (`G8`)

- **HTTP & SSE Contract Parity (`scripts/check-contract-parity.ts`):**
  - Windows x64: `--adapter=node` (`30/30` passed, `0` failed) and `--adapter=rust` (`30/30` passed, `0` failed).
  - macOS arm64 (`judgedesk-mac`): `--adapter=node` (`30/30` passed, `0` failed) and `--adapter=rust` (`30/30` passed, `0` failed).
- **Sequential Contest Corpus Differential Parity (`step8_differential_parity_test.rs`):**
  - `12/12` corpus scenarios (`C++` `AC`/`WA`/`TLE`/`RTE`/`CE`, `C` `AC`, `Python 3` `AC`, `Pascal` `AC`, `Java` `AC`, `Scratch .sb3` `AC`, custom checker `PARTIAL` rational score `7/3`, and interactive `AC` with transcript verification) matched `100%` (`0` mismatches) across all 7 comparison dimensions on both Windows x64 and macOS arm64.

---

## 5. Dual-Host Gate Verification Union & Protected-State Audit

### 5.1 Windows x64 (`D:\Minh\Code\judgedesk`, `WinSta0\Default`)

- `cargo fmt --check` & `cargo clippy --locked --all-targets -- -D warnings` $\rightarrow$ **PASS** (`logs/windows-clippy.log`)
- `npm run check:fast` $\rightarrow$ **PASS** (`logs/windows-check-fast.log`)
- `npm run test:rust` & `cargo test --locked --manifest-path native-executor/Cargo.toml` $\rightarrow$ **PASS** (`logs/windows-test-rust.log`)
- `npm run test:security` $\rightarrow$ **PASS** (`logs/windows-test-security.log`)
- `npm run check:full` $\rightarrow$ **PASS** (`logs/windows-check-full.log`)
- **Protected-Root Preservation (`before` vs `after`):** `100%` raw and semantic equality (`overallPreservationPass: true` in `protected-after-comparison.json`).
- **Orphan Process Drain:** `0` processes immediately (`logs/windows-process-drain-immediate.json`) and `0` processes after 10s delay (`logs/windows-process-drain-delayed-10s.json`).

### 5.2 macOS arm64 (`judgedesk-mac`: `/private/tmp/jd-rust-core-mac-dev`)

- `cargo fmt --check` & `cargo clippy --locked --all-targets -- -D warnings` $\rightarrow$ **PASS** (`logs/mac-clippy.log`)
- `npm run check:fast` $\rightarrow$ **PASS** (`logs/mac-check-fast.log`)
- `npm run test:rust` & `cargo test --locked --manifest-path native-executor/Cargo.toml` $\rightarrow$ **PASS** (`logs/mac-test-rust.log`)
- `npm run test:security` $\rightarrow$ **PASS** (`logs/mac-test-security.log`)
- `npm run check:full` $\rightarrow$ **PASS** (`logs/mac-check-full.log`)
- **Protected-Root Preservation (`before` vs `after`):** `100%` raw and semantic equality (`overallPreservationPass: true` in `protected-after-comparison.json`).
- **Orphan Process Drain:** `0` processes immediately (`logs/mac-process-drain-immediate.json`) and `0` processes after 10s delay (`logs/mac-process-drain-delayed-10s.json`).
