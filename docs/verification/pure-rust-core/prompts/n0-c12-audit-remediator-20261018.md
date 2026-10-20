# N0 remediator dispatch — close candidate12 preservation finding

Prepared for direct human dispatch. This document improves the earlier [remediator prompt](../artifacts/n0/codex-scoped-review-20261017T174658Z/next-remediator-prompt.md); the sealed original remains unchanged. Preparing this prompt does not launch remediation or authorize a protected-state restoration.

Work only on `N0-C12-AUDIT-R1` and the directly necessary test/harness isolation repairs. Read repository AGENTS.md, guidelines.md, CONSTRAINTS.md, the [adopted execution protocol](../../../pure-rust-core-efficient-execution.md), [review workflow](../../../pure-rust-core-review-workflow.md), live [STATUS](../STATUS.md), latest [WORKLOG](../WORKLOG.md), [N0 contract](../n0-native-interactive-baseline.md), [review](../artifacts/n0/codex-scoped-review-20261017T174658Z/review.md), [finding](../artifacts/n0/codex-scoped-review-20261017T174658Z/findings.json), and [investigation notes](n0-c12-audit-remediation-notes-20261018.md).

Claim a unique new remediation round under `docs/verification/pure-rust-core/artifacts/n0/`, record owner/shared-file scope and stop conditions, and keep N0 IN_PROGRESS. Preserve unrelated dirty work, application version 1.5.5, core version 1.5.1, sandbox boundaries, rational scoring and selected compiler. M1 and WP5.4 remain NOT_READY; WP0.6 edits stay suspended.

## Required outcomes

1. **An honest comparator.** Reproduce the archived false PASS in a new owned fixture harness. The historical comparator reports equality for changed same-length preference values. Implement a new comparator and tests in the new round or an appropriate maintained helper; never edit the sealed historical comparator, snapshots, manifests or logs. Do not run old intake/finalize scripts unchanged: several rewrite historical artifacts, remove temporary roots or mutate security settings.
2. **Proof about the original changed file.** The actual affected path is `C:\Users\mon\AppData\Local\ThemisV2\toolchain-preferences.json`. Original before/after hashes are in the review's [intake validation](../artifacts/n0/codex-scoped-review-20261017T174658Z/intake-validation.json). Neither same size nor twelve profiles proves unchanged values. Locate preserved before bytes or reconstruct a candidate whose exact digest matches that original before entry, with an explicit provenance/method record. A current document, hash alone, or newly captured baseline cannot provide the missing before values.
3. **A verified isolation repair.** Attribute the writer and effective persistence root. Inspect the source leads in the notes, reproduce the suspected escape using two harmless owned directories, and fix the responsible boundary with TDD. Record resolved canonical roots before server construction and at the mutation call. Audit sibling callers and restore environment on both success and panic/error. Do not change production preference semantics merely to make an audit pass.
4. **Original-window closure.** Report raw equality and semantic equality separately. Missing before content means semantic equality is unknown, never true. Key-order-only equality may explain a write but does not authorize that protected write or close the byte-preservation incident. Prepare a concrete recovery/disposition manifest and trusted payload before any required permission request. Follow the existing protected-recovery protocol before writing the real file. Keep the failed original window and any repair receipt linked; do not rebaseline it away.

Comparator tests must include schema-valid preference changes, same-length changed local paths, added/removed profiles or fields, malformed/missing before content, schema/type changes, and key-order/whitespace-only changes. Preserve every field during semantic comparison; do not normalize profile aliases, paths, values or arrays. Reject ambiguous input such as duplicate JSON keys. See the notes for fixture requirements and expected outcomes.

## Safe execution and evidence

Pin original protected audit roots independently of the disposable execution environment. Capture full typed before/after inventories and relevant security state. Preserve raw bytes plus canonical JSON values for preferences in future before snapshots. Never follow a junction/reparse point into a protected root during staging, audit or cleanup.

