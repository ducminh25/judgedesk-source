# JudgeDesk contest format

JudgeDesk contest files use the `.judgedesk` extension. Version 1 is a standard
ZIP container so it remains portable across Windows and macOS and can stream
large source/test trees without loading the whole contest into memory.

## Version 1 layout

```text
contest.judgedesk
├── manifest.json
├── contestants/
│   └── <contestant files and directories>
└── problems/
    └── <problem, checker, and test files and directories>
```

`manifest.json` contains:

- `format: "judgedesk-contest"` and `formatVersion: 1`;
- `appVersion`: the JudgeDesk version (e.g. `"1.5.0"`);
- `createdAt` and `savedAt`: ISO-8601 timestamps;
- `workspace`:
  - `contestants`: string array of discovered contestant folder names;
  - `problems`: string array of discovered problem folder names;
  - `selectedContestants`: map of contestant names to boolean active status;
  - `selectedProblems`: map of problem names to boolean active status;
  - `problemConfigs`: record mapping problem names to their `ProblemConfig` objects:
    - `timeLimit`: integer milliseconds (100 - 30000 ms);
    - `memoryLimit`: integer megabytes (**8 MB to 1024 MB**, default 256 MB);
    - `useStdIn`, `useStdOut`, `inputFile`, `outputFile`: I/O redirection settings;
    - `checkerType`: `"C1"` (token), `"C2"` (line), `"C3"` (float), or `"custom"`;
    - `isInteractive`: boolean flag indicating interactive problem;
    - `interactorType`: `"cpp"` | `"python"`;
    - `interactorFile`: relative path to interactor file (e.g. `"interactor.cpp"`);
    - `groups`: subtask definitions with weights, scoring modes (`"sum"` | `"all-or-nothing"`), testcase sets, and subtask dependencies;
    - `compile`: compiler preset (`"ThemisCompatibility"`, `"Cpp17"`, `"Cpp20"`, `"Custom"`) and custom compiler arguments.
  - `judgeResult`: snapshot of all evaluation verdicts and rational scores at the time of archiving:
    - `success`: boolean;
    - `contestants`: array of contestant grading records containing per-problem verdicts, compile error logs, testcase results with execution time (ms), peak memory (MB), and exact scores.

The two directory trees (`contestants/` and `problems/`) are copied byte-for-byte. ZIP entry names always use
forward slashes. Unix executable permission bits are preserved so custom
checkers continue to work after moving a contest between Macs.

## Example `manifest.json` structure

```json
{
  "format": "judgedesk-contest",
  "formatVersion": 1,
  "appVersion": "1.5.0",
  "createdAt": "2026-08-21T08:30:00.000Z",
  "savedAt": "2026-09-16T15:30:00.000Z",
  "workspace": {
    "contestants": ["user01", "user02"],
    "problems": ["BAI1", "INTERACTIVE"],
    "selectedContestants": { "user01": true, "user02": true },
    "selectedProblems": { "BAI1": true, "INTERACTIVE": true },
    "problemConfigs": {
      "BAI1": {
        "timeLimit": 1000,
        "memoryLimit": 256,
        "checkerType": "C1",
        "useStdIn": true,
        "useStdOut": true,
        "isInteractive": false
      },
      "INTERACTIVE": {
        "timeLimit": 2000,
        "memoryLimit": 512,
        "isInteractive": true,
        "interactorType": "cpp",
        "interactorFile": "interactor.cpp"
      }
    },
    "judgeResult": {
      "success": true,
      "contestants": []
    }
  }
}
```

## Safety and lifecycle

- Saves are written to a sibling temporary file and replace the destination
  only after the archive finishes successfully.
- Opening rejects absolute paths, `..` traversal, duplicate entries, symlinks,
  unexpected top-level entries, oversized manifests, excessive entry counts,
  and excessive uncompressed size.
- Opened contests are extracted under the OS temporary directory and cleaned
  on the next JudgeDesk startup.
- The format is not encrypted. A `.judgedesk` file can contain private contestant
  source code and should be protected like the original contest directories.

Any incompatible future layout must increment `formatVersion`; existing fields
must not be silently reinterpreted.
