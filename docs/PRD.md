# Product Requirements Document (PRD) — JudgeDesk

**Project Name**: JudgeDesk (formerly codenamed *ThemisV2*)
**Released Baseline**: `v1.6.1`
**Development Target**: `v1.6.1` (Pure Rust Core, Signed Admin Announcements & Multi-Platform Core/Full Desktop Release)
**Document Status**: Official / Approved
**Target Platform**: Windows 10/11 x64, macOS Apple Silicon (ARM64), Linux x86_64 (`amd64` — Ubuntu 22.04 LTS, 24.04 LTS, 26.04 LTS+ and compatible distributions)
**Repository**: Public Source (`ducminh25/judgedesk-source`) & Public Releases (`ducminh25/judgedesk`)

---

## 1. Executive Summary & Vision

### 1.1. Product Overview

**JudgeDesk** is a native, offline desktop automated grading software designed specifically for competitive programming contests, high-school Olympic training (HSG Quốc gia / Tỉnh), Tin học trẻ youth contests, computer science classrooms, and training camps.

JudgeDesk was conceived as the modern, cross-platform successor to legacy grading tools (such as *Themis*), solving major pain points including OS incompatibility, security vulnerabilities, silent crashes, lack of multi-language support (Python/Free Pascal/Java/Scratch), and sluggish, non-interactive user experiences.

### 1.2. Core Value Propositions

1. **100% Offline & Independent**: Runs entirely locally without requiring internet connectivity, cloud servers, or external databases during grading.
2. **Native OS Sandboxing**: Utilizes modern OS kernel isolation (Windows AppContainer + Job Objects, macOS Run Guardian + Seatbelt Sandbox, Linux Bubblewrap + systemd cgroup v2 + seccomp-bpf) to securely execute untrusted student submissions without risking host system corruption or infinite resource consumption.
3. **Themis Folder-Structure Compatibility**: Full backward compatibility with traditional Themis contest folder layouts, testcase hierarchies, and scoring conventions.
4. **Modern Competitive Programming Features**: Out-of-the-box support for Subtasks (Polygon Test Groups with cycle-safe dependencies), Custom Checkers (C++ with `testlib.h`, Python, and native Windows `.exe` binaries), Interactive Problems, and flexible point distributions.
5. **Multi-Language Support (6 Languages)**: Native support for C++, C, Python 3, Free Pascal, Java (OpenJDK 21), and Scratch (`.sb3`, `.sb2`, `.sb`) via headless TurboWarp VM.
6. **Real-Time Online Submission Grading (OSD)**: Background folder-watcher mode (`F8`) allowing live submission drops via shared network folders or contest management scripts with automatic evaluation and live scoreboard updates.
7. **Polished, Bilingual Desktop UX**: Bilingual interface (Tiếng Việt & English), dark/light themes, keyboard shortcuts (`F1`-`F12`), dynamic score sorting, Excel workbook export (`F12`), in-app update chip, and human-friendly 3-part error messaging.

---

## 2. Target Personas & Use Cases

### 2.1. User Personas

* **Persona 1: High School / Middle School CS Teacher & Contest Organizer (Thầy/Cô phụ trách đội tuyển HSG, Tin học trẻ)**
  * *Needs*: Easy contest setup, compatibility with existing test banks, fast batch grading of 30-100 students, instant Excel export with color-coded results for ranking and reporting, support for Scratch in youth divisions.
* **Persona 2: Competitive Programming Coach / Problem Setter (Huấn luyện viên Olympic)**
  * *Needs*: Subtask scoring (group-based points), custom checkers for multiple correct outputs (`.cpp`, `.py`, `.exe`), interactive problem evaluation, multi-language support (C++, C, Python 3, Pascal, Java), precise memory and time limit enforcement up to 1024 MB.
* **Persona 3: Student / Contestant in Mock Contests**
  * *Needs*: Live submission feedback via OSD folder watch, transparent error diagnostics without cryptic crashes, accurate time/memory profiling.

### 2.2. Key Use Scenarios

