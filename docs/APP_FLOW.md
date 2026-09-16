# App Flow & Sequence Diagrams — JudgeDesk

**Project Name**: JudgeDesk  
**Document Status**: Official / Approved  
**Classification**: System Architecture & Flow Specification  

---

## 1. Application Launch & Startup Guard Flow

The launch sequence ensures single-instance integrity, spawns the Node.js backend sidecar, and establishes a secure heartbeat connection.

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Tauri as Tauri Shell (Rust)
    participant Guard as Single Instance Mutex
    participant Sidecar as Backend Sidecar (Node SEA)
    participant UI as Frontend (React / WebView)

    User->>Tauri: Launch JudgeDesk executable
    Tauri->>Guard: Acquire %TEMP%/judgedesk.lock
    alt Lock already held (Second instance)
        Guard-->>Tauri: Lock busy
        Tauri->>Tauri: Bring existing window to focus & Exit
    else Lock acquired
        Guard-->>Tauri: OK
        Tauri->>Sidecar: Spawn server executable (--port, token, parentPid)
        Sidecar->>Sidecar: Start Express HTTP & SSE on 127.0.0.1
        Sidecar->>Sidecar: Initialize Parent Watchdog timer
        Tauri->>UI: Load index.html in WebView2 / WKWebView
        UI->>Sidecar: GET /api/status (Handshake & Token)
        Sidecar-->>UI: 200 OK (HostStatus, Sandbox Mode, Toolchain Profiles)
        UI->>UI: Render Workspace & Scoreboard (Ready state)
    end
```

---

## 2. Workspace Loading & Folder Discovery Flow

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant UI as Frontend (React)
    participant Native as Tauri Dialog Plugin
    participant Backend as Backend Sidecar
    participant FS as Local Filesystem

    User->>UI: Click "Load Problems" (F2) or "Load Contestants" (F3)
    UI->>Native: selectDirectory()
    Native-->>UI: Selected Absolute Directory Path
    UI->>Backend: GET /api/fetch-problems?path=<PATH>
    Backend->>FS: Readdir & Natural Sort directories
    Backend->>FS: Discover custom checkers (*.cpp, *.py)
    Backend-->>UI: JSON { success: true, data: [ProblemNames], customCheckers }
    UI->>Backend: GET /api/polygon-config?path=<ProblemPath>
    Backend->>FS: Read Config.cfg / polygon subtask configs
    Backend-->>UI: JSON { problemConfig, groups, testScores }
    UI->>UI: Populate Workspace state & Render Scoreboard Columns
```

---

## 3. Batch Judging Pipeline Flow

The judging pipeline evaluates selected contestants against selected problems inside the native sandbox.

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant UI as Scoreboard (React)
    participant Backend as Batch Judge Engine
    participant Registry as Toolchain Registry
    participant Compiler as Compiler Orchestrator
    participant Sandbox as Native Executor (Rust Sandbox)
    participant Checker as Checker Engine (Diff / Custom)

    User->>UI: Click "Grade" (F9) with selected targets
    UI->>Backend: POST /api/batch-judge (SSE Stream Request)
    Backend->>Backend: Generate unique Job ID & Lock Session
    Backend->>UI: SSE event: { type: "job_start", jobId }

    loop For each (Contestant, Problem) target
        Backend->>Backend: Discover source file (.cpp, .c, .py, .pas, .java, .sb3, .sb2, .sb)
        Backend->>Registry: Resolve active toolchain profile & flags
        
        alt Source requires compilation (C++, C, Pascal, Java)
            Backend->>Compiler: Compile source to temporary binary / class directory
            alt Compilation Error / Timeout (>15s)
                Compiler-->>Backend: Compilation Failure (CE)
                Backend->>UI: SSE event: { type: "problem_result", verdict: "CE", score: 0 }
            else Compilation Succeeded
                Compiler-->>Backend: Binary ready in sandbox directory
            end
        else Scratch Project (.sb3, .sb2, .sb)
            Backend->>Backend: Load Scratch TurboWarp headless engine (10-25ms/test)
        end

        loop For each Testcase directory (test1, test2, ...)
            alt Native Binary / Script
                Backend->>Sandbox: Execute binary with testcase input (Binary IPC Header)
                Sandbox->>Sandbox: Enforce CPU, Wall-clock, 8-1024MB RAM, 0-Network limits
                Sandbox-->>Backend: Execution Result (Time, Memory, ExitCode, Output)
            else Scratch Execution
                Backend->>Backend: Feed .INP via `ask and wait` & capture `say`/`think`
            end
            
            alt Sandbox Exception (TLE, MLE, RTE)
                Backend->>Backend: Record testcase verdict (TLE / MLE / RTE)
            else Clean Exit (Code 0)
                Backend->>Checker: Compare Output against Expected Answer (.out/.ans)
                alt Standard Diff / Float Epsilon
                    Checker-->>Backend: Match (AC) or Mismatch (WA)
                else Custom Checker (.exe / .cpp / .py)
                    Backend->>Sandbox: Run Checker binary/script (Input, Output, Answer)
                    Sandbox-->>Backend: Checker Exit Code & Verdict
                end
            end
            Backend->>UI: SSE event: { type: "test_progress", testName, verdict, time, memory }
        end

        Backend->>Backend: Compute Subtask / Group Scores via Rational Engine (GCD) & Check Dependencies
        Backend->>UI: SSE event: { type: "problem_complete", totalScore, verdicts }
    end

    Backend->>UI: SSE event: { type: "job_complete" }
    UI->>UI: Finalize Scoreboard Matrix & Mark Contest Dirty (*)
