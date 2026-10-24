# JudgeDesk — Comprehensive Software Engineering Guidelines

This document provides a complete reference for the architectural blueprint, engineering standards, development workflows, testing strategies, packaging pipelines, and release procedures for **JudgeDesk**. It is tailored for onboarding software engineers, open-source contributors, and **AI Agents** to develop features, fix bugs, and operate the project safely, accurately, and consistently.

---

## 1. Project Overview & Architectural Blueprint

### 1.1. Introduction
**JudgeDesk** (historically codenamed *ThemisV2*) is a standalone, offline desktop automated grading application designed for competitive programming contests, computer science classrooms, and training clubs. It runs natively on **Windows 10/11 x64**, **macOS Apple Silicon (ARM64)**, and **Linux x86_64 (`amd64` — Ubuntu 22.04 LTS, 24.04 LTS, 26.04 LTS+ and compatible distributions)** without requiring any cloud or external network services during judging.

### 1.2. 4-Tier Architecture

```mermaid
graph TD
    subgraph UI_Layer [Tier 1: Frontend - User Interface]
        UI[React 19 + TypeScript + Vite + Tailwind CSS v4 + i18next]
        Scoreboard[Live Scoreboard & Contestant Filter]
        ConfigModal[Problem Configuration & Polygon Test Groups]
        ToolchainMgr[Compiler & Runtime Manager]
    end

    subgraph Shell_Layer [Tier 2: Desktop Shell - Tauri v2]
        TauriCore[Tauri Shell & Native Windowing]
        StartupGuard[Startup Guard: Single Instance & IPC Mutex]
        Supervisor[Process Supervisor: Process Tree Lifecycle]
        ContestArchive[.judgedesk Contest Archive Packager/Extractor]
    end

    subgraph Backend_Layer [Tier 3: Backend - Rust Core / Node.js SEA Sidecar]
        ExpressServer[HTTP/SSE Server on 127.0.0.1]
        JobQueue[Session & Batch Judge Engine]
        LanguageRegistry[Language & Toolchain Registry v2]
        ScoringEngine[Scoring, Subtasks & Checkers Engine]
        ParentWatchdog[Parent Watchdog: Tauri Shell Monitor]
    end

    subgraph Sandbox_Layer [Tier 4: Native Executor - Rust Safe Runner]
        ClientIPC[IPC Protocol: Stdin/Stdout Header-Payload LE]
        WinSandbox[Windows: AppContainer + Job Objects + Low Integrity]
        MacSandbox[macOS: Run Guardian + Seatbelt Sandbox + PGID]
        LinuxSandbox[Linux: Bubblewrap + cgroup v2 + seccomp-bpf]
        LimitsEnforcer[CPU, Wall-clock, 8-1024MB Memory, I/O Enforcer]
    end

    UI -->|HTTP / SSE / JSON| ExpressServer
    UI -->|Tauri Invoke IPC| TauriCore
    TauriCore -->|Spawn & Monitor Sidecar| ExpressServer
    ExpressServer -->|Stdin/Stdout Pipe Protocol| ClientIPC
    ClientIPC --> WinSandbox
    ClientIPC --> MacSandbox
    ClientIPC --> LinuxSandbox
```

- **Tier 1: Frontend (React 19 + TypeScript + Vite + Tailwind CSS v4)**: Fluid, responsive desktop UI supporting Light/Dark themes, bilingual interface (Vietnamese `vi.json` and English `en.json`), real-time judging progress streaming via Server-Sent Events (SSE).
- **Tier 2: Desktop Shell (Tauri v2 / Rust)**: Manages native OS windows, enforces the single-instance invariant (`startup_guard.rs`), supervises orphan process tree cleanup (`process_supervisor.rs`), coordinates update handoffs (`prepare_for_update`), and handles `.judgedesk` zip contest containers.
- **Tier 3: Backend (`judgedesk-core` Rust Axum / Node.js 24.19.0 SEA Sidecar)**: Hosts the core judging logic, compiler orchestration, testcase discovery, scoring algorithms, standard/custom checkers, and toolchain distribution management. Protected by bootstrap tokens and parent process watchdogs.
- **Tier 4: Native Executor (Rust Binary - `judgedesk-native-executor`)**: Executes untrusted contestant submissions within strictly isolated OS sandbox environments. Utilizes Windows AppContainer + Job Objects on Windows, Run Guardian + Seatbelt Sandbox policies + Process Groups on macOS, and Bubblewrap (`bwrap`) + systemd User Scope (`cgroup v2`) + `seccomp-bpf` on Linux.

