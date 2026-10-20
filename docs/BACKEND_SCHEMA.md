# Backend REST/SSE API & Data Schemas — JudgeDesk

**Project Name**: JudgeDesk  
**Document Status**: Official / Approved  
**Classification**: Technical API & Wire Schema Reference  

**Release context**: Eight application version files are synchronized at `v1.5.5` (`crates/judgedesk-core/Cargo.toml` at `1.5.1`; historical wire payload examples retain `1.5.0` where applicable). Current Pure-Rust Core migration targets `v1.6.0` (`WP10.3`).

---

## 1. REST & SSE Endpoint Specification

All desktop endpoints are hosted on the IPv4 loopback interface at
`http://127.0.0.1:<PORT>`. The Tauri shell generates a separate 256-bit session
token for every launch and passes it to the selected backend. The Node sidecar
consumes and deletes its environment copy before asynchronous startup work; the
token is not written to the desktop dev-state file.

Every REST and SSE request from the desktop frontend carries the token in
`X-JudgeDesk-Session`. Production backends reject requests unless all applicable
checks pass:

- `Host` is exactly `127.0.0.1:<PORT>`;
- `Origin`, when present, is a known Tauri or JudgeDesk development origin;
- non-preflight requests have the exact per-launch session token.

`OPTIONS` preflight does not carry the secret, but it still has to pass the Host
and Origin checks. Rejections use `API_SESSION_REQUIRED`, `API_HOST_REJECTED`, or
`API_ORIGIN_REJECTED`. Direct browser development remains a separate
non-production mode; production desktop code has no fixed-port or unauthenticated
fallback. The Content Security Policy permits Tauri IPC, the ephemeral loopback
HTTP port, and the exact Vite development WebSocket port only.

### 1.1. System & Host Information

#### `GET /api/status`
Returns host platform capability, active sandbox isolation mode, and server metrics.
* **Response (200 OK)**:
```json
{
  "status": "ready",
  "appVersion": "1.5.0",
  "platform": "win32",
  "arch": "x64",
  "sandbox": {
    "supported": true,
    "mode": "Native (AppContainer / Seatbelt)",
    "active": true
  },
  "activeJobsCount": 0
}
```

---

### 1.2. Workspace & Problem Management

#### `GET /api/fetch-contestants?path=<ENCODED_DIR_PATH>`
Returns a natural-sorted list of contestant directory names.
* **Response (200 OK)**:
```json
{
  "success": true,
  "data": ["user01", "user02", "user10"]
}
```
* **Error Response (404 Not Found)**:
```json
{
  "success": false,
  "code": "DIRECTORY_NOT_FOUND",
  "message": "Directory not found"
}
```

#### `GET /api/fetch-problems?path=<ENCODED_DIR_PATH>`
Returns problem folders and detected custom checker source files.
* **Response (200 OK)**:
```json
{
  "success": true,
  "data": ["BAI1", "BAI2", "BAI3"],
  "customCheckers": {
    "BAI1": ["checker.cpp"],
    "BAI2": [],
    "BAI3": ["chk.py"]
  }
}
```

#### `GET /api/fetch-polygon-tests?path=<DIR_PATH>&problem=<NAME>`
Returns test directories with input previews and file byte sizes.
* **Response (200 OK)**:
```json
{
  "success": true,
  "data": [
    { "name": "test1", "preview": "5 10\n1 2 3 4 5", "size": 18 },
    { "name": "test2", "preview": "100000 500000\n...", "size": 1048576 }
  ]
}
```

