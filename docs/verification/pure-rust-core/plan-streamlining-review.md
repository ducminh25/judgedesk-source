# Pure Rust Core — plan streamlining review

- Date: 2026-09-26
- Request: Mon asked to review and streamline the plan before continuing WP0.4, reducing implementation/test/wait time while retaining rigor.
- Scope: documentation and scheduling; no runtime, script, test, package, sandbox or quality-threshold changes.
- Result: execution protocol documented in `docs/pure-rust-core-efficient-execution.md` and reconciled across detailed plan, start-here and Antigravity handoff.
- Current migration status: WP0.1–WP0.3 DONE; WP0.4 IN_PROGRESS with a proposed ADR. No WP0.4 implementation was advanced during this review.

## 1. Findings and decisions

| Finding | Adopted revision | Limit |
|---|---|---|
| Final check:full repeats separately invoked fast/server/static parity/version children | One successful final full gate per actor; identify successful child coverage in its log | Edit/pre-build floor checks remain; failures/changes require reruns; reviewer executes independently |
| Repeated heavy gates during remediation | Focused RED/GREEN, inspect stabilized diff, freeze candidate and run final completion union | No omitted regressions, supported profiles, security/platform requirements or final-source gate |
| Repeated broad review/report handoffs | One canonical report with attributed review/verdict and immutable linked artifacts; compact STATUS/WORKLOG pointers | Fresh independent acceptance and append-only history remain |
| Forced implementation context recreation per adjacent WP | Continue accurate same-phase implementation context after independent DONE and a separate authorized claim | Refresh on phase/trust/role/material-source change; verifier stays fresh |
| Whole-roadmap rereads | Current WP/dependencies/changed authorities after identity checks | Mandatory first reads and changed policy/source cannot be skipped |
| Repeated all-command host snapshots | One complete audit window per actor with scenario cleanup assertions and final delayed observation | Both roots fully hashed; new baseline cannot hide prior damage/leaks; source/host drift explicitly reconciled |
| Repeated fixture/compiler/checker/workspace implementations | Share accepted fixtures/helpers with separate contract acceptance | 51 WP IDs/11 phase gates/dependencies remain intact; only existing proven conditional WP2.1 omission is possible |
| Blindly repeat every WP command at phase gate | Reference applicable original independent pure/component evidence; execute new integration/live checks | Explicit executed/reference provenance; actual final source/coverage required; live security/lifecycle/performance/GUI/release remain fresh |
| Old 1.5.0 source prompts and READY prerequisites | Source baseline reconciled to 1.5.1; dependencies must be DONE; retain historical 1.5.0 evidence | No version files changed; no public 1.5.1 release inferred |

## 2. Work that stays separate

Do not merge executor architecture, containment, compiler adapters, job lifecycle, exact scoring, strict parity, GUI validation or release cutover into a single acceptance. Keep all 51 implementation WPs, four V9 validation tasks and 11 phase gates, required OS/profile/source/role coverage, fail-closed sandbox, exact rational scoring, source identity, cleanup, independent verdicts and rollback/stabilization boundaries.

The shared-work map names reuse across WP0.7/WP2.1, WP1.6/WP2.4/WP2.5, WP1.4/WP5.3, WP3.1–3.3, WP4.1/WP5.1/WP4.5, OSD and PCH. Reuse removes duplicate implementation and setup; it does not complete dependent WPs in advance.

## 3. Adversarial review and reconciliation

Skill-driven fresh-context, same-model read-only reviewer: `/root/streamlining_plan_review`. Three bounded text-review cycles; no tests, edits or platform claims by the reviewer. Mon previously declined an additional model for the streamlining analysis; no external model/CLI was invoked.

Actionable findings incorporated:

1. Preserve CONSTRAINTS' every-edit/pre-build checks and distinguish successful final execution from a run quota.
2. Add explicit `evidenceMode`, original execution/verifier/log hash, test inventory/IDs/skips and row-level applicability; references cannot fabricate new PASS.
3. Retain original audit snapshots and failures; start before stateful probes/builds; rebasing cannot erase unknown host deltas.
4. Validate full cache input closure, build provenance, actual launched binary, ownership/ACL/reparse policy; allocate fresh writable runtime roots.
5. Reconcile every conflicting conversation/version/dependency instruction across entry, handoff and detailed plan.
6. Link timing observations to original logs and identify excluded setup/build time.

The third reviewer text review reported no remaining substantive defects. This is review of the process specification, not verification of future cache/selector/audit automation or WP0.4 architecture.

## 4. Verification

| Check | Result / scope |
|---|---|
| Current package.json command composition | Inspected: check:full includes fast/server/static parity/version; nested server build/validation retained |
| Cross-document contradiction/identity search | Reviewed revision sections for old source-version, READY dependency and forced-session instructions; historical references retained |
| `git diff --check` | PASS for documentation changes |
| `npm run check:fast` | PASS: TypeScript and quality invariant gate, no suppressions or threshold changes |
| `npm run release:check-version` | PASS: 1.5.1; no version files changed |
| Runtime/server/Rust/security/desktop suites | NOT_RUN for this documentation-only revision; no runtime PASS claim |
| WP0.5 automation | NOT_IMPLEMENTED: composition/selector/cache/run-record helpers need their own RED/GREEN and independent acceptance |

## 5. Expected savings and next action

WP0.3 server test-run durations were 133.464 s standalone and 135.905 s within check:full. Removing one duplicate server invocation avoids approximately 2.2 minutes of test execution for that snapshot, excluding setup/build/parity time. This is not a whole-project speedup estimate. The previous 15 structural / three live semantic tamper split retained 18 rejections and is a case-specific coverage selection, not blanket permission to omit oracle work.

Measure implementation/focused-test/completion/review/audit/setup/wait time separately on future WPs and compare like-for-like runs. Do not promise a total percentage before measurements exist.

The next runtime work remains WP0.4 under its existing claim. WP0.5 implements and proves automation after its normal dependencies/authorization. This plan-review turn does not launch a later WP, scheduler or release.