### 1.3. Project Invariants & Identifiers
All code changes must preserve the following identity invariants to guarantee backward compatibility, data persistence, and in-place upgrades:
1. **Application Identifier**: `com.themisv2.judge`
2. **Windows MSI UpgradeCode**: `4ac645a9-f719-5210-85be-f03f49c33869`
3. **User Application Data Directory**:
   - Windows: `%LOCALAPPDATA%\ThemisV2\`
   - macOS: `~/Library/Application Support/ThemisV2/`
   - Linux: `~/.local/share/ThemisV2/`
4. **Dual-Repository Model**:
   - Public source repository: `ducminh25/judgedesk-source` (contains source code, tags, CI workflows).
   - Public distribution repository: `ducminh25/judgedesk` (contains public releases, installers, SHA256SUMS, `latest.json` updater manifest, and public documentation).
5. **8-File Version Synchronization Rule**:
   Every version bump must be synchronized across exactly 8 files:
   - `package.json` (`version`)
   - `package-lock.json` (`version` & `packages[""].version`)
   - `src/version.ts` (`APP_VERSION`)
   - `src-tauri/Cargo.toml` (`package.version`)
   - `src-tauri/Cargo.lock` (`themis-v2` version; authoritative existing Cargo package name)
   - `src-tauri/tauri.conf.json` (`version`)
   - `native-executor/Cargo.toml` (`package.version`)
   - `native-executor/Cargo.lock` (`judgedesk-native-executor` version)
   *(Enforced via: `npm run release:check-version`)*.

---

## 2. Standard Development Environment & Prerequisites

To ensure build reproducibility and prevent toolchain divergence, the development environment must use the pinned toolchain versions:

| Tool / Dependency | Exact Pinned Version | Notes |
| :--- | :--- | :--- |
| **Node.js** | `24.19.0` LTS | Enforced by `.nvmrc`, `package.json`, and Volta. |
| **npm** | `11.17.0` | Bundled with Node.js 24.19.0. |
| **Rust** | `1.97.1` (with `rustfmt`, `clippy`) | Enforced by `rust-toolchain.toml`. |
| **Windows Toolchain** | Visual Studio Build Tools (C++ x64) | Requires *Desktop development with C++* workload and WebView2 Runtime. |
| **macOS Toolchain** | Xcode Command Line Tools | Installed via `xcode-select --install` (Apple Silicon ARM64 only). |
| **Tauri CLI v2** | Managed via lockfile (`package-lock.json`) | **Never install a global Tauri CLI copy.** |

### 2.1. Initial Setup
```powershell
# 1. Clone the repository
git clone https://github.com/ducminh25/judgedesk-source.git
cd judgedesk-source

# 2. Clean install dependencies from lockfile
npm ci

# 3. Verify environment and versions
npm run release:check-version
npm run lint
```

---

## 3. Directory Structure & Codebase Map

```text
judgedesk/
├── src/                          # Frontend React 19 SPA
│   ├── components/               # Shared UI components (Toolbar, Dialogs, Modals, DiffViewer)
│   ├── contexts/                 # React Contexts (ThemeContext, etc.)
│   ├── features/                 # Feature-driven modular architecture
│   │   ├── announcements/        # Signed Admin Announcements & Notification Center UI
│   │   ├── contest/              # .judgedesk contest file handling, dirty state, archive models
│   │   ├── desktop/              # Browser lifecycle & Tauri desktop shell bridge
│   │   ├── export/               # Excel score workbook generation (exceljs)
│   │   ├── help/                 # Help Center modal, documentation in VI/EN
│   │   ├── judging/              # Judging session coordination, verdict mapping, scheduler
│   │   ├── preferences/          # User preferences management, LocalStorage sync
│   │   ├── problem-config/       # Problem config editor, time/memory limits, Polygon subtasks
│   │   ├── scoreboard/           # Real-time scoreboard, contestant filtering, ranking table
│   │   ├── toolchains/           # Compiler/runtime manager UI, download/install/verify flow
│   │   ├── updates/              # Core/Full update check dialogs and download handoff
│   │   └── workspace/            # Workspace path selection, path memory, validation
│   ├── locales/                  # Internationalization JSON dictionaries (en.json, vi.json)
│   ├── App.tsx                   # Main root application view
│   └── index.css                 # Core CSS design tokens & Tailwind v4
│
├── crates/judgedesk-core/        # Pure Rust Core Backend (Axum HTTP/SSE, judging engine, discovery, PCH)
│
├── server/                       # Backend Node.js Engine
│   ├── executor/                 # IPC Client communicating with Native Executor via Stdin/Stdout
│   ├── export/               # Excel workbook export logic
│   ├── judge/                    # Core judging engine:
│   │   ├── compiler.ts           # Compilers for C++, C, Pascal, Java, and Python syntax check
│   │   ├── testcase-runner.ts    # Single testcase execution runner via sandbox
│   │   ├── standard-checkers.ts  # Built-in standard checkers (wcmp, lcmp, fcmp, yesno, floats...)
│   │   ├── custom-checker-runner.ts # Custom checker compiler and runner (testlib.h / Python)
│   │   ├── scoring.ts            # Subtask, test group, and weighted scoring algorithms
│   │   ├── submission-discovery.ts # Contestant directory and file discovery
│   │   └── testcase-discovery.ts # Test directory discovery (Themis / Polygon formats)
│   ├── languages/                # Language registry and policy contracts (contracts.ts, registry.ts)
│   ├── platform/                 # Platform integration (Parent Watchdog, Directory Picker, Lifecycle)
│   ├── problems/                 # Problem configuration repository and normalization
│   ├── routes/                   # REST API routes for frontend communication
│   ├── toolchains/               # Toolchains v2 subsystem:
│   │   ├── manifest.ts           # Ed25519 signature verification for toolchain manifests
│   │   ├── installer.ts          # Download, SHA-256 validation, and atomic archive extraction
│   │   ├── discovery.ts          # Host system compiler auto-detection (PATH / standard paths)
│   │   └── resolver.ts           # Configured toolchain resolution and fallback prevention
│   ├── jobs.ts                   # Job queue state and active batch judge session lifecycle
│   ├── runtime.ts                # APP_ROOT, RESOURCE_ROOT, and DATA_DIR resolution
│   └── server.ts                 # Express server startup entry point
│
├── native-executor/              # Native Safe Runner (Rust)
│   ├── Cargo.toml                # Standalone Rust crate configuration
│   └── src/
│       ├── main.rs               # Binary entrypoint, frame protocol reader/writer, dispatcher
│       ├── platform/
│       │   ├── windows.rs        # AppContainer, Job Objects, Resource Limits (Windows)
│       │   ├── macos.rs          # Run Guardian, Seatbelt Sandbox, Process Groups (macOS)
│       │   └── linux.rs          # Bubblewrap, systemd cgroup v2, seccomp-bpf (Linux)
│       ├── macos_run_guardian.rs # Process supervision and group teardown guardian on macOS
│       ├── macos_launcher.rs     # Isolated process launcher helper on macOS
│       ├── request_validation.rs # Strict input parameter and path validation
│       ├── tree_guard.rs         # Process tree cleanup and generation barrier enforcement
│       └── protocol.rs           # JSON IPC wire protocol models
│
├── src-tauri/                    # Tauri Desktop Shell (Rust)
│   ├── src/
│   │   ├── main.rs               # Desktop binary entry point
│   │   ├── lib.rs                # Tauri App setup and command handlers
│   │   ├── announcements/        # Native Ed25519 announcement feed verification, media decoding & cache
│   │   ├── backend.rs            # Spawn and monitor embedded Rust core or Node.js SEA sidecar
│   │   ├── startup_guard.rs      # Single-instance lock and primary window focus coordinator
│   │   ├── process_supervisor.rs # Process tree supervisor on Windows
│   │   ├── process_supervisor_macos.rs # Process tree supervisor on macOS
│   │   └── contest_archive.rs    # .judgedesk archive packaging and extraction
│   ├── Cargo.toml                # Tauri shell crate dependencies
│   └── tauri.*.conf.json         # Platform and distribution build configurations
│
├── shared/                       # Shared TypeScript types and contracts (frontend & backend)
├── judgers/                      # Bundled testlib.h library for C++ custom checkers
├── scripts/                      # Build, packaging, stress test, and security gate scripts
└── docs/                         # In-depth architectural designs and release checkpoints
```

---

## 4. Daily Development Workflow

### 4.1. Common Development Commands

#### 1. Frontend Development (Browser-only with Fast Hot-Reload)
Starts the Vite dev server:
```powershell
npm run dev:frontend
```
Open `http://127.0.0.1:5173` in your browser. *(Note: Native features such as OS file pickers, automatic updaters, and `.judgedesk` archives require the Tauri desktop window).*