1. **Offline Mock Exam (Thi Thử HSG & Tin học trẻ)**: The teacher loads the problem folder and contestant submission folder, clicks *Grade* (`F9`), and watches the live scoreboard update in real time for C++, Pascal, Python, Java, or Scratch.
2. **Live Lab Contest with File Sharing (Chấm Trực Tuyến Qua Mạng LAN/OSD)**: The teacher starts OSD (`F8`) listening on a shared network drive. Students save their code to the shared folder; JudgeDesk automatically queues, compiles, evaluates, and merges results onto the master screen.
3. **Polygon Problem Configuration**: Problem setter opens the Problem Configuration modal, divides 50 test cases into 4 subtasks with dependencies, and assigns custom points per subtask.
4. **Contest Archival**: The organizer saves the entire contest session into a single `.judgedesk` archive to archive or transport to another machine.

---

## 3. Functional Requirements (FR)

### FR-1: Workspace & Contest Structure

* **FR-1.1**: Support flexible Contestant folder loading (`F3`) supporting `[Contestants]/[Contestant_Name]/[Problem_Name].[ext]` structure.
* **FR-1.2**: Support Problem/Testcase folder loading (`F2`) supporting `[Tests]/[Problem_Name]/[Test_ID]/[Problem_Name].inp` and `.out` (or `.ans`).
* **FR-1.3**: Automatic detection of available Custom Checkers (`.exe`, `.cpp` with local header auto-inclusion like `testlib.h`, or `.py` files inside the problem folder).
* **FR-1.4**: Natural sorting for contestant names and alphanumeric test directories (`test1`, `test2`, ..., `test10`).

### FR-2: Problem Configuration & Subtasks

* **FR-2.1**: Configuration of Time Limit (ms) and Memory Limit (MB, configurable from 8 MB to 1024 MB, default 256 MB).
* **FR-2.2**: I/O Mode selection: Standard I/O (stdin/stdout) vs. File I/O (`problem.inp` / `problem.out`).
* **FR-2.3**: Checker Type selection: Standard diff (ignoring trailing whitespace/newlines), float comparison with epsilon tolerance, or Custom Checker (C++/Python/Binary).
* **FR-2.4**: Polygon Subtask & Test Group Management:
  * Assign tests to groups/subtasks.
  * Define group dependencies (Test Group B requires Test Group A to pass).
  * Prevent circular dependencies with cycle detection.
  * Point allocation: per-test vs. all-or-nothing group score.

### FR-3: Multi-Language & Compilation Engine

* **FR-3.1**: Support for 6 programming languages: C++ (`.cpp`), C (`.c`), Python (`.py`), Free Pascal (`.pas`, `.pp`), Java (`.java`), and Scratch (`.sb3`, `.sb2`, `.sb`).
* **FR-3.2**: Configurable compilation flags (Themis-compatible vs. Modern C++20 / C++17 presets, ICPC presets, or custom compiler arguments).
* **FR-3.3**: Preflight verification: compiler existence check, compilation timeout (15s), maximum output binary size limit (32 MiB).
* **FR-3.4**: Clean isolation of compilation artifacts in temporary sandbox directories.
* **FR-3.5**: Scratch Headless Runner: Runs Scratch project files in Turbo Mode (10-25ms/testcase) without browser GUI overhead, translating `ask and wait` to stdin and `say`/`think` to stdout.

### FR-4: Sandboxed Testcase Execution

* **FR-4.1**: Execute contestant binaries in restricted sandbox environments with automatic background sandbox pre-warming.
* **FR-4.2**: Resource limits enforcement: CPU time limit, wall-clock timeout, peak memory usage (up to 1024 MB), process tree limits, file descriptor restrictions.
* **FR-4.3**: Verdict Classification:
  * `AC` (Accepted - 100% correct)
  * `WA` (Wrong Answer)
  * `TLE` (Time Limit Exceeded)
  * `MLE` (Memory Limit Exceeded)
  * `RTE` (Runtime Error / Crash / Non-zero exit code)
  * `CE` (Compilation Error)
  * `PE` (Presentation Error / Format mismatch)
  * `FL` (File Limit Exceeded / Excess output)

### FR-5: Real-Time Scoreboard & Live Judging Session