```

---

## 4. Online Judge (OSD) Submission Watcher Flow

```mermaid
sequenceDiagram
    autonumber
    actor Contestant
    participant DropDir as OSD Drop Directory (Shared LAN Folder)
    participant Watcher as OSD Watcher Engine
    participant Queue as FIFO Judge Queue
    participant JudgeEngine as Batch Judge Engine
    participant UI as Scoreboard (React)

    Contestant->>DropDir: Save submission file (e.g. 20260821_user01_bai1.cpp)
    Watcher->>DropDir: Detect file creation event (fs.watch / chokidar)
    Watcher->>Watcher: Debounce (500ms) to ensure file write completion
    Watcher->>Watcher: Parse filename: [timestamp]_[contestant]_[problem].[ext]
    Watcher->>Queue: Push submission task to FIFO queue
    Watcher->>UI: SSE event: { type: "osd_queue_update", queueLength }

    loop Process Queue sequentially
        Queue->>JudgeEngine: Dequeue next submission
        JudgeEngine->>JudgeEngine: Execute single-submission testcase evaluation
        JudgeEngine->>UI: SSE event: { type: "osd_problem_completed", contestant, problemResult }
        UI->>UI: Auto-discover contestant if new & Merge problem score onto Scoreboard
    end
```

---

## 5. Contest Container (`.judgedesk`) Save & Open Flow

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant UI as Frontend (React)
    participant Tauri as Tauri Shell
    participant Archive as Archive Engine
    participant FS as Temporary Filesystem

    Note over User,FS: SAVE CONTEST FLOW (Ctrl+S / Cmd+S)
    User->>UI: Save Contest (.judgedesk)
    UI->>UI: Build manifest.json (workspace paths, configs, current results)
    UI->>Tauri: saveContestArchive({ manifest, contestantsPath, testsPath })
    Tauri->>Archive: Create temp zip file `contest.tmp.zip`
    Archive->>Archive: Write manifest.json
    Archive->>Archive: Stream byte-for-byte `contestants/` and `problems/` trees
    Archive->>Tauri: Atomic rename `contest.tmp.zip` -> `contest.judgedesk`
    Tauri-->>UI: Saved file path
    UI->>UI: Mark contest clean (remove `*`)

    Note over User,FS: OPEN CONTEST FLOW (Ctrl+O / Cmd+O)
    User->>UI: Open Contest (.judgedesk)
    UI->>Tauri: chooseAndOpenContestArchive()
    Tauri->>Archive: Validate Zip Header & Entry Names (Reject `..`, symlinks, zip bombs)
    Archive->>FS: Extract contents into `%TEMP%/JudgeDesk_Contest_<UUID>/`
    Archive->>Tauri: Read & validate `manifest.json`
    Tauri-->>UI: Restored Workspace payload (Paths, ProblemConfigs, JudgeResults)
    UI->>UI: Hydrate Scoreboard & Workspace State
```

---

## 6. Score Export to Excel Flow (`F12`)

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant UI as Scoreboard UI
    participant Worker as Score Workbook Worker
    participant Backend as Express Backend (/api/open-excel)
    participant OS as Operating System

    User->>UI: Press F12 (Export Excel)
    UI->>Worker: buildScoreExport(judgeResults, activeContestants, activeProblems)
    Worker->>Worker: Generate Summary Worksheet (Rankings, Totals)
    Worker->>Worker: Generate Details Worksheet (Test verdicts, execution time, memory)
    Worker->>Worker: Encode Binary Score Export Wire Payload
    Worker-->>UI: Binary Payload Buffer
    UI->>Backend: POST /api/open-excel (Content-Type: application/vnd.judgedesk.score-export)
    Backend->>Backend: Write temporary workbook `%TEMP%/JudgeDesk_Scoreboard_<UUID>.xlsx`
    Backend->>OS: Invoke default spreadsheet viewer (cmd /c start or open)
    OS-->>User: Excel / Numbers / Calc window opens with formatted scoreboard
