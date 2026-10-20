# Phase 9 (`V9.4`) — Human macOS GUI Checklist & Automated Verification Evidence

- **Work Package:** `V9.4` (batched in Macro-Milestone `M4`: `V9.1` $\rightarrow$ `G10`)
- **Candidate:** `m4-candidate01`
- **Remediation Round:** `antigravity-m4-remediator-20261019T054300Z`
- **Target Host:** `judgedesk-mac` (`macOS arm64`, Apple Silicon, `/private/tmp/jd-rust-core-mac-dev`)
- **Canonical Milestone Gate Report:** [`m4-desktop-release-and-cutover-gate.md`](m4-desktop-release-and-cutover-gate.md)
- **Artifact & Digest Binding:** Exclusively bound in [`artifacts/m4/antigravity-m4-remediator-20261019T054300Z/evidence-final-manifest.json`](artifacts/m4/antigravity-m4-remediator-20261019T054300Z/evidence-final-manifest.json) under the JSON-Only Hash Binding rule.

---

## 1. Candidate & Bundle Identity

- **Application Version:** `1.6.0` (8-file + `crates/judgedesk-core/Cargo.toml` version lockstep)
- **Default Backend Mode:** `ExperimentalRust` (`JUDGEDESK_PURE_RUST_CORE` unset $\rightarrow$ embedded Pure Rust Native Core; `0`/`false` $\rightarrow$ explicit `NodeSidecar` rollback)
- **Bundle Path:** `/private/tmp/jd-rust-core-mac-dev/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/JudgeDesk.app`
- **Isolated Data Root for Testing:** Temporary `THEMIS_APP_DATA_DIR` directory outside `/Users/mac/Library/Application Support/ThemisV2`; host default `$TMPDIR/JudgeDeskExecutor` preserved (`overallPreservationPass: true`).

---

## 2. Automated macOS Platform, Bundle & Supervisor Verification (`V9.3` / `V9.4` Foundation)

| # | Verification Gate | Target / Scope | Automated Evidence Log | Status |
| :--- | :--- | :--- | :--- | :--- |
| 1 | **Cutover & Release TDD Suite (`step9_10_cutover_and_release_test`)** | Default Rust backend mode, explicit `0`/`false` rollback, `v1.6.0` 8-file lockstep, embedded server + `judgedesk-executor` PID supervision & shutdown drain | `logs/mac-tdd-red-m4.log` (`EXPECTED_RED`) $\rightarrow$ `logs/mac-tdd-green-m4.log` (`PASS`) | **PASS** |
| 2 | **macOS Bundle Layout & Resource Integrity (`verify:macos:local`)** | Mach-O `arm64` slices (`JudgeDesk`, `judgedesk-executor`, `server`), `Info.plist`, `Resources/judgers/testlib.h`, `Resources/compiler-compat/include/bits/stdc++.h`, `Resources/toolchains/manifest.v1.json`, ad-hoc local code signature | `logs/mac-verify-bundle.log` | **PASS** |
| 3 | **macOS Process Supervisor & Crash-Drain Gate (`macos-process-supervisor-gate.sh`)** | Packaged `JudgeDesk.app` launch, embedded Rust listener on GUI PID, `judgedesk-executor` child supervision, `SIGKILL` crash drain (`< 2s`), normal `SIGTERM` drain, generation-guard file cleanup | `logs/mac-process-supervisor-gate.log` | **PASS** |
| 4 | **macOS Packaged Custom Checker & Apple Clang Gate (`macos-packaged-checker-gate.mjs`)** | Packaged `JudgeDesk.app` custom checker compilation (`testlib.h` + `bits/stdc++.h` under Apple Clang `arm64`) and Seatbelt `sandbox-exec` execution | `logs/mac-packaged-checker-gate.log` | **PASS** |
| 5 | **macOS Contract & Corpus Differential Parity (`30/30` HTTP/SSE + `12/12` Corpus)** | `check-contract-parity.ts --adapter=rust` & `--adapter=node`, `step8_differential_parity_test` | `logs/mac-contract-parity-rust.log`, `logs/mac-contract-parity-node.log`, `logs/mac-test-rust.log` | **PASS** |

---

## 3. Numbered Human macOS WKWebView GUI Acceptance Checklist (`V9.4`)

For interactive human WKWebView sign-off on `judgedesk-mac` (complementing the automated `V9.3`/`V9.4` bundle, process-supervisor, and packaged-checker gates above):

1. **Cold & Warm Launch (`V9.4-01`):** Launch `JudgeDesk.app` (`v1.6.0`) with isolated `THEMIS_APP_DATA_DIR`. Confirm main window opens in WKWebView without blank frame or console errors, and System Status popover displays `Native protection: Sẵn sàng`, `darwin-seatbelt-rlimit`, and `JudgeDesk v1.6.0`.
2. **Workspace & Literal Unicode Discovery (`V9.4-02`):** Load a contest directory containing literal Vietnamese NFC/NFD paths (`Thí sinh`, `Bài tập`) and verify 18x5 and 72x20 scoreboard rendering, column/row resize, and `F5` reload preservation.
3. **Problem Configuration & Rational Weights (`V9.4-03`):** Open Problem Configuration (`F2`), configure subtask groups with exact rational weights (`1/3`, `2/3`) and custom `testlib.h` checker, save atomically to `Config.cfg`, and reopen to verify zero precision drift.
4. **Toolchain Manager (`F6`) & Apple Clang Qualification (`V9.4-04`):** Open Toolchain Manager (`F6`), verify `C++` and `C` `local_auto` Apple Clang readiness alongside managed `Python`, `Pascal`, `Java`, and `Scratch` profiles, and trigger selective PCH prewarm.
5. **Batch Judging & Mid-Flight Cancellation (`V9.4-05`):** Run a multi-language batch judge (`AC`, `WA`, `TLE`, `MLE`, `OLE`, `RE`, `CE`), inspect per-test details, trigger mid-flight cancellation, and confirm immediate `judgedesk-executor` descendant drain.
6. **OSD Live Queue & Archive/Excel Export (`V9.4-06`):** Start OSD monitoring, drop a submission file, verify automatic grading, save/reopen a `.judgedesk` archive, and export `.xlsx` results.
7. **Theme, Localization & Clean Quit (`V9.4-07`):** Toggle Vietnamese/English and Light/Dark themes, verify keyboard focus rings (`Tab`/`Esc`), quit via `Cmd+Q`, and confirm `0` surviving `JudgeDesk` or `judgedesk-executor` processes and `100%` protected-root preservation.