#### 2. Standalone Backend Development
Runs the Express backend server with `tsx`:
```powershell
npm run dev
```
Server listens at `http://127.0.0.1:3000`.

#### 3. Full Desktop Development (Recommended for Full-Stack Development)
Rebuilds the SEA sidecar, launches Vite HMR, and opens a live Tauri / WebView2 window:
```powershell
npm run test:desktop
```
*(Tip: When making frontend-only edits in `src/` after an initial sidecar build, you can use `npx tauri dev` for faster restarts).*

### 4.2. Building Individual Components
- **Build Native Executor**:
  ```powershell
  npm run build:executor
  ```
  Compiles `native-executor` in release mode and stages the binary under `src-tauri/binaries/`.
- **Build Server Sidecar**:
  ```powershell
  npm run build:server
  ```
  Bundles `server.ts` with `esbuild`, generates the SEA blob, and injects it into Node.js via `postject`.
- **Build Production Frontend**:
  ```powershell
  npm run build:frontend
  ```
- **Clean Build Artifacts**:
  ```powershell
  npm run clean
  ```

---

## 5. Judging Engine & Toolchains Subsystem (Toolchains v2)

### 5.1. Supported Languages & Toolchains (v1.6.1 Scope)

| Language | Extensions | Windows x64 | macOS Apple Silicon (ARM64) | Linux x86_64 (`amd64` — Ubuntu 22.04 LTS+) |
| :--- | :--- | :--- | :--- | :--- |
| **C++** | `.cpp` | GCC 14.2.0 (Managed / Local) | Apple Clang (Xcode Command Line Tools) | xPack GCC 14.2.0-2 (Managed in Full) / Host `g++` or `clang++` |
| **C** | `.c` | GCC 14.2.0 (Managed / Local) | Apple Clang (Xcode Command Line Tools) | xPack GCC 14.2.0-2 (Managed in Full) / Host `gcc` or `clang` |
| **Python** | `.py` | CPython 3.12.13 (Managed / Local) | CPython 3.12.13 (Managed / Local) | CPython 3.12.13 (Managed in Full) / Host `python3` |
| **Pascal / FPC** | `.pas`, `.pp` | Free Pascal 3.2.2 (Managed / Local) | Free Pascal 3.2.2 (Managed / Local) | Free Pascal 3.2.2 (Managed in Full) / Host `fpc` (`ppcx64`) |
| **Java** | `.java` | Eclipse Temurin OpenJDK 21.0.12+8 (Managed / Local) | Eclipse Temurin OpenJDK 21.0.12+8 (Managed / Local) | Eclipse Temurin OpenJDK 21.0.12+8 (Managed in Full) / Host `javac` & `java` |
| **Scratch** | `.sb3`, `.sb2`, `.sb` | TurboWarp VM / scratch-run 0.1.7 (Managed) | TurboWarp VM / scratch-run 0.1.7 (Managed) | TurboWarp VM / scratch-run 0.1.7 (Bundled in both Full & Core) |

