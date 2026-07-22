# Native executor benchmark (win32/x64)

- Generated: 2026-07-22T04:11:32.636Z
- CPU: 13th Gen Intel(R) Core(TM) i5-13420H (12 logical CPUs)
- OS: Windows 11 Pro
- Runner: windows-lpac-job 1.2.1
- Workload: 5 × 1000 C++ no-op tests after 20 warmups

| Stage | p50 (ms) | p95 (ms) |
|---|---:|---:|
| Staging | 0.209 | 0.403 |
| Executor dispatch/IPC | 1.041 | 1.614 |
| OS sandbox setup | 5.630 | 8.888 |
| Dispatch + security setup | 6.703 | 10.512 |
| Execution | 33.136 | 58.248 |
| Result collection | 0.210 | 0.490 |
| Cleanup | 0.948 | 1.791 |
| End-to-end | 41.476 | 68.951 |

| Gate | Actual | Limit | Result |
|---|---:|---:|---|
| dispatchP50Ms | 6.703 | 5 | FAIL |
| dispatchP95Ms | 10.512 | 10 | FAIL |
| backendMemoryGrowthMiB | 0.000 | 100 | PASS |

Backend RSS growth: 0.00 MiB.