#### `GET /api/polygon-config?path=<PROBLEM_DIR_PATH>`
Reads `Config.cfg` or legacy `config.json` and returns a `NormalizedProblemConfig` object (`shared/contracts.ts`).
* **Response (200 OK)**:
```json
{
  "success": true,
  "data": {
    "testWellFormed": false,
    "useStdIO": true,
    "useStdIn": true,
    "useStdOut": true,
    "inputFile": "BAI1.INP",
    "outputFile": "BAI1.OUT",
    "totalScore": 100,
    "defaultScore": 20,
    "testScores": {},
    "memoryLimit": 256,
    "checkerType": "C1",
    "isInteractive": false,
    "interactor": "",
    "polygonConfig": {
      "enableGroups": true,
      "tests": {
        "test1": { "points": 20, "group": "Subtask 1", "timeLimit": 1000 },
        "test2": { "points": 20, "group": "Subtask 1", "timeLimit": 1000 },
        "test3": { "points": 30, "group": "Subtask 2", "timeLimit": 1000 },
        "test4": { "points": 30, "group": "Subtask 2", "timeLimit": 1000 }
      },
      "groups": {
        "Subtask 1": {
          "policy": "COMPLETE_GROUP",
          "dependencies": []
        },
        "Subtask 2": {
          "policy": "EACH_TEST",
          "dependencies": ["Subtask 1"]
        }
      }
    },
    "compile": {
      "schemaVersion": 1,
      "profile": "themis",
      "flags": {
        "cpp": ["-O2", "-pipe", "-std=c++14"],
        "c": ["-O2", "-pipe", "-std=c11"]
      }
    }
  }
}
```
*(Note: `memoryLimit` accepts values from 8 MB to 1024 MB with 256 MB as default; `compile.profile` accepts `"themis" | "modern_ioi_icpc_2025" | "icpc_world_finals" | "custom"` validated by `shared/compile-config.ts`).*

#### `POST /api/polygon-config`
Atomically writes updated problem configuration back to `Config.cfg`. `testWellFormed` defaults to false; when true, both backends validate discovered input files before saving and judging. Validation is read-only: nonempty file, LF/CRLF at the end of every line, no other bytes below 32, no leading/trailing or consecutive ASCII spaces, no leading/trailing empty lines. Diagnostics use one-based line and byte column, with `WellFormedCode` values `"empty" | "missing_eol" | "control_character" | "edge_space" | "consecutive_spaces" | "edge_empty_line"` (`shared/contracts.ts`).
* **Request Body**:
```json
{
  "path": "C:\\Contest\\Tests\\BAI1",
  "config": { /* ProblemConfig object */ }
}
```
* **Response (200 OK)**: `{ "success": true }`

For a read-only preview, send `validateOnly: true` with `config.testWellFormed: true` and optional `config.isInteractive`. Response (200): `{ "success": true, "data": { "tests": 5, "issues": [{ "code": "edge_space", "testName": "test01", "fileName": "sum.inp", "line": 1, "column": 1 }] } }`. Preview never writes config or test content. A normal save with invalid inputs returns 422, code `TEST_NOT_WELL_FORMED`, and the same diagnostics; existing `Config.cfg` stays intact.

The Tests editor keeps group assignment, membership, points, policies and dependencies in its draft until the outer Save. Range indices refer to the one-based, naturally sorted visible test list. Duplicates are deduplicated and reversed ranges accepted; invalid/out-of-range selections apply nothing. Group points are the rational sum of member test points. Group scoring counts only discovered tests and blocks points when a required group is missing or empty.

---

### 1.3. Batch Judging & Evaluation Engine

#### `POST /api/batch-judge`
Initiates a batch judging session. Yields a newline-delimited JSON (`application/x-ndjson`) stream and sets the `X-JudgeDesk-Job-Id: <jobId>` response header.
* **Request Body**:
```json
{
  "thisinhPath": "C:\\Contest\\Contestants",
  "testPath": "C:\\Contest\\Tests",
  "targetContestants": ["user01", "user02"],
  "targetProblems": ["BAI1", "BAI2"],
  "problemConfigs": { /* Record<ProblemName, ProblemConfig> */ },
  "jobId": "e1f70519-89b3-4b61-9f93-c90684fbb7a1"
}
```
* **NDJSON Stream Event Objects (`JudgeStreamEvent`)**:
  1. Initial `progress` event (`action: "progress.initializing"`):
     ```json
     { "type": "progress", "data": { "contestant": "", "problem": "", "action": "progress.initializing", "percent": 0 } }
     ```
  2. `metadata` event (`RunMetadata` with `build`, `executor`, and `toolchains` containing both `cpp` and `python`):
     ```json
     {
       "type": "metadata",
       "data": {
         "judgedAt": "2026-08-21T11:00:00.000Z",
         "platform": "win32",
         "arch": "x64",
         "toolchains": {
           "cpp": { "kind": "cpp", "source": "managed", "executablePath": "...", "version": "14.2.0" },
           "python": { "kind": "python", "source": "managed", "executablePath": "...", "version": "3.12.13" }
         }
       }
     }
     ```
  3. Per-test `progress` events:
     ```json
     {
       "type": "progress",
       "data": {
         "contestant": "user01",
         "problem": "BAI1",
         "action": "test1",
         "percent": 25
       }
     }
     ```
  4. `problem_completed` events:
     ```json
     {
       "type": "problem_completed",
       "data": {
         "contestant": "user01",
         "problemResult": {
           "name": "BAI1",
           "language": "cpp",
           "compileStatus": "OK",
           "tests": [
             { "name": "test1", "status": "AC", "score": 20, "executionTime": 45, "peakMemory": 12400 }
           ],
           "summary": {
             "status": "AC",
             "score": 100,
             "maxScore": 100,
             "scoreExact": 100,
             "maxScoreExact": 100,
             "passedTests": 4,
             "totalTests": 4,
             "totalTime": 180,
             "peakMemory": 12400
           }
         }
       }
     }
     ```
  5. Terminating `done` (or `error`) event:
     ```json
     { "type": "done", "data": { "success": true } }
     ```