> [!NOTE]
> Future languages (Go, Rust, JavaScript/Node.js, C#/.NET) have registered declarative schemas in `server/languages/registry.ts`, but are marked `experimental` and disabled in official production releases.

### 5.2. Distribution Editions: Core vs Full
1. **Full Edition**: Pre-bundles all managed compilers and runtimes directly inside the installer.
   - Windows Full (`.msi`): Includes GCC (C/C++), CPython, FPC, Temurin Java, Scratch VM, and the offline WebView2 Runtime.
   - macOS Full (`.dmg`): Includes CPython, FPC, Temurin Java, Scratch VM; C/C++ uses the host Apple Clang.
   - Linux Full (`.deb`, `.rpm`, `.AppImage`): Includes all 6 offline languages (`gcc-linux-x64` xPack GCC 14.2.0-2 with binutils/sysroot, `python-linux-x64` CPython 3.12.13, `fpc-linux-x64` Free Pascal 3.2.2, `temurin21-linux-x64` OpenJDK 21, `scratch-linux-x64` 0.1.7), verified via per-file `SHA-256` content indices and automatically imported into the local cache on first launch without network access.
   - Ideal for: Offline contest labs, classroom computers without internet access.
2. **Core Edition**: Lightweight distribution containing the core judging application and built-in Scratch Headless VM. Users can download signed toolchains on demand (Windows/macOS) or automatically detect pre-existing local compilers (`Local (auto-detect)` across Windows, macOS, and Linux).

### 5.3. Four Toolchain Configuration Modes
Users configure the toolchain source independently for each language:
1. `None`: Language disabled (submissions will be ignored).
2. `Managed`: Uses official JudgeDesk packages verified via Ed25519 signatures and SHA-256 hashes.
3. `Local (auto-detect)`: Automatically detects host compilers from standard installation locations and `PATH`.
4. `Local (path)`: Uses a manually specified executable path verified against security compatibility tests.

### 5.4. Toolchains v2 Security Policies & Migration
- **Ed25519 Signature Verification**: The `toolchains-manifest.json` manifest is digitally signed using an Ed25519 private key. The backend validates the signature before downloading or extracting any package.
- **Fail-Closed Verification**: If an archive's SHA-256 hash or byte size deviates from the signed manifest, the installation aborts immediately.
- **Active Judging Mutex**: When a judging session is running, any API request attempting to modify preferences, initiate toolchain discovery, download, or uninstall returns `HTTP 409 Conflict`.
- **Automatic Execution Policy Migration (`server/toolchains/migration.ts`)**: Migrates legacy configuration schemas transparently upon startup (`migrateLegacyExecutionPolicy`), eliminating complex manual configuration menus while upholding strict sandbox certification.

### 5.5. Standard Compilation Flags & Universal Precompiled Header (PCH)
- **C++ (C++14)**: `-pipe -O2 -s -static -lm -x c++` (on Windows, stack reserve is set to `66060288` bytes $\approx 63\text{ MiB}$).
- **C (C11)**: `-pipe -O2 -s -static -lm -x c` (stack reserve `66060288` bytes on Windows).
- **Pascal**: `-O2 -XS -Sg -Cs66060288`.
- **Java**: Compiled via `javac` into an isolated output folder; executed via main class.
- **Python**: Syntax pre-checked (`py_compile`) before direct execution under the isolated interpreter.
- **Universal C++ PCH (`server/judge/universal-pch.ts`)**:
  - Generates GCC `<bits/stdc++.h>` PCH through the bounded, verified compiler runner. Apple Clang uses the packaged textual compatibility header; automatic adjacent `.gch` loading is unsupported and explicit Clang PCH remains deferred.
  - Fingerprints the actual execution binary's canonical path, size, mtime, version, platform, flags and verified package/snapshot digest. A usable cache contains both regular header and PCH files.
  - Copies matching cached inputs into each compiler workspace and injects that workspace's include directory. Never grants compiler access to application data or writes generated PCH into a toolchain package.
- **Background Judge Pre-warming (`server/judge/background-prewarm.ts`)**:
  - Automatically initializes compiler caches and native sandbox runners in the background upon application startup.
  - Readiness waits for discovery, executor health, verified package preparation and certified-local C++ session validation. Windows managed C retains its existing cached compatibility warm-up; readiness no longer compiles and links an additional generic C/C++ submission. A cold C++ PCH cache still requires generation.
  - Opt-in `JUDGEDESK_JUDGE_TRACE=1` logs preparation, compiler frontend/link timing and backend/executor PID, job and run correlations without source, arguments or environment data.

### 5.6. Checkers, Interactors & Scoring Models
- **Standard Checkers**: Built-in implementations for `wcmp` (word-by-word), `lcmp` (line-by-line), `fcmp` (exact file), `yesno` (case-insensitive YES/NO), `floats` (floating-point with $\epsilon$ precision), `token`, `huge_int`, and `ncmp`.
- **Custom Checkers**:
  - C++ Checkers: Built using `testlib.h` (bundled directly in the distribution) and problem-local header files.
  - Python Checkers: Executed as isolated Python scripts.
- **Interactive Problems & Interactor Runner (`server/judge/interactor-runner.ts`)**:
  - Executes contestant code and interactor concurrently within isolated Windows AppContainers using bidirectional anonymous pipes (`contestant stdout -> interactor stdin`, `interactor stdout -> contestant stdin`).
  - Supports Interactors written in C++ (`testlib.h`) or Python.
  - Supports interactive problem suites providing only `.inp` files without requiring `.out` reference files.
- **Rational Scoring Engine (`server/judge/scoring.ts`)**:
  - Uses exact rational fraction arithmetic via greatest common divisor (`gcd(numerator, denominator)`).
  - Eliminates IEEE-754 floating-point drift (e.g. `0.35 * 10 = 3.5`, `1/3 + 2/3 = 1`), guaranteeing exact score preservation on the Scoreboard and in exported Excel workbooks.
- **Contest Packaging (`.judgedesk`)**: ZIP-based format containing `manifest.json`, `contestants/`, and `problems/`. Preserves scores, subtask configurations, test weights, and execution results.

---

## 6. Security & Native Sandbox Internals

JudgeDesk enforces strict defense-in-depth isolation against hostile contestant code (fork bombs, memory exhaustion, file system tampering, network exfiltration).

### 6.1. Windows Sandbox Architecture
1. **AppContainer Isolation**:
   - Each submission process executes under a dedicated AppContainer profile with Low Integrity tokens.
   - Network access is completely blocked (`networkBlocked = true`).
   - File writes are restricted to the allocated temporary run workspace; file reads additionally permit the minimum explicitly approved runtime and system resources.
2. **Windows Job Objects**:
   - **Memory Cap & Resource Envelope (`C03`)**: Configurable up to **1,024 MiB** (default 256 MiB). The submission or compiler process is strictly constrained by the Windows Job Object commit limit (`JOB_OBJECT_LIMIT_PROCESS_MEMORY` / `JOB_OBJECT_LIMIT_JOB_MEMORY`). For standard/representative problem configurations (`S256` / `S512`, `memoryLimit <= 512 MiB`), both the combined peak private committed memory (`PrivateMemorySize64`) and the combined peak un-deduplicated working set (`WorkingSet64`) of the entire process tree (App + WebView2 + Backend + Executor + Child) stay strictly below **`1,024 MiB` (`1 GiB`)**. When a problem is configured above `512 MiB` up to the **`1,024 MiB`** maximum (`SMAX` / `CMAX`), the combined peak private committed memory is bounded by **`<= 1,408 MiB` (`1.375 GiB` = `1,024 MiB` active Job Object commit quota + `384 MiB` `B384` app/host private commit budget)** and the combined peak un-deduplicated multi-process working set (`WorkingSet64`, which counts shared `msedge.dll` and Win32 system DLL pages in each of the 12+ host/WebView2 processes) is bounded by **`<= 1,792 MiB` (`1.75 GiB` = `1,024 MiB` active run working set + `768 MiB` un-deduplicated host working-set ceiling)** without artificial working-set trimming (`JOB_OBJECT_LIMIT_WORKINGSET`) that would induce paging jitter.
   - **CPU Affinity & Priority**: Each test is pinned to **1 logical processor** and runs at `BELOW_NORMAL_PRIORITY_CLASS` to prevent system freezes on low-spec teacher PCs.
   - **Kill on Job Close**: Closing the Job Object handle automatically terminates all descendant processes.

### 6.2. macOS Sandbox Architecture
1. **Run Guardian (`macos_run_guardian.rs`) & Seatbelt Sandbox**:
   - Applies strict kernel-level Seatbelt sandbox profiles to deny unauthorized file system access and block all network sockets.
2. **Process Groups & RLIMITs**:
   - Isolates the submission process tree in its own Process Group ID (`setpgid`).
   - Enforces `RLIMIT_NPROC` and `RLIMIT_AS` to contain fork bombs and memory allocation bursts.
   - Blocks `posix_spawn` group escape vectors.
3. **Generation Barrier & Tree Guard (`tree_guard.rs`)**:
   - Ensures all processes from the preceding generation have exited before admitting subsequent runs.

### 6.3. Linux Sandbox Architecture
1. **Bubblewrap (`bwrap`) + Namespace Isolation**:
   - Unshares network (`--unshare-net`), PID, IPC, and mount namespaces without requiring `root` privileges.
   - Mounts system libraries (`/usr`, `/lib`, `/lib64`) read-only and restricts writes to the ephemeral sandbox workspace.
   - Maps short sandbox bind mounts (`/jd-tools`, `/jd-work`) so compilers with tight path-length limits (such as Free Pascal) operate reliably on deep host directory paths, and sets `LANG=C.UTF-8` for Java runtime consistency.
2. **systemd User Scope (`cgroup v2`) & `seccomp-bpf`**:
   - Enforces peak memory limits (`MemoryMax` up to 1024 MB, `MemorySwapMax=0`), process count ceilings (`TasksMax`), accurate CPU time accounting (`cpu.stat`), and dangerous syscall filtering (`seccomp-bpf`).

### 6.4. Cancellation Drain Protocol
When a user clicks "Cancel Judging":
1. Backend sends a `cancel` request with `runId` to the Native Executor.
2. The Executor initiates process termination and enters a **Drain Loop** (timeout: 20 seconds).
3. The Executor returns `cancelled: true` only after verifying that the process container/group is **completely empty**.
4. If a process fails to drain before the timeout, the Executor enters a terminal exit state to force OS-level cleanup, refusing to accept new runs on an unverified environment.

---

## 7. Comprehensive Testing Pyramid & Quality Gates

All pull requests and release candidates must pass every tier of the testing pyramid:

```mermaid
graph TD
    A[Level 1: Lint & Typecheck] --> B[Level 2: Unit & Component Tests]
    B --> C[Level 3: Native Executor & Security Tests]
    C --> D[Level 4: Platform Resource & Concurrency Gates]
    D --> E[Level 5: End-to-End Stress Test Suite]
```

### 7.1. Test Command Suite

#### 1. Typecheck & Quality Invariant Gate
```powershell
npm run check:fast  # Runs Node check, tsc --noEmit, and check-quality-gate.js
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo fmt --check --manifest-path native-executor/Cargo.toml
```

#### 2. Dynamic Server & Feature Unit Tests
```powershell
npm run test:server  # Dynamically executes all 98 test suites on disk (>530 tests)
```
*(Executes 535+ automated tests covering submission parsing, rational scoring logic, custom checkers & interactors, Universal PCH, toolchain preferences, Scratch runtime, multi-language gates, and core dialogs/components).*

#### 3. Native Executor Tests (Rust)
```powershell
npm run test:executor
```

#### 4. Security Integration Tests
```powershell
npm run test:security
```
*(Validates sandbox resistance against unauthorized file reads, file overwrites, socket creation, fork bombs, thread bombs, memory over-allocation MLE, and output spam OLE).*

#### 5. Windows Resource & Single-Instance Gates (Windows)
```powershell
# Verify combined process tree stays within C03 resource envelope (< 1024 MiB for S256/S512; private <= 1408 MiB & working set <= 1792 MiB for SMAX 1024 MiB workloads)
npm run test:windows-resources

# Verify single-instance lock and secondary activation
npm run test:windows-single-instance
```

#### 6. macOS Platform Gates (macOS)
```bash
npm run test:macos-process-supervisor
npm run test:macos-packaged-checkers
```

#### 7. Performance Benchmarks
```powershell
npm run benchmark:executor -- --enforce
```

### 7.2. End-to-End Stress Testing (`stress_test_judge`)
The cross-platform stress test suite is located at `d:\Minh\Code\stress_test_judge`:
```powershell
$env:STRESS_TEST_ROOT='D:\Minh\Code\stress_test_judge'
npm run test:stress
```
The stress test suite validates:
- **Smoke**: Baseline AC submissions for C++ and Python.
- **Verdicts**: Exact CE, WA, RE, TLE, MLE, and OLE outcomes on problem `A_plus_B`.
- **I/O Modes**: File I/O (`freopen`), Standard I/O, and mixed configurations.
- **Checkers**: Floating-point (`Float_Check`), large integers (`Huge_Int`), Yes/No, Binary, Custom C++, and Custom Python.
- **Scoring**: Polygon subtask groupings and partial scoring.
- **Security**: Malicious contestants (`Sec_*` and `ZZ_DANGEROUS_*`) to ensure zero containment escapes.

---

## 8. Build, Packaging & Release Pipeline

### 8.1. Public Release Assets Allowlist
Every official release `<version>` uploaded to the public GitHub repository (`ducminh25/judgedesk`) contains the 8 baseline Windows/macOS assets plus the 6 Linux Core/Full packages (14 files total):

```text
1.  JudgeDesk_<version>_core_x64_en-US.msi      # Windows Core MSI Installer
2.  JudgeDesk_<version>_full_x64_en-US.msi      # Windows Full MSI Installer
3.  JudgeDesk_<version>_core_aarch64.dmg        # macOS Core Disk Image
4.  JudgeDesk_<version>_full_aarch64.dmg        # macOS Full Disk Image
5.  JudgeDesk_<version>_core_aarch64.app.tar.gz # macOS Core Auto-Updater Payload
6.  JudgeDesk_<version>_full_aarch64.app.tar.gz # macOS Full Auto-Updater Payload
7.  JudgeDesk_<version>_amd64.deb               # Linux Core Debian/Ubuntu Package
8.  JudgeDesk_<version>_full_amd64.deb          # Linux Full Debian/Ubuntu Package (All 6 languages offline)
9.  JudgeDesk-<version>-1.x86_64.rpm            # Linux Core Fedora/RHEL/openSUSE Package
10. JudgeDesk-<version>-full-1.x86_64.rpm       # Linux Full Fedora/RHEL/openSUSE Package (All 6 languages offline)
11. JudgeDesk_<version>_amd64.AppImage          # Linux Core Portable AppImage
12. JudgeDesk_<version>_full_amd64.AppImage     # Linux Full Portable AppImage (All 6 languages offline)
13. SHA256SUMS                                  # SHA-256 Checksums covering all public assets other than itself
14. latest.json                                 # Multi-Target Tauri Updater Manifest
```

### 8.2. Updater Manifest (`latest.json`) & Signed Admin Announcements
The `latest.json` file contains the 4 signed Windows/macOS platform targets (`windows-x86_64-core`, `windows-x86_64-full`, `darwin-aarch64-core`, `darwin-aarch64-full`) and the format-isolated Linux Core/Full targets (`linux-x86_64-deb-core`/`full`, `linux-x86_64-rpm-core`/`full`, `linux-x86_64-appimage-core`/`full`). Each target embeds the download URL, Ed25519 updater signature (`signature`), download size (`downloadSizeBytes`), and extracted install size (`installedSizeBytes`).

Separately from the Tauri updater, the **Signed Admin Announcements (`announcements-v1`)** subsystem publishes an Ed25519-signed static feed (`https://ducminh25.github.io/judgedesk/announcements/v1/feed.json`) via GitHub Pages on `ducminh25/judgedesk`, verified by the public key in `shared/announcements-trust.json` (see [`docs/admin-announcements-publishing.md`](docs/admin-announcements-publishing.md)).

### 8.3. Step-by-Step Release Procedure

```mermaid
sequenceDiagram
    participant Dev as Engineer / AI Agent
    participant PrivRepo as Private Repo (judgedesk-source)
    participant WinHost as Windows Build Host
    participant CodeMagic as CodeMagic CI (macOS M2)
    participant PubRepo as Public Repo (judgedesk)

    Dev->>PrivRepo: Bump version (8 files) & push tag v<version>
    Dev->>WinHost: npm run build:windows:release:local
    WinHost-->>Dev: Staged 2 MSIs (Core/Full) + metadata.json
    Dev->>PubRepo: Create draft prerelease v<version>-staging (upload MSIs)
    Dev->>CodeMagic: Trigger windows-updater-signing & macos-arm64-release
    CodeMagic-->>Dev: Return signed Tauri updater MSIs, DMGs & .app.tar.gz
    Dev->>Dev: node scripts/generate-updater-manifest.js -> latest.json
    Dev->>Dev: Generate SHA256SUMS & run verify-public-release-assets.js
    Dev->>PubRepo: Upload 8 public assets to draft release & publish
    Dev->>PubRepo: Delete temporary v<version>-staging tag
```

#### Step 1: Version Synchronization
Ensure identical version numbers across all 8 files. Verify with:
```powershell
npm run release:check-version
```

#### Step 2: Build Windows Installers
Run on a verified Windows build host:
```powershell
npm run build:windows:release:local
```
This builds `JudgeDesk_<version>_core_x64_en-US.msi` and `JudgeDesk_<version>_full_x64_en-US.msi` inside `release-assets-windows/`.

#### Step 3: CodeMagic macOS Build & Windows Signing
- Trigger `macos-arm64-release` on CodeMagic against the tagged commit.
- Trigger `windows-updater-signing` on CodeMagic to generate Tauri updater signatures for the Windows MSIs.

#### Step 4: Generate Manifest & Verify Public Assets
Generate `latest.json` from signed assets and verify compliance:
```powershell
node scripts/generate-updater-manifest.js
node scripts/verify-public-release-assets.js public-release-assets v<version>
```

#### Step 5: Publish Public Release
Create a draft release on `ducminh25/judgedesk`, attach the 8 allowed assets, perform anonymous download verification, and publish.

### 8.4. In-App Updater Mechanics (v1.5.0+)
- **One-Click Background Updates**: Regardless of whether the user originally installed Full or Core, the in-app updater downloads the lightweight Core update payload (~20 MB) directly in the background.
- **Settings & Toolchain Preservation**: 100% of user configurations, problem settings, and installed/bundled toolchains in `%LOCALAPPDATA%\ThemisV2\toolchains` are preserved intact across updates.
- **Restart Handoff**: A single click on the toolbar "Cập nhật ngay" / "Update Now" chip triggers atomic preparation (`prepare_for_update`) and in-place relaunch.

---

## 9. Coding Conventions & AI Agent Guidelines

All engineers and AI Agents contributing code must strictly adhere to the following conventions:

### 9.1. C++ Guidelines (Competitive Programming & Custom Checkers)
- **Headers**: Use `#include <bits/stdc++.h>`.
- **Namespace**: Use `using namespace std;`.
- **Fast I/O**: Include `ios_base::sync_with_stdio(false); cin.tie(0); cout.tie(0);`.
- **Indentation & Braces**: 4 spaces, K&R style (opening brace `{` on the same line).
- **Naming Conventions**: `camelCase` for functions and methods, `snake_case` for local and global variables.
- **Loops**: Use pre-increment `++i`.
- **Modularity**: Structure logic cleanly into helper functions (e.g., `void input()`, `void solve()`), keeping `int main()` concise.

### 9.2. TypeScript / Node.js Guidelines
- **Module System**: Pure ES Modules (`"type": "module"`). All relative imports must include the explicit `.js` extension (e.g., `import { ... } from "./runtime.js";`).
- **Strict Typing**: Avoid `any`. Use `readonly` arrays/objects for immutable state and `satisfies` for compile-time schema validation.
- **Atomic File Operations**: Never overwrite critical files directly in place. Write to a temporary file in the same directory (`.tmp`), call `fsync` if needed, and perform an atomic `fs.renameSync`.
- **Fail-Closed Security**: Reject and throw immediately upon encountering corrupted data, signature mismatches, or path traversal attempts. Never fallback to insecure defaults silently.

### 9.3. Rust Guidelines (Tauri Shell & Native Executor)
- **Safety**: Minimize `unsafe` blocks. Every `unsafe` block must include a comment justifying safety invariants.
- **Error Handling**: Avoid `unwrap()` and `expect()` in runtime server/executor paths. Always propagate errors using `Result<T, E>`.
- **Formatting & Linting**: Code must pass `cargo fmt --check` and `cargo clippy -- -D warnings`.
- **Resource Management**: Use RAII handles to ensure automatic cleanup of OS handles, Job Objects, and process groups upon leaving scope.

### 9.4. Internationalization (i18n) & UI Styling
- **No Hardcoded Strings**: All user-facing UI text must be defined in both `src/locales/en.json` and `src/locales/vi.json`.
- **Tailwind CSS**: Use Tailwind CSS v4 design tokens and CSS variables in `src/index.css` to ensure seamless Dark/Light theme switching.

### 9.5. Critical Invariants & Troubleshooting for AI Agents & New Developers
1. **8-File Version Lockstep**: Never bump a version number manually in one file. All 8 files listed in Section 1.3 must match, verified via `npm run release:check-version`.
2. **Compiler Command Staging vs Test Harness**: When calling `runCompilerWithLimits`, the compiler runner recognizes `--test-*` flags as test-harness directives. The Universal PCH injection (`-isystem`) must never be prepended when test flags are present.
3. **Fail-Closed Sandbox Policy**: Untrusted code runs in a zero-network OS sandbox (Windows AppContainer/LPAC or macOS Seatbelt). The policy applies to the complete submission process tree. File reads are limited to explicitly approved workspace, runtime, and system resources; file writes are limited to approved workspace/scratch areas. Unauthorized file access, network access, process execution, privilege escalation, and escape from the sandbox must be prevented before the prohibited operation has effects.
   - **Denied operations**: Return an ordinary OS denial or unavailable-resource error where supported. An ordinary access denial returned to the running submission must not, by itself, require immediate termination or an automatic RE/JE. If the program handles that error and continues running, judging continues normally; never pretend that the denied operation succeeded or suppress the program's actual failure.
   - **Normal judging rules**: This continuation rule does not override executor results. Exit status/signals, checker results, resource limits, cancellation, and complete process-tree cleanup still apply. A crash or exceeded limit keeps its usual verdict: `process_limit`/`thread_limit` remain RE, while `sandbox_denied`/`launch_error`/`internal_error` remain JE.
   - **Containment failures**: If required isolation cannot be established or verified, or containment becomes uncertain during execution, reject the run (and terminate its owned process tree if started) with a judge infrastructure error and diagnostics. Never silently fall back to insecure execution. Successful unauthorized access is a security failure, not a blocked attempt that may be ignored.
   - **Verification**: Tests must perform the prohibited operations and verify denied access, unchanged protected files, no network communication, inherited restrictions, and complete cleanup. Include a program that handles an ordinary denial and continues to a normal output/verdict. Security probes must not require a fatal response merely to prove that access was blocked.
4. **Rational Points vs Floating Points**: Never use native JavaScript floating-point division for problem scoring or summary totals. Always use the rational scoring methods from `server/judge/scoring.ts` to preserve exact fractions and avoid `0.30000000000000004` rounding artifacts.
5. **Atomic File Writes**: Any persistent state changes (e.g. `Config.cfg`, toolchain preferences, `.judgedesk` contest archives) must write to a temporary file (`.tmp`) first, followed by an atomic rename to prevent file corruption during sudden system shutdowns.
6. **No Background Processes Left Running**: The sidecar monitor (`parent-watchdog.ts`) terminates the backend within 3s of Tauri window destruction. Always ensure child process cleanup via RAII / Job Object / PGID kill mechanisms.

### 9.6. Autonomous Skill Activation Protocol for AI Agents
All AI Coding Agents (Antigravity, Cursor, Claude Code, GitHub Copilot, Codex, etc.) are governed by the **[AGENTS.md](AGENTS.md)** protocol and the engineering skills located in **`.agents/skills/`**. Agents are strictly required to **autonomously detect task intent and apply the relevant skills** (TDD, doubt-driven edge-case hunting, security threat modeling, 5-axis code review, and debugging) without requiring the user to explicitly invoke them.

---

## 10. Quick Command Cheatsheet

| Goal | Command |
| :--- | :--- |
| **Install Dependencies** | `npm ci` |
| **Fast Invariant & Type Gate** | `npm run check:fast` |
| **Typecheck & Lint** | `npm run lint` |
| **Run Server Unit Tests (98 suites)** | `npm run test:server` |
| **Comprehensive Pre-Commit Gate** | `npm run check:full` |
| **Launch Desktop App in Dev Mode** | `npm run test:desktop` |
| **Launch Frontend in Browser** | `npm run dev:frontend` |
| **Build Native Executor Binary** | `npm run build:executor` |
| **Build Node.js SEA Sidecar** | `npm run build:server` |
| **Run Security Integration Tests** | `npm run test:security` |
| **Run Judging Stress Tests** | `$env:STRESS_TEST_ROOT='D:\Minh\Code\stress_test_judge'; npm run test:stress` |
| **Verify Windows Memory Envelope (<1024MB)** | `npm run test:windows-resources` |
| **Verify Windows Single-Instance Guard** | `npm run test:windows-single-instance` |
| **Verify 8-File Version Synchronization** | `npm run release:check-version` |
| **Build Windows Local Core & Full MSIs** | `npm run build:windows:release:local` |
| **Verify Public Release Asset Allowlist** | `npm run release:verify-public-assets -- public-release-assets v<version>` |

---

*This document serves as the living engineering guide for JudgeDesk. Whenever architectural modifications, security policies, or supported languages change, keep this document synchronized.*
