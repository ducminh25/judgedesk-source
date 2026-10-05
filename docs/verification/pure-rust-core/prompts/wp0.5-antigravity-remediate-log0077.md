# Antigravity remediation prompt — WP0.5 LOG-0077

Remediate only WP0.5 in the preserved dirty checkout `D:/Minh/Code/judgedesk`. Do not start WP0.6/WP0.7/G0, bump versions, reset/stash/clean, commit/push, add dependencies, delete or skip tests, weaken thresholds, change release/profile authority, or alter accepted WP0.1–WP0.4 boundaries. A fresh Codex conversation independently reviews only one new synchronized frozen `VERIFYING` candidate.

LOG-0077 reproduced a release-blocking Windows final-gate failure. The single enclosing `npm run check:full` passed fast quality and Rust 9/9, then `test:server` failed `server/test-fixtures/corpus/corpus.test.ts` after 122,753ms:

```text
c_mle_stdio: expected compile status OK, actual CE / COMPILER_TIMEOUT
```

The corpus case uses managed C (`c-gcc14`), `solution.c`, an 8 MB run-memory scenario, and a deliberate custom compile profile `-std=c11 -O0 -pipe`. Do not conflate its intended runtime MLE with compilation, treat the timeout as an expected skip, widen limits blindly, add a compiler/runtime fallback, or weaken native sandbox/resource controls.

Follow the debugging protocol before editing. Reproduce the corpus case in isolation; capture the compiler/executor result reason, resolved managed-C path and arguments, wall/memory/process/output limits, workspace staging, and duration. Test explicit hypotheses across the shared compiler/executor/toolchain boundary: (1) real managed-GCC startup/compile time exceeds the configured compiler wall budget; (2) compiler input/staging or the custom C profile alters the launched argument contract; (3) a managed toolchain/prewarm or test-order resource interaction creates a timeout; (4) the executor misclassifies another failure as `wall_time_limit`. Audit every caller of the affected compiler and executor boundary before choosing a root-cause fix.

Drive the fix RED/GREEN with a focused regression that proves `c_mle_stdio` compiles successfully under the intended production compiler policy while a deliberately stuck compiler still fails closed as `COMPILER_TIMEOUT`. Preserve independent diagnostic profiles, Python/Java cold-start policy, aggregate nonzero behavior after genuine profile failure, and all sandbox limits for untrusted submissions. Re-run the focused corpus case, compiler watchdog coverage, toolchain diagnostics, and required non-enclosed structural/validator checks.

Only after all preconditions pass, create a new source freeze/archive and independently verify every frozen content/size/mtime record plus every archive member path/content hash. Run exactly one enclosing Windows `npm run check:full`; then run the byte-identical live macOS gate. Re-capture truthful owned-host before/after evidence and synchronize report, STATUS, WORKLOG, artifacts, and `wp0.5-codex-reverify-log0077.md` to one new `VERIFYING` candidate. Stop editing and hand off.