Set `THEMIS_APP_DATA_DIR`, `LOCALAPPDATA`, `APPDATA`, `TEMP`, `TMP` and, on Mac, `TMPDIR` to verified owned roots before starting processes. Provision the approved Windows managed packages as actual owned copies: `gcc-windows-x64`, `python-windows-x64`, `fpc-windows-x64`, `temurin21-windows-x64`, `scratch-windows-x64`. Verify receipts/content and that configuration resolves into the copies. A junction is not read-only isolation. Reuse existing ownership/cleanup primitives; add no dependencies.

Do not rerun the historical `grant-desktop-acl.py` workaround or silently broaden host ACLs. Also inspect `ensure_test_environment()` and its built-in desktop ACL initializer: omitting the Python helper alone does not prove security preservation. Record the actual WindowStation/Desktop identity and security descriptors. Use a documented supported environment/owned-object design, with any necessary scope authorization; do not disable tests or alter sandbox restrictions to obtain PASS.

While original recovery is pending, the workflow permits bounded source remediation and isolated focused tests under verified private guards. It does **not** permit VERIFYING or broad final acceptance against a replacement baseline. If original bytes cannot be established, report the concrete missing prerequisite and continue independent safe work; do not invent restoration data or request vague approval.

## Verification and handoff

First run the pure audit falsifier and owned two-root isolation regression RED -> GREEN, then a bounded fresh-context five-axis review. Do not claim the original native finding `N0-C11-TEST-R1` independently closed: candidate12's native evidence remains remediator reference and the last reviewer ran no candidate runtime gates.

After original-window closure, record the exact changed-file dependency map and execute the required scoped final union. The still-pending native acceptance surface is:

| Host | Required evidence |
|---|---|
| Windows and live `judgedesk-mac` | `npm run check:fast`; `npm run test:rust`, with approved fixtures provisioned first. Aggregate PASS requires all nine Rust steps. |
| Mac | Exact candidate11 `mac/mutation.json` replacement in an owned copy; `cargo test --locked --manifest-path native-executor/Cargo.toml --lib macos_run_controller::tests -- --test-threads=1` gives mutant RED exit 101 with the intended failed assertion and candidate GREEN 5/5. Restore/verify source and any shared cache afterward. |
| Mac | Current-source executor/server build as needed, full coupled four-file interactive union (74 tests, zero skips), Mac Core build plus deep strict codesign verification, supervisor gate with at least three consecutive passes under the adopted protocol, and packaged checkers with actual port rebind plus immediate/ten-second delayed owned-process/descriptor drain. |

Use the exact four-file selection and gate environment recorded in the notes. Contain commands and descendants on deadlines, assertion failures and logger failures; prove whole libtest-process exit after the expected mutant failure. Preserve failed attempts. Do not strengthen optional test-scheduling suggestions into a new blocking feature requirement without a demonstrated defect.

Retain only unaffected **independently verified** rows by `evidenceMode: reference`, with original verifier, status, log/manifest binding and changed-file justification. Candidate12 remediator PASS is not independent acceptance. If server behavior changes, include `npm run test:server`; broaden to required full/security/package gates when the actual repair invalidates them. Do not rerun unrelated migration milestones or claim an unexecuted row passed.

Write command argv/cwd/environment allowlist/start/end/duration/exit, inventories/counts/skips, raw logs, selected binaries, original-window closure, source/build binding and cleanup into new artifacts. Use explicit UTF-8 for JSON/source manifests and preserve literal Unicode paths. Hashes and sizes belong only in JSON manifests. Freeze the final candidate and synchronize report/STATUS/WORKLOG to VERIFYING only when all required criteria pass; otherwise remain IN_PROGRESS with named missing rows. Prepare both neutral next prompts. Do not self-accept, dispatch chats, commit, push, publish, change versions/dependencies, or perform unapproved protected writes.
