# Codex independent re-verification prompt — WP0.5 after LOG-0077

Start only after Antigravity has stopped editing and submitted one synchronized frozen WP0.5 `VERIFYING` candidate. Read AGENTS.md, guidelines, CONSTRAINTS, the WP0.5 report, STATUS, WORKLOG, the LOG-0077 remediation prompt, source freeze/archive, host snapshots, and actual diff. Do not modify implementation, reset/stash/clean, bump versions, commit/push, or open WP0.6/WP0.7/G0.

The submitted candidate is `artifacts/wp0.5/remediation-log0077/`: freeze `source-freeze-log0077.json`, archive `judgedesk-wp05-log0077-source.tar.gz`, Windows log `check-full-windows.log`, macOS log `macos-gate.log`, and host comparison `host-comparison.json`. Treat prior LOG-0074/v3 evidence as historical only.

Verify intake first: recompute every frozen content/size/mtime record; recompute archive size/hash/member count; directly parse archive entries and verify every normalized path and content SHA-256 against the freeze. Re-run the focused `c_mle_stdio` corpus execution and compiler watchdog regression. Verify all authoritative toolchain diagnostics are independently reported, including managed Python and Java, and confirm genuine profile failure still continues through later profiles with a nonzero aggregate.

Recheck the A–J matrix, bounded timeout/output behavior of `run-rust-gates.js`, entry-point graph, expected-skips schema/predicates, runtime/scoring boundaries, CI/package composition, structural regressions, and raw owned-host comparison. Only when every independent precondition passes, run one enclosing Windows `npm run check:full` and the byte-identical live macOS gate. Otherwise return `IN_PROGRESS` with exact evidence and create the next remediation/reverify prompts.
