# Antigravity remediation — WP0.4 LOG-0064-F1 only

Remediate only the WP0.4 finding recorded in LOG-0064. Work in the saved dirty checkout at D:/Minh/Code/judgedesk. Preserve the accepted WP0.3 baseline, all existing dirty work, every historical log and evidence artifact, and the eight-file application version lockstep at 1.5.1. Do not reset, stash, clean, commit, push, rewrite history, accept WP0.4, close G0, or begin WP0.5.

## Finding

The submitted executor boundary suite can select native-executor/target/debug/judgedesk-native-executor.exe through locate_executor_binary, while the LOG-0063 freeze records only the staged src-tauri/binaries executor. The debug executable exists but is not frozen and predates LOG-0061 source changes. The Node rollback test then forces that helper-selected path through JUDGEDESK_EXECUTOR_PATH, which the production Node resolver prioritizes. Consequently the reported lifecycle and rollback tests do not establish behavior of the frozen packaged candidate.

## Required remediation

1. Add a regression that fails if a packaged-boundary test resolves an implicit or stale target/debug executable. Make the test explicitly identify the exact packaged candidate being exercised; assert its canonical path and SHA-256 against the frozen candidate identity.
2. Remove silent debug-binary fallback from tests used to substantiate packaged executor selection, parent/generation enforcement, lifecycle, updater contention, protocol failure and Node rollback. Any separately built test executable must have an explicit build recipe, source identity, output identity and freeze record.
3. Ensure the Node rollback test exercises the intended packaged candidate without substituting an un-frozen helper path through JUDGEDESK_EXECUTOR_PATH. Keep a separate override test only if it is clearly classified as override behavior and does not claim packaged selection.
4. Reconcile the full test inventory and matrix (a)–(j) with real assertions and the exact executable each assertion launches. Do not report an unexecuted row or a submitter-only result as PASS.
5. Freeze every actual production, test, build, packaging and runtime executable input. Record SHA-256, byte size, UTC mtime, build recipe/toolchain identity and source provenance for any generated executable. Revalidate the accepted 30-entry WP0.3 baseline unchanged.
6. Run focused RED/GREEN for the test-selection regression, then the applicable WP0.4 completion checks, direct lifecycle probes and owned-root before/after audit with delayed cleanup observation. Keep unsupported platform evidence explicit; Windows results do not prove macOS behavior.
7. Reconcile STATUS summary, WP0.4 row and Handoff YAML, WORKLOG, report and ADR 0001 to a new source-frozen VERIFYING submission. Append a new WORKLOG ID, retain LOG-0064 and earlier artifacts, prepare the next fresh Codex prompt, and stop. Do not self-accept.

Use the repository skills and quality floor required by AGENTS.md. The next Codex verifier must independently confirm the selected executable and its frozen identity before any stateful acceptance command.
