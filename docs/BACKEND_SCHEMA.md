# Backend REST/SSE API & Data Schemas — JudgeDesk

**Project Name**: JudgeDesk  
**Document Status**: Official / Approved  
**Classification**: Technical API & Wire Schema Reference  

---

## 1. REST & SSE Endpoint Specification

All endpoints are hosted locally on `http://127.0.0.1:<PORT>` and protected by the internal `X-JudgeDesk-Token` session token.

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
Reads `Config.cfg` or Polygon subtask configuration for the problem.
* **Response (200 OK)**:
```json
{
  "success": true,
  "data": {
    "timeLimit": 1000,
    "memoryLimit": 256,
    "checkerType": "C1",
    "useStdIn": true,
    "useStdOut": true,
    "inputFile": "",
    "outputFile": "",
    "isInteractive": false,
    "interactorType": "cpp",
    "interactorFile": "",
    "totalScore": 100,
    "defaultScore": 1,
    "groups": {
      "Subtask 1": {
        "score": 40,
        "mode": "all-or-nothing",
        "tests": ["test1", "test2", "test3"],
        "dependencies": []
      },
      "Subtask 2": {
        "score": 60,
        "mode": "sum",
        "tests": ["test4", "test5"],
        "dependencies": ["Subtask 1"]
      }
    },
    "compile": {
      "preset": "ThemisCompatibility",
      "cppArgs": ["-O2", "-std=c++14"],
      "cArgs": ["-O2"]
    }
  }
}
```
*(Note: `memoryLimit` accepts values from 8 MB to 1024 MB with 256 MB as default).*

#### `POST /api/polygon-config`
Writes updated problem configuration back to `Config.cfg`.
* **Request Body**:
```json
{
  "path": "C:\\Contest\\Tests\\BAI1",
  "config": { /* ProblemConfig object */ }
}
```
* **Response (200 OK)**: `{ "success": true }`

---

### 1.3. Batch Judging & Evaluation Engine

#### `POST /api/batch-judge`
Initiates a batch judging session. Yields a real-time Server-Sent Events (`text/event-stream`) response.
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
* **SSE Stream Event Types**:
  1. `event: job_start`
     ```json
     { "jobId": "e1f70519-89b3-4b61-9f93-c90684fbb7a1", "totalTargets": 4 }
     ```
  2. `event: test_progress`
     ```json
     {
       "contestant": "user01",
       "problem": "BAI1",
       "test": "test1",
       "verdict": "AC",
       "timeMs": 45,
       "memoryMb": 12.4,
       "score": 1.0,
       "maxScore": 1.0
     }
     ```
  3. `event: problem_completed`
     ```json
     {
       "contestant": "user01",
       "problem": "BAI1",
       "problemResult": {
         "problemName": "BAI1",
         "score": 100.0,
         "totalScore": 100.0,
         "tests": [
           { "testName": "test1", "verdict": "AC", "time": 0.045, "memory": 12.4, "score": 1.0 }
         ],
         "compileError": null,
         "judgedAt": "2026-08-21T11:00:00.000Z"
       }
     }
     ```
  4. `event: job_complete`
     ```json
     { "jobId": "e1f70519-89b3-4b61-9f93-c90684fbb7a1", "success": true }
     ```

#### `POST /api/terminate-judge`
Cancels the actively running judging session.
* **Request Body**: `{ "jobId": "e1f70519-89b3-4b61-9f93-c90684fbb7a1" }`
* **Response (200 OK)**: `{ "success": true, "message": "Job terminated" }`

---

### 1.4. Online Submission Drop (OSD)

#### `GET /api/osd/status`
Returns live state of the background folder watcher and active submission queue.
* **Response (200 OK)**:
```json
{
  "active": true,
  "dropDirectory": "D:\\SharedContest\\Submissions",
  "queueLength": 2,
  "processedCount": 15
}
```

#### `POST /api/osd/start`
Starts monitoring the submission directory.
* **Request Body**:
```json
{
  "dropDirectory": "D:\\SharedContest\\Submissions",
  "thisinhPath": "C:\\Contest\\Contestants",
  "testPath": "C:\\Contest\\Tests",
  "problemConfigs": { /* ProblemConfigs map */ }
}
```
* **Response (200 OK)**: `{ "success": true }`

#### `POST /api/osd/stop`
Stops the submission directory watcher.
* **Response (200 OK)**: `{ "success": true }`

#### `GET /api/osd/stream`
SSE Stream emitting real-time events when new submissions arrive and finish grading.
* **Events**: `osd_queue_update`, `osd_submission_discovered`, `osd_problem_completed`.

---

### 1.5. Toolchains & Certification Engine

#### `GET /api/toolchains`
Returns the status of all supported programming languages and compilers.
* **Response (200 OK)**:
```json
{
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

---

## 2. File & Wire Format Specifications

### 2.1. Contest Container Manifest (`manifest.json`)
Located in the root of `.judgedesk` ZIP archives:
```json
{
  "format": "judgedesk-contest",
  "formatVersion": 1,
  "appVersion": "1.4.43",
  "createdAt": "2026-08-21T08:30:00.000Z",
  "savedAt": "2026-08-29T10:00:00.000Z",
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
