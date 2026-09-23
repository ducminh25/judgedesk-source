# Native executor benchmark (win32/x64)

- Generated: 2026-09-19T07:02:22.856Z
- CPU: 13th Gen Intel(R) Core(TM) i5-13420H (12 logical CPUs)
- OS: Windows 11 Pro
- Runner: windows-lpac-job 1.5.0
- Workload: 5 × 1000 C++ no-op tests after 20 warmups

| Stage | p50 (ms) | p95 (ms) |
|---|---:|---:|
| Staging | 0.260 | 0.417 |
| Executor dispatch/IPC | 0.932 | 1.238 |
| OS sandbox setup | 8.495 | 10.758 |
| Dispatch + security setup | 9.460 | 11.818 |
| Execution | 35.873 | 40.226 |
| Result collection | 0.344 | 0.469 |
| Cleanup | 0.940 | 1.370 |
| End-to-end | 47.029 | 51.600 |

| Gate | Actual | Limit | Result |
|---|---:|---:|---|
| dispatchP50Ms | 0.932 | 5 | PASS |
| dispatchP95Ms | 1.238 | 10 | PASS |
| securitySetupP50Ms | 8.495 | 15 | PASS |
| securitySetupP95Ms | 10.758 | 25 | PASS |
| backendMemoryGrowthMiB | 0.000 | 100 | PASS |

Backend RSS growth: 0.00 MiB.
