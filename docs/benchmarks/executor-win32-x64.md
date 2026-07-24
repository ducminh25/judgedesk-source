# Native executor benchmark (win32/x64)

- Generated: 2026-07-24T14:16:10.592Z
- CPU: 13th Gen Intel(R) Core(TM) i5-13420H (12 logical CPUs)
- OS: Windows 11 Pro
- Runner: windows-lpac-job 1.2.5
- Workload: 5 × 1000 C++ no-op tests after 20 warmups

| Stage | p50 (ms) | p95 (ms) |
|---|---:|---:|
| Staging | 0.225 | 0.349 |
| Executor dispatch/IPC | 1.066 | 1.350 |
| OS sandbox setup | 5.472 | 7.113 |
| Dispatch + security setup | 6.562 | 8.324 |
| Execution | 43.948 | 63.226 |
| Result collection | 0.244 | 0.445 |
| Cleanup | 1.016 | 1.622 |
| End-to-end | 51.883 | 72.892 |

| Gate | Actual | Limit | Result |
|---|---:|---:|---|
| dispatchP50Ms | 1.066 | 5 | PASS |
| dispatchP95Ms | 1.350 | 10 | PASS |
| securitySetupP50Ms | 5.472 | 15 | PASS |
| securitySetupP95Ms | 7.113 | 25 | PASS |
| backendMemoryGrowthMiB | 0.000 | 100 | PASS |

Backend RSS growth: 0.00 MiB.
