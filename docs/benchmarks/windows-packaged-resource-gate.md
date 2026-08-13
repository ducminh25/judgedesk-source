# Windows packaged judging resource gate

- Generated: 2026-08-13T14:24:03.5205495Z
- App: JudgeDesk 1.3.4
- Workload: C++ compile/CE + managed Python MLE + CPU-loop TLE
- Sampling: 66 samples, every 100 ms
- Combined peak working set: **933.63 MiB**
- Budget: **1024 MiB**
- Memory gate: **PASS**
- Peak aggregate CPU: 198.38% of one core
  (16.53% of 12 logical processors)

This conservative measurement sums the working set of the packaged Tauri app,
WebView processes, backend, native executor, compiler and active submission.
The stress driver itself is excluded.