* **FR-5.1**: Server-Sent Events (SSE) live streaming of evaluation progress (current contestant, current problem, current testcase, execution time, memory, verdict).
* **FR-5.2**: Matrix Scoreboard displaying total scores, per-problem scores, and detailed testcase breakdowns with $O(1)$ hash indexing.
* **FR-5.3**: Target selection: check/uncheck specific contestants or problems to selectively grade or re-grade.
* **FR-5.4**: Dynamic Scoreboard Sorting: 3-state sorting toggle (Highest Score $\rightarrow$ Lowest Score $\rightarrow$ Default order), synchronized with header click.
* **FR-5.5**: Individual score deletion or problem score reset with automatic contest dirty-state tracking.

### FR-6: Online Submission Drop (OSD) Watcher

* **FR-6.1**: Real-time file system watcher on a designated submission directory with debounce handling (500ms).
* **FR-6.2**: Parser supporting Themis submission naming conventions: `[timestamp]_[contestant]_[problem].[ext]`.
* **FR-6.3**: FIFO evaluation queue with concurrent lock protection.
* **FR-6.4**: Live status indicator badge on toolbar (`F8`) showing active queue depth.

### FR-7: Contest Container (`.judgedesk`)

* **FR-7.1**: Portable zip container bundling `manifest.json`, contestants directory, problems directory, configurations, and judging results.
* **FR-7.2**: Atomic safe saving (write to temporary archive, then atomically replace destination).
* **FR-7.3**: Security validation on opening (reject zip bombs, path traversal `..`, symlinks, corrupted manifests).

### FR-8: Score Export to Excel (`F12`)

* **FR-8.1**: Export full contest results into formatted `.xlsx` spreadsheet with two worksheets:
  * *Summary*: Final rankings, total scores, individual problem scores, adhering strictly to the active visual scoreboard sort order.
  * *Details*: Per-testcase verdicts, times, memory, points, with problem columns sorted left-to-right.
* **FR-8.2**: Native OS invocation of spreadsheet viewer (Excel / Calc / Numbers) via system protocol handlers.

### FR-9: Toolchain Manager & Certification (`F6`)

* **FR-9.1**: Detection and configuration of system-installed and managed compilers (GCC/G++, Clang, Python, FPC, Temurin Java, Scratch VM).
* **FR-9.2**: Managed portable compiler distribution installation for Windows and macOS with Zero-Copy and AppData deduplication.
* **FR-9.3**: Toolchain Self-Test Probe: in-sandbox test execution to measure compilation, execution speed, and peak memory for each language.

### FR-10: Help Center & Human-Centric Error UX

* **FR-10.1**: Offline searchable Help Center (`F1`) with localized guides, shortcuts reference, Scratch submission rules, changelog history, and sanitized system diagnostic copying.
* **FR-10.2**: 3-part structured error messaging: **What happened**, **Why it happened**, and **Clear action with CTA button** in floating App Error Toasts.
* **FR-10.3**: PII and Backend sanitization: absolute computer paths and internal stack traces are stripped before rendering.

### FR-11: Fast In-App Updates & Zero-Copy Deduplication

* **FR-11.1**: Streamlined in-app update flow downloading lightweight Core updates (~20 MB) in 1-click without re-downloading unchanged toolchains.
* **FR-11.2**: Zero-Copy & Automatic Deduplication: Built-in toolchains in Full edition are executed in read-only mode, while redundant copies in user AppData are cleaned up to save ~800 MB disk space.
* **FR-11.3**: Automatic 100% Certified / Ready recognition: managed toolchains with official receipts are certified by default in Core edition without security warnings or extra user prompts.
* **FR-11.4**: Dual GitHub Release packaging across Windows, macOS, and Linux: publish both full all-in-one offline installers (Windows Full `.msi`, macOS Full `.dmg`, and Linux Full `.deb` / `.rpm` / `.AppImage` pre-bundling all 6 languages) for offline computer lab setup alongside lightweight Core installers.

### FR-12: Interactive Problem Evaluation & Interactors

* **FR-12.1**: Support for interactive competitive programming tasks via Win32 AppContainer dual-job isolation with bidirectional anonymous pipe streaming.
* **FR-12.2**: Interactor support written in C++ (`testlib.h`) or Python (`.py`).
* **FR-12.3**: Independent evaluation of input-only test suites (`.inp`) without requiring pre-computed `.out` answer files.
* **FR-12.4**: Reliable deadline and termination management ensuring neither submission nor interactor can hang indefinitely.