* **Interactive Evaluation Architecture (`isInteractive: true`)**:
  - When `isInteractive` is enabled in `ProblemConfig`, the judge engine invokes `runInteractiveTest` (`server/judge/interactor-runner.ts`) instead of the standard pipeline.
  - Spawns contestant executable and interactor (`cpp` compiled binary or `python` script) under independent sandbox containers (Win32 AppContainer dual-job runner / macOS Seatbelt).
  - Establishes two bidirectional anonymous pipes:
    - Pipe A: Interactor Standard Output $\rightarrow$ Contestant Standard Input
    - Pipe B: Contestant Standard Output $\rightarrow$ Interactor Standard Input
  - Interactor reads test input `<test>.INP` and writes verdict / testlib diagnostics to its stderr.

* **Rational Scoring Engine (`server/judge/scoring.ts`)**:
  - All testcase weights and subtask scores are represented internally as irreducible fractions $\frac{N}{D}$ using Euclidean GCD reduction.
  - Eliminates IEEE 754 floating-point drift (e.g., preventing $0.3333333333333333 \times 3 \neq 1.0$).
  - Results in exact integer or exact decimal points displayed on the UI and exported to Excel.

#### `POST /api/batch-judge/cancel`
Cancels an active judging session (or records a 60s pre-admission cancellation tombstone if the `jobId` has not yet been admitted).
* **Request Body**: `{ "jobId": "e1f70519-89b3-4b61-9f93-c90684fbb7a1" }`
* **Response (200 OK)**: `{ "success": true, "cancelledRuns": 1 }` (returns `500` in Node if active native run cancellation fails to confirm).

---

### 1.4. Online Submission Drop (OSD)

#### `GET /api/osd/status`
Returns live state of the background folder watcher and active submission queue.
* **Response (200 OK)**:
```json
{
  "success": true,
  "status": {
    "isRunning": true,
    "osdPath": "D:\\SharedContest\\Submissions",
    "queueLength": 2,
    "judgedCount": 15
  }
}
```

#### `POST /api/osd/start`
Starts monitoring the submission directory (see `docs/osd-themis-compatibility.md` for Themis Web dotless filename, stability, `$History`, and `logs/<raw-filename>.log` contracts).
* **Request Body**:
```json
{
  "osdPath": "D:\\SharedContest\\Submissions",
  "contestantsPath": "C:\\Contest\\Contestants",
  "testPath": "C:\\Contest\\Tests",
  "enableLog": true,
  "problemConfigs": { /* ProblemConfigs map */ }
}
```
* **Response (200 OK)**: `{ "success": true, "status": { /* OsdStatus */ } }`

#### `POST /api/osd/stop`
Stops the submission directory watcher.
* **Response (200 OK)**: `{ "success": true, "status": { /* OsdStatus */ } }`

#### `GET /api/osd/events`
SSE Stream (`text/event-stream`) emitting real-time events when new submissions arrive and finish grading.

---

### 1.5. Toolchains, Execution Policy & Certification Engine

