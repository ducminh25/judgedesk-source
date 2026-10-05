# Codex independent re-verification prompt — WP0.5 after LOG-0079

Start from the synchronized LOG-0080 WP0.5 `VERIFYING` candidate. Read AGENTS.md, guidelines, CONSTRAINTS, the WP0.5 report, STATUS, WORKLOG, `wp0.5-antigravity-remediate-log0079.md`, the actual diff, and `artifacts/wp0.5/remediation-log0079/` including the freeze, archive, Windows/macOS logs and host snapshots. Do not modify implementation, reset/stash/clean, bump versions, commit/push, or open WP0.6/WP0.7/G0.

Treat `artifacts/wp0.5/remediation-log0077/` and its Windows/macOS gates as rejected historical evidence. Verify intake first: recompute every frozen content/size/mtime record; recompute archive size/hash/member count; directly parse archive streams and validate each normalized regular-file path, size, and SHA-256 against the freeze. Re-run the corpus execution that reaches `c_mle_stdio` and the compiler-watchdog regression. Confirm the result is compile `OK` followed by the expected runtime MLE, not a compilation timeout.

Verify authoritative toolchain diagnostics are independently reported for every release profile, including managed Python and Java, and that a genuine profile failure continues through later profiles and returns an aggregate nonzero result. Recheck the A–J matrix, bounded timeout/output and continue-and-aggregate behavior of `run-rust-gates.js`, entry-point graph, expected-skips schema/predicates, runtime/scoring boundaries, CI/package composition, structural regressions, raw owned-host comparison, and the remediation's caller audit.

Only when every independent precondition passes, run one enclosing Windows `npm run check:full` and the byte-identical live macOS gate. Otherwise return `IN_PROGRESS` with exact evidence and create the next remediation/reverify prompts.
