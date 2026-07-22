# JudgeDesk security fixtures

These programs are intentionally hostile. They must only be compiled and executed through the
native executor after its startup self-test reports `ready: true`. The integration harness rejects
any direct `child_process`/raw-spawn path.

The Rust executor's built-in test modes are used for deterministic limit-boundary repetitions;
the C++ and Python sources exercise the same behaviors through the production language paths.
