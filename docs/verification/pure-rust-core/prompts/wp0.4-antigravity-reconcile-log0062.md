# Prompt — reconcile WP0.4 handoff after LOG-0062 intake

You are the WP0.4 implementer. Address only the handoff-intake failure recorded in `docs/verification/pure-rust-core/wp0.4-executor-boundary.md` Section 11 and `WORKLOG.md` LOG-0062. Do not start WP0.5, close G0, bump versions, commit, or rewrite history. Preserve the saved dirty checkout and every earlier log/evidence artifact.

## Required work

1. Read the current `AGENTS.md`, `guidelines.md`, `CONSTRAINTS.md`, detailed and efficient-execution plans, STATUS, WORKLOG, ADR 0001, WP0.4 report Sections 10–11, LOG-0060 findings, LOG-0062 evidence, and the LOG-0061 remediation evidence. Treat reviewer acceptance as not started.
2. Reconcile every current control field so that STATUS's summary, WP0.4 row, and Handoff YAML agree with the latest WORKLOG action, report, ADR, source identity, owner, and next action. Preserve the append-only history. While preparing the submission, status is `IN_PROGRESS`; change to `VERIFYING` only after the source freeze and all required submission evidence are complete.
3. Revalidate LOG-0061's candidate identity against the current saved checkout. Compare the accepted WP0.3 baseline. Ensure the source freeze covers every actual production, test, build, packaging, and staged executable input used by the submission, including exact SHA-256, byte size, and UTC mtime. If an input is missing or changed, add it and create a new complete freeze; do not claim the old inventory covers it. Preserve version `1.5.1` across the eight version files.
4. Do not alter product or test code merely to clear the documentation intake defect. If source/test/build inputs must change to make the candidate valid, update the exact freeze, retain prior evidence, run the necessary focused RED/GREEN and final gates per `docs/pure-rust-core-efficient-execution.md`, and account for the host audit requirements. Never represent prior submitter-only output as a reviewer result.
5. Append the next actual LOG ID after inspecting the end of WORKLOG. Record the source identity, complete freeze, synchronized document states, submission action, and evidence paths. Update the report and ADR so they name the same candidate and `VERIFYING` state. Stop all source and test edits at submission.

## Completion condition

Return a fresh frozen `submitted-for-verification` handoff with STATUS, WORKLOG, report Section 10/11, ADR, and source identity synchronized. The next owner is a fresh independent Codex verifier using `prompts/wp0.4-codex-reverify-log0062.md`. Do not self-accept WP0.4.
