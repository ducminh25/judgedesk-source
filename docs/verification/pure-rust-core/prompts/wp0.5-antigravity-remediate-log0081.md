# Antigravity remediation prompt — WP0.5 LOG-0081

Remediate only WP0.5 in the preserved dirty checkout `D:/Minh/Code/judgedesk`. Do not start WP0.6/WP0.7/G0, bump versions, reset/stash/clean, commit/push, add dependencies, delete or skip tests, weaken limits or thresholds, change release/profile authority, add a compiler/runtime fallback, or alter accepted WP0.1–WP0.4 boundaries.

LOG-0080 passed independent source/archive intake, the direct corpus (`c_mle_stdio` compiled `OK` then reached runtime `MLE`), the compiler watchdog, every live release-profile diagnostic including managed Python and Java, the bounded Rust-gate structural mutations, expected-skip policy, runtime/scoring boundaries, entry-point graph, and raw owned-host comparison. It is nevertheless rejected by LOG-0081 before the enclosing Windows/macOS gates because the claimed diagnostic failure policy lacks a current, executable regression.

`crates/judgedesk-core/tests/toolchain_diagnose_test.rs` has six individual success-only profile tests and one success-only loop. Its orchestrator records failures in a vector and only asserts `failures.is_empty()` after the loop. It never creates a real diagnostic failure. Therefore it does not prove that a genuine profile failure leaves the later authoritative profiles attempted, separately reported, and causes the aggregate result to be nonzero.

Follow the debugging and TDD protocols before editing. Preserve the existing successful diagnostics. Add a deterministic, isolated regression through the real production diagnostic route/state — not a mock parser, a source-text assertion, renamed host runtime, deleted managed file, test skip, or widened limit — that makes exactly one authoritative release profile fail for a real supported reason. It must prove all of the following in one current run:

- every authoritative profile is attempted in the documented order, including profiles after the deliberately failed one;
- the deliberately failed row remains individually named and carries its real failure diagnostic;
- later profile rows remain independently reported from the production path; and
- the orchestrator aggregate is nonzero/failing while the regression test itself passes because that failure is the expected outcome.

Keep managed Python/Java cold-start headroom, direct managed-C warmup, the 15-second untrusted submission compiler watchdog, sandbox limits, toolchain readiness/managed-root checks, no-fallback policy, rational scoring, bounded `run-rust-gates.js` time/output behavior, and continue-and-aggregate behavior unchanged except where the minimal testable diagnostic orchestration contract needs a root-cause correction. Audit all diagnostic-route callers and relevant state/configuration paths before patching; make the test inject only isolated, owned state.

First run focused RED/GREEN diagnostics coverage, the direct corpus oracle, and the compiler-watchdog regression. Then run authoritative diagnostics, expected-skip/runtime/scoring/entry-point validators and their mutation coverage, structural gates, and the caller audit. Only after all preconditions pass, create one new source freeze/archive, independently verify every frozen content/size/mtime record and normalized archive member content hash, capture truthful owned-host before/after evidence, run exactly one enclosing Windows `npm run check:full`, and run the byte-identical live macOS gate. Synchronize STATUS, WORKLOG, the WP0.5 report, artifacts, and the next reverify prompt to one frozen `VERIFYING` candidate; then stop editing.
