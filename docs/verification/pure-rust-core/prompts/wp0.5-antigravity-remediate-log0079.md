# Antigravity remediation prompt — WP0.5 LOG-0079

Remediate only WP0.5 in the preserved dirty checkout `D:/Minh/Code/judgedesk`. Do not start WP0.6/WP0.7/G0, bump versions, reset/stash/clean, commit/push, add dependencies, delete or skip tests, weaken limits or thresholds, change release/profile authority, add a compiler/runtime fallback, or alter accepted WP0.1–WP0.4 boundaries.

LOG-0079 independently verifies the submitted LOG-0078 source identity, then reproduces the release-blocking corpus failure with:

```powershell
node scripts/run-all-tests.js --filter=corpus
```

The execution reaches `c_mle_stdio` and fails after 115,547 ms: expected compilation `OK`, actual `CE / COMPILER_TIMEOUT`. The candidate's Windows/macOS logs are historical evidence only; do not rerun a full gate until this precondition is independently green.

Follow the debugging protocol before editing. Capture the precise compiler/executor result, resolved managed-C executable and argv, wall/memory/process/output limits, workspace staging, and duration. Audit every caller across `server/judge`, `server/executor`, toolchain resolution, and the native executor. In particular, test rather than assume whether session-scoped `runJudgeSession()` prewarming can affect the direct `compileSubmission()` path used by the corpus oracle. Distinguish cold startup, compilation, toolchain preparation, test ordering, and executor verdict mapping; do not convert the timeout to a skip or mask it by widening untrusted-submission limits.

Drive the remediation RED/GREEN. Add or refine a focused regression that deterministically proves managed-C `c_mle_stdio` compilation succeeds through its actual production invocation path while the deliberately stuck compiler still fails closed as `COMPILER_TIMEOUT`. Preserve C/C++ toolchain readiness and managed-root checks, Python/Java diagnostic headroom, separately reported release profiles, continue-and-aggregate nonzero behavior for genuine diagnostic failures, rational scoring, and sandbox isolation.

After focused corpus and watchdog coverage pass, run authoritative diagnostics (including managed Python and Java), expected-skip/runtime/scoring/entry-point validators, and structural timeout/output/aggregate regressions. Only then create a new source freeze and archive, independently verify every frozen source content/size/mtime record and every archive member normalized path/content hash, capture truthful owned-host before/after evidence, run exactly one enclosing Windows `npm run check:full`, and run the byte-identical live macOS gate. Synchronize STATUS, WORKLOG, the WP0.5 report, artifacts, and the new reverify prompt to one frozen `VERIFYING` candidate; then stop editing.