```

---

## 7. Early Toolchain Migration & Fast In-App Update Flow

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant UI as Frontend App
    participant Updater as Tauri Plugin Updater
    participant Backend as Backend Sidecar (SEA)
    participant Migration as Migration Engine
    participant AppData as %LOCALAPPDATA%/ThemisV2/toolchains

    Note over Backend,AppData: 1. EARLY MIGRATION ON STARTUP
    Backend->>Migration: migrateLegacyBundledToolchains()
    alt Legacy toolchains detected in Program Files
        Migration->>AppData: Move / Copy toolchain packages & preserve .judgedesk-package.json
        Migration->>Backend: Delete legacy source folder (Free ~800MB disk space)
    end
    Backend->>Backend: Inspect AppData toolchains -> Mark 100% Certified / Ready

    Note over User,Updater: 2. FAST IN-APP UPDATE (~20 MB)
    User->>UI: Click "Update" button on toolbar
    UI->>Updater: check({ target: "windows-x86_64-core" })
    Updater-->>UI: New update candidate available (Core ~20 MB)
    UI->>UI: Show streamlined update dialog (Recommended Core)
    User->>UI: Click "Install and Restart"
    UI->>Updater: downloadAndInstall() [~3-5 seconds]
    Updater->>Updater: Execute lightweight MSI upgrade
    Updater->>UI: Relaunch JudgeDesk with updated binaries
    Note over UI,AppData: Compilers in AppData remain 100% intact and ready to judge
```

---

## 8. Interactive Problem Evaluation Flow

```mermaid
sequenceDiagram
    autonumber
    participant JudgeEngine as Batch Judge Engine
    participant InteractorRunner as Interactor Runner (server/judge/interactor-runner.ts)
    participant Pipe1 as Pipe: Interactor Out -> Contestant In
    participant Pipe2 as Pipe: Contestant Out -> Interactor In
    participant ContestantAppContainer as Contestant AppContainer Job
    participant InteractorAppContainer as Interactor AppContainer Job

    JudgeEngine->>InteractorRunner: runInteractiveTestcase({ contestantBin, interactorBin, inputFile })
    InteractorRunner->>InteractorRunner: Create bidirectional anonymous Win32 pipes
    InteractorRunner->>ContestantAppContainer: Spawn Contestant with Pipe1(read), Pipe2(write)
    InteractorRunner->>InteractorAppContainer: Spawn Interactor with Pipe2(read), Pipe1(write), inputFile
    
    par Concurrent Exchange
        InteractorAppContainer->>Pipe1: Send query / challenge
        Pipe1-->>ContestantAppContainer: Receive query via stdin
        ContestantAppContainer->>Pipe2: Respond with answer via stdout
        Pipe2-->>InteractorAppContainer: Receive response via stdin
    end

    alt Contestant violates limits (TLE / MLE / RTE)
        InteractorRunner->>ContestantAppContainer: Terminate AppContainer
        InteractorRunner->>InteractorAppContainer: Terminate Interactor
        InteractorRunner-->>JudgeEngine: Verdict: TLE / MLE / RTE
    else Interactor exits successfully (Code 0)
        InteractorRunner-->>JudgeEngine: Verdict: AC (Passed)
    else Interactor exits with Code 1..n / testlib verdict
        InteractorRunner-->>JudgeEngine: Verdict: WA / Presentation Error
    end
```

---

## 9. Universal Precompiled Header (PCH) & Background Pre-warming Flow

```mermaid
sequenceDiagram
    autonumber
    participant App as JudgeDesk App Launch
    participant Prewarm as Background Pre-warm (background-prewarm.ts)
    participant PchEngine as Universal PCH (universal-pch.ts)
    participant Cache as PCH Cache Dir (%LOCALAPPDATA%/ThemisV2/pch)
    participant Compiler as Compiler (GCC/Clang)
    participant JudgeBatch as Active Judging Batch

    App->>Prewarm: startBackgroundJudgePrewarm()
    Prewarm->>PchEngine: ensureUniversalCppPch(effectiveToolchain)
    PchEngine->>PchEngine: Compute 16-hex fingerprint (path + size + mtime + compiler -v)
    PchEngine->>Cache: Check for existing bits/stdc++.h.gch
    alt Cached .gch exists and intact
        Cache-->>PchEngine: Cache hit (Valid .gch found)
    else Cache miss / Not yet generated
        PchEngine->>Compiler: Compile <bits/stdc++.h> -> <cache_dir>/bits/stdc++.h.gch (-std=c++14 -O2 -pipe)
        Compiler-->>PchEngine: Generation complete
    end
    PchEngine-->>Prewarm: Precompiled Header Ready
    Prewarm->>Prewarm: Handshake complete (Ready state)

    Note over JudgeBatch,PchEngine: RUNTIME JUDGING SESSION
    JudgeBatch->>PchEngine: getPchDirectoryForToolchain(cppToolchain)
    PchEngine-->>JudgeBatch: Return <cache_dir>
    JudgeBatch->>Compiler: Prepend "-isystem <cache_dir>" to compilation args
    Compiler-->>JudgeBatch: C++ Compilation finishes in ~0.23s (16.5x faster)
```
