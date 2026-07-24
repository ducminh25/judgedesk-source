# Windows packaged judging resource gate

- Generated: 2026-07-24T14:10:35.6705132Z
- App: JudgeDesk 1.2.5
- Workload: C++ compile/CE + managed Python MLE + CPU-loop TLE
- Sampling: 59 samples, every 100 ms
- Combined peak working set: **854.84 MiB**
- Budget: **1024 MiB**
- Memory gate: **PASS**
- Peak aggregate CPU: 196.39% of one core
  (16.37% of 12 logical processors)

This conservative measurement sums the working set of the packaged Tauri app,
WebView processes, backend, native executor, compiler and active submission.
The stress driver itself is excluded.
