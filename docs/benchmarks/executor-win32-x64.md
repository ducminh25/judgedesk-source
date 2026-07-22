# Native executor benchmark (win32/x64)

- Generated: 2026-07-22T06:53:37.065Z
- CPU: 13th Gen Intel(R) Core(TM) i5-13420H (12 logical CPUs)
- OS: Windows 11 Pro
- Runner: windows-lpac-job 1.2.1
- Workload: 5 × 1000 C++ no-op tests after 20 warmups

| Stage | p50 (ms) | p95 (ms) |
|---|---:|---:|
| Staging | 0.443 | 0.734 |
| Executor dispatch/IPC | 1.443 | 2.168 |
| OS sandbox setup | 8.657 | 13.507 |
| Dispatch + security setup | 10.186 | 15.400 |
| Execution | 48.601 | 66.802 |
| Result collection | 0.372 | 0.595 |
| Cleanup | 1.587 | 2.506 |
| End-to-end | 62.191 | 82.343 |

| Gate | Actual | Limit | Result |
|---|---:|---:|---|
| dispatchP50Ms | 10.186 | 5 | FAIL |
| dispatchP95Ms | 15.400 | 10 | FAIL |
| backendMemoryGrowthMiB | 0.000 | 100 | PASS |

Backend RSS growth: 0.00 MiB.
