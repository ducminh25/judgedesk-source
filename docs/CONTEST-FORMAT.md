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
- the JudgeDesk app version and created/saved timestamps;
- discovered contestant/problem names;
- global time limit, problem configuration and current checkbox selections;
- all judging results available at the time of saving.

The two directory trees are copied byte-for-byte. ZIP entry names always use
forward slashes. Unix executable permission bits are preserved so custom
checkers continue to work after moving a contest between Macs.

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
