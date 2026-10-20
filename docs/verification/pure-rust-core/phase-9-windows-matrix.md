# Phase 9 (`V9.2`) — Complete Windows Desktop Acceptance Matrix

- **Work Package:** `V9.2` (batched in Macro-Milestone `M4`: `V9.1` $\rightarrow$ `G10`)
- **Candidate:** `m4-candidate01`
- **Remediation Round:** `antigravity-m4-remediator-20261019T054300Z`
- **Canonical Milestone Gate Report:** [`m4-desktop-release-and-cutover-gate.md`](m4-desktop-release-and-cutover-gate.md)
- **Artifact & Digest Binding:** Exclusively bound in [`artifacts/m4/antigravity-m4-remediator-20261019T054300Z/evidence-final-manifest.json`](artifacts/m4/antigravity-m4-remediator-20261019T054300Z/evidence-final-manifest.json) under the JSON-Only Hash Binding rule.

---

## 1. Windows Desktop Single-Instance & Crash-Recovery Matrix (`scripts/windows-single-instance-gate.ps1`)

Executed on `WinSta0\Default` in an isolated temporary app-data root (`logs/windows-single-instance-gate.log`):

| Verification Dimension | Observed Result | Verdict |
| :--- | :--- | :--- |
| **`BackendMode`** | `embedded-rust` (`0` `server.exe` processes; embedded Axum listener inside primary `themis-v2.exe`) | **PASS** |
| **`ExecutorStartedAtIdle`** | `True` (`judgedesk-executor.exe` spawned at startup and assigned to Windows Job Object supervisor) | **PASS** |
| **Working Set Footprint** | Primary: `41.0 MiB`, Supervisor: `10.8 MiB`, Executor: `7.7 MiB`, External Backend Sidecar: `0.0 MiB` | **PASS** |
| **Secondary Instance Minimize $\rightarrow$ Restore & Foreground** | `MinimizedThenRestored: True`, `Foregrounded: True` | **PASS** |
| **20 Sequential Secondary Launches** | `SequentialLaunches: 20` (`229 ms` min, `530 ms` max; `0` leaked processes) | **PASS** |
| **Primary Crash Recovery & Zero Tree Overlap** | `PrimaryCrashRecovered: True`, `ProtectedTreeOverlapDetected: False` | **PASS** |
| **Supervisor Failure Recovery Drain** | `SupervisorFailureDrainedBackend: True` | **PASS** |
| **Normal Shutdown Process-Tree Drain** | `NormalShutdownDrainedRuntime: True` | **PASS** |

---

## 2. Windows Desktop Product & UI Flow Matrix (`V9.2`)

| Area | Verification Coverage & Evidence | Verdict |
| :--- | :--- | :--- |
| **Startup & Single Instance** | Cold/warm launch in default `embedded-rust` mode, explicit `JUDGEDESK_PURE_RUST_CORE=0` rollback contract, 20x secondary instance activation/restore, primary crash recovery, and supervisor failure drain (`logs/windows-single-instance-gate.log`, `logs/windows-tdd-green-m4.log`). | **PASS** |
| **Workspace & Problem Discovery** | Empty/missing/space/literal Unicode directory paths (`Thí sinh`, `Bài tập`), natural sorting, reload state preservation (`logs/windows-test-rust.log`, `logs/windows-check-full.log`). | **PASS** |
| **Scoreboard & Virtualization** | 18x5 and 72x20 scoreboard rendering, column/row resize, 3-state sorting, tie/unjudged ordering, keyboard navigation, and cell details (`logs/windows-check-full.log`). | **PASS** |
| **Problem Configuration (`Config.cfg` / Polygon)** | Save/reopen/legacy migration, exact rational weights (`shared/rational.ts`, `crates/judgedesk-core/src/scoring`), subtask group dependencies, time/memory limits (`8..=1024 MiB`), custom checker/interactor compilation (`logs/windows-contract-parity-rust.log`, `logs/windows-test-rust.log`). | **PASS** |
| **Toolchains (`F6`)** | Live Toolchain Manager UI (`logs/windows-v9-2-live-desktop-toolchains.png`), 6 language profiles (`cpp`, `c`, `python`, `pascal`, `java`, `scratch`), fail-closed source selection (`managed`, `local_path`, `local_auto`, `none`), active judge mutation lock (`409 CONFLICT`), Universal PCH + selective prewarm (`logs/windows-test-rust.log`). | **PASS** |
| **Batch Judging & Verdicts** | All verdicts (`AC`, `WA`, `TLE`, `MLE`, `OLE`, `RE`, `CE`, `JE`, `PARTIAL`) across all 6 languages, SSE event streaming, mid-flight cancellation, and whole-tree process drain (`logs/windows-test-rust.log`, `logs/windows-test-security.log`). | **PASS** |
| **OSD Live Folder Queue** | Start/stop/status/events SSE stream, 200ms debounce, duplicate/malformed rejection, batch judge conflict (`409`), and clean shutdown (`logs/windows-v9-1-desktop-smoke.json`, `logs/windows-test-rust.log`). | **PASS** |
| **Archive (`.judgedesk`) & Excel (`.xlsx`) Export** | Portable `.judgedesk` archive round-trip, atomic overwrite safety, `.xlsx` exact rational totals and metadata, native workbook opener (`logs/windows-test-rust.log`, `logs/windows-check-full.log`). | **PASS** |
| **Presentation & Accessibility** | Vietnamese/English i18n parity, light/dark theme parity, keyboard shortcuts (`F2`/`F3`/`F5`/`F6`/`Esc`), anti-AI-slop CSS floor (`logs/windows-check-fast.log`, `logs/windows-v9-1-live-desktop-main.png`, `logs/windows-v9-2-live-desktop-system-status.png`). | **PASS** |
| **Update & Version Identity (`v1.6.0`)** | 8-file + core crate version lockstep at `1.6.0` (`logs/windows-release-check-version.log`), `prepare_for_update` handoff and backend process-tree drain (`src-tauri/src/backend.rs`). | **PASS** |
