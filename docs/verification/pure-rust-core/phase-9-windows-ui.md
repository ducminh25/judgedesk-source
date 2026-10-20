# Phase 9 (`V9.1`) — Windows Rust Desktop Launch Protocol & Live Computer Use Smoke Report

- **Work Package:** `V9.1` (batched in Macro-Milestone `M4`: `V9.1` $\rightarrow$ `G10`)
- **Candidate:** `m4-candidate01`
- **Remediation Round:** `antigravity-m4-remediator-20261019T054300Z`
- **Canonical Milestone Gate Report:** [`m4-desktop-release-and-cutover-gate.md`](m4-desktop-release-and-cutover-gate.md)
- **Artifact & Digest Binding:** Exclusively bound in [`artifacts/m4/antigravity-m4-remediator-20261019T054300Z/evidence-final-manifest.json`](artifacts/m4/antigravity-m4-remediator-20261019T054300Z/evidence-final-manifest.json) under the JSON-Only Hash Binding rule.

---

## 1. Rust-Default Desktop Launch & Cutover Contract (`V9.1` / `WP10.2`)

1. **Default Embedded Rust Backend (`src-tauri/src/backend.rs`):**
   - `backend_mode_from_env(None)` resolves to `Ok(BackendMode::ExperimentalRust)`, starting the Pure Rust Native Core (`judgedesk_core::server::start_embedded_server_with_tree_guard_and_pid`) directly inside the Tauri process without spawning a Node.js SEA `server.exe` sidecar.
   - `JUDGEDESK_PURE_RUST_CORE=1|true` explicitly selects `BackendMode::ExperimentalRust`.
   - `JUDGEDESK_PURE_RUST_CORE=0|false` explicitly selects `BackendMode::NodeSidecar` rollback mode.
   - Any other value returns `Err(InvalidInput)` (fail-closed, zero silent fallback).
2. **Process-Tree Supervision & Fail-Closed Executor Startup:**
   - `src-tauri/src/backend.rs::spawn` propagates `THEMIS_RESOURCE_DIR` to the embedded Rust core, verifies that `judgedesk-executor.exe` started (`executor_pid.is_some()`), and registers the executor PID with `InstanceCoordinator::assign_backend(pid)` so the Windows Job Object supervisor (`--judgedesk-internal-job-supervisor-v1`) governs the entire backend process tree.
   - `src-tauri/src/backend.rs::stop` issues an authenticated `POST /api/shutdown` (`X-JudgeDesk-Session`) and drains the backend process tree via `InstanceCoordinator::terminate_backend_tree` + `wait_for_backend_tree`.

---

## 2. Live Windows Desktop Smoke Execution Under Computer Use Protocol

Executed on `WinSta0\Default` in an isolated temporary app-data root (`LOCALAPPDATA`, `APPDATA`, `THEMIS_APP_DATA_DIR` redirected to a disposable directory so host `%LOCALAPPDATA%\ThemisV2` and `%LOCALAPPDATA%\JudgeDesk\JudgeDeskExecutor` remain untouched) under the Antigravity Global System Rules Computer Use Protocol (`overlay.ps1 -Action start`, `-Action is_cancelled` before every action, `-Action stop` upon completion):

- **Executable:** `src-tauri/target/debug/themis-v2.exe` built with `--features tauri/custom-protocol` and staged `src-tauri/target/debug/judgedesk-executor.exe` (`v1.6.0`).
- **Live Status & Process Inventory (`logs/windows-v9-1-desktop-smoke.json`):**
  - `GET /api/status`: `build.appVersion = "1.6.0"`, `build.backend = "rust"`, `build.target = "x86_64-pc-windows-msvc"`, `secureRunner.ready = true`, `secureRunner.mode = "windows-lpac-job"`, `secureRunner.executorVersion = "1.6.0"`, `secureRunner.networkBlocked = true`, `secureRunner.filesystemIsolated = true`, `secureRunner.memoryLimitSupported = true`, `secureRunner.processTreeControlled = true`.
  - `GET /api/toolchains`: `6` language profiles returned (`cpp`, `c`, `python`, `pascal`, `java`, `scratch`).
  - `GET /api/osd/status`: `success = true`, `status.active = false`, `status.queueLength = 0`.
  - **Process Topology:** Exactly `3` JudgeDesk processes running at idle (`themis-v2.exe` primary GUI, `themis-v2.exe --judgedesk-internal-job-supervisor-v1` helper, and `judgedesk-executor.exe` child of primary GUI) and **`0` `server.exe` Node sidecar processes**.
- **Captured Live Desktop Screenshots:**
  - `logs/windows-v9-1-live-desktop-changelog.png` — Initial startup showing the changelog modal over the JudgeDesk v1.6.0 workspace.
  - `logs/windows-v9-1-live-desktop-main.png` — Main JudgeDesk v1.6.0 workspace after dismissing the changelog modal.
  - `logs/windows-v9-2-live-desktop-system-status.png` — System status popover confirming `Native protection: Sẵn sàng`, `G++: Sẵn sàng chấm bài`, `Python: Sẵn sàng chấm bài`, `Trình chạy hoạt động: windows-lpac-job`, and `JudgeDesk v1.6.0 · build local`.
  - `logs/windows-v9-2-live-desktop-toolchains.png` — Toolchain Manager modal (`F6`) displaying the 6 language profiles and fail-closed source selection policy.