#### `GET /api/toolchains`
Returns the status of all supported programming languages, managed toolchains, discovery states, and the active `executionPolicy`.
* **Response (200 OK)**:
```json
{
  "distribution": { "edition": "core", "version": "1.5.0" },
  "platform": "win32",
  "arch": "x64",
  "preferences": { /* Stored toolchain preferences */ },
  "profiles": [
    {
      "id": "cpp-legacy-v1",
      "language": "cpp",
      "displayName": "GNU C++ Compiler",
      "version": "14.2.0",
      "isManaged": true,
      "isCertified": true,
      "binaryPath": "C:\\Users\\user\\AppData\\Local\\ThemisV2\\toolchains\\gcc-windows-x64\\bin\\g++.exe"
    },
    {
      "id": "python-cpython312",
      "language": "python",
      "displayName": "Python 3 Runtime",
      "version": "3.12.13",
      "isManaged": true,
      "isCertified": true,
      "binaryPath": "C:\\Users\\user\\AppData\\Local\\ThemisV2\\toolchains\\python-windows-x64\\python.exe"
    },
    {
      "id": "scratch-turbowarp-v1",
      "language": "scratch",
      "displayName": "Scratch Headless VM",
      "version": "0.1.7",
      "isManaged": true,
      "isCertified": true,
      "binaryPath": "managed:scratch"
    }
  ]
}
```

#### `POST /api/toolchains/rescan`
Requests an asynchronous re-detection scan of system PATH and local candidate compilers.
* **Response (202 Accepted)**:
```json
{
  "success": true,
  "discovery": { "status": "scanning", "lastScanned": "2026-09-16T15:00:00.000Z" }
}
```

#### `PUT /api/toolchains/execution-policy`
Validates and persists the local toolchain execution policy document (`execution-policy.json`). Note: there is no standalone `GET /api/toolchains/execution-policy` route; the active `executionPolicy` is returned within `GET /api/toolchains`. Internally, the resolver enforces per-language capability modes (`managed_only` for `pascal`, `java`, and `scratch`; `quick_verified_direct` or snapshot/certificate `freeze_required` for `cpp`, `c`, and `python`), while the HTTP endpoint strictly enforces `allowResourceOnlyLocalExecution: false`.
* **Request Body**: `{ "allowResourceOnlyLocalExecution": false }`
* **Response (200 OK)**:
```json
{
  "success": true,
  "executionPolicy": {
    "schemaVersion": 1,
    "allowResourceOnlyLocalExecution": false,
    "status": "ready"
  }
}
```


---

## 2. File & Wire Format Specifications

### 2.1. Contest Container Manifest (`manifest.json`)
Located in the root of `.judgedesk` ZIP archives:
```json
{
  "format": "judgedesk-contest",
  "formatVersion": 1,
  "appVersion": "1.5.0",
  "createdAt": "2026-08-21T08:30:00.000Z",
  "savedAt": "2026-09-16T15:30:00.000Z",
  "workspace": {
    "contestants": ["user01", "user02"],
    "problems": ["BAI1", "BAI2"],
    "selectedContestants": { "user01": true, "user02": true },
    "selectedProblems": { "BAI1": true, "BAI2": true },
    "problemConfigs": { /* Problem configs map */ },
    "judgeResult": {
      "success": true,
      "contestants": [ /* Full contestant results */ ]
    }
  }
}
```

### 2.2. Managed Toolchain Package Receipt (`.judgedesk-package.json`)
Located in the root directory of every managed package in `%LOCALAPPDATA%\ThemisV2\toolchains\<packageId>\`:
```json
{
  "schemaVersion": 1,
  "packageId": "gcc-windows-x64",
  "version": "14.2.0",
  "archiveSha256": "60ee5abba023cd6e1950ee678e26ca2efb0ab7516f1f602cb54084c99c34930e",
  "entrypointComponentId": "g++",
  "components": [
    {
      "id": "g++",
      "kind": "executable",
      "relativePath": "bin/g++.exe",
      "roles": ["compiler"]
    },
    {
      "id": "gcc",
      "kind": "executable",
      "relativePath": "bin/gcc.exe",
      "roles": ["compiler"]
    }
  ]
}
```

### 2.3. Standard Error Response Schema
All error responses from the backend follow a strict, non-leaking JSON structure:
```json
{
  "success": false,
  "code": "DIRECTORY_NOT_FOUND",
  "message": "Directory not found"
}
```
Standard Error Codes:
* `DIRECTORY_NOT_FOUND`
* `NOT_A_DIRECTORY`
* `PATH_REQUIRED`
* `DIRECTORY_ACCESS_ERROR`
* `CONFIG_READ_ERROR`
* `CONFIG_WRITE_ERROR`
* `COMPILER_TIMEOUT`
* `COMPILER_NOT_FOUND`
* `SANDBOX_FAILURE`