### FR-13: Rational Scoring Engine

* **FR-13.1**: Calculation of testcase, subtask, and total points using exact rational fraction arithmetic via greatest common divisor (`gcd(num, den)`).
* **FR-13.2**: Total elimination of IEEE-754 floating-point drift (e.g., `0.35 * 10 = 3.5`, `1/3 + 2/3 = 1`).
* **FR-13.3**: Exact decimal and fractional representation consistently maintained across Scoreboard view and exported Excel spreadsheets (`F12`).

### FR-14: Universal Precompiled Header (PCH) & Background Pre-warming

* **FR-14.1**: Automatic detection, compilation, and caching of `<bits/stdc++.h>` for all C++ compilers (Managed GCC, MinGW-w64, MSYS2 UCRT64, Apple Clang).
* **FR-14.2**: 16-hex fingerprint verification based on canonical path, file size, mtime, and compiler version string to guarantee safe cache invalidation.
* **FR-14.3**: Accelerates C++ compilation by up to ~16.5x (from ~3.6s down to ~0.23s).
* **FR-14.4**: Background pre-warming initializes compiler caches and sandbox environments at application startup, eliminating first-judge warmup latency.

### FR-15: Toolchain Execution Policy Auto-Migration

* **FR-15.1**: Automatic migration of legacy toolchain configuration snapshots to the secure certified execution model upon startup (`migrateLegacyExecutionPolicy`).
* **FR-15.2**: Streamlined Toolchain Manager (`F6`) eliminating redundant manual menus and experimental toggles.

### FR-16: Signed Admin Announcements & Notification Center

* **FR-16.1**: Toolbar notification bell icon displaying unread announcement badge counts, anchored notification list popover, and editorial-grade article reader modal supporting both Vietnamese and English.
* **FR-16.2**: Cryptographic verification of static announcement feeds (`feed.json` via GitHub Pages) using a dedicated Ed25519 trust root (`announcements-v1`), monotonic sequence anti-rollback watermarks, strict HTML allowlist sanitization, and SHA-256 verified native media decoding.
* **FR-16.3**: Offline-resilient local caching in the user application data directory so previously fetched announcements remain readable offline without interrupting judging sessions.

---

## 4. Non-Functional Requirements (NFR)


| Category           | Requirement              | Metric / Target                                                                                              |
| :------------------- | :------------------------- | :------------------------------------------------------------------------------------------------------------- |
| **Performance**    | Batch Judging Throughput | < 50ms overhead per testcase evaluation beyond the contestant runtime; C++ compilation < 300ms with PCH.     |
| **Memory Limit**   | Host Memory Footprint    | < 150 MB RAM for the entire frontend and backend process combined when idle.                                 |
| **Sandbox Memory** | Submission Memory Cap    | Configurable from 8 MB to 1024 MB per contestant process (default 256 MB); hard-killed on violation.          |
| **Compilation**    | Compiler Timeout         | Maximum 15 seconds per source code file.                                                                     |
| **Update Speed**   | In-App Update Latency    | < 5 seconds download time for Core updates (~20 MB) on broadband connections; < 3 seconds installation time. |
| **Security**       | Zero-Network Invariant   | 100% network packets blocked for contestant processes in Native Sandbox.                                     |
| **Portability**    | Standalone Distribution  | Single installer (MSI on Windows, DMG on macOS) with embedded Node SEA runtime.                              |
| **Compatibility**  | Backward Compatibility   | 100% compatible with Themis contest folders, `Config.cfg`, and legacy `.judgedesk` archives.                 |
| **Reliability**    | Zero Silent Errors       | Every failure must be captured, logged, and clearly communicated to the user.                                |
| **Localization**   | Multi-language UI        | 100% complete Vietnamese (`vi.json`) and English (`en.json`) localization.                                   |

---

## 5. Success Metrics & Quality Gates

* **Automated Test Coverage**: 100% pass rate across the full test suite (492 tests: 482 passed, 0 failed, 10 skipped).
* **Zero Compilation Regressions**: Typecheck (`tsc --noEmit`) clean with zero errors.
* **Seamless Cross-Platform Parity**: Identical scoring outcomes on Windows x64 and macOS Apple Silicon.
