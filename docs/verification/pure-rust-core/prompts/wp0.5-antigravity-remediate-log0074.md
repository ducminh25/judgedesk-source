# Antigravity remediation prompt — WP0.5 LOG-0074

Remediate only WP0.5 in the preserved dirty checkout `D:/Minh/Code/judgedesk`. Do not start WP0.6/WP0.7/G0, bump versions, reset/stash/clean, commit/push, add dependencies, delete or skip tests, weaken thresholds, or alter the accepted WP0.1–WP0.4 boundary. A fresh Codex conversation independently reviews only a new synchronized frozen `VERIFYING` candidate.

LOG-0074 independently reproduced a release-blocking regression. The single sequential `npm run test:rust -- --json` attempted every component and failed `crates/judgedesk-core` tests with exit 101. The focused reproduction below isolates the persistent failure:

```powershell
cargo test --locked --manifest-path crates/judgedesk-core/Cargo.toml --test toolchain_diagnose_test -- --test-threads=1
```

`test_genuine_toolchain_diagnostics_orchestrator` records all six authoritative profiles, but it panics because managed Python exceeded its execution budget at 3,002 ms and managed Java at 5,008 ms, both with `WallTimeLimit` and exit code `1245970434`. `engine_execution_test` passes in isolated rerun; do not mask the orchestrator failure as test-order pollution.

Diagnose the shared runtime/diagnostic budget and process lifecycle root cause across the Rust core, executor and toolchain authorities. Preserve separately named profiles, continue-and-aggregate behavior, and aggregate nonzero for genuine failures. Do not make supported Python or Java optional, loosen limits indiscriminately, introduce a fallback compiler/runtime, or convert failures into expected skips.

Drive the fix with a focused RED/GREEN regression test. Audit every caller of the changed diagnostic/runner boundary. Re-run the full Rust gate once, then required non-enclosed structural/mutation checks. Only after all preconditions pass, create a fresh source freeze/archive and run exactly one enclosing Windows `npm run check:full`; then perform the identical-source live macOS gate. Re-capture truthful owned host before/after evidence and synchronize report, STATUS, WORKLOG and prompts to one `VERIFYING` candidate. Stop editing and hand off using `wp0.5-codex-reverify-log0074.md`.
