# WP0.6 blocker — proposed next step, 2026-10-01

**Planning only. Not an implementation authorization or dependency waiver.** Mon requested a whole-plan assessment and explicitly said “Don't implement anything.” The earlier instruction “Keep WP0.6 scope; leave this blocker pending” remains in force. No package changes state in this proposal.

## Recommendation

Do not try to make the whole WP5.4 DONE next. Propose a bounded amendment to WP0.6 remediation that permits the existing macOS native-executor interactive baseline to be repaired, then submits one combined frozen candidate for independent WP0.6 acceptance. This requires direct future human authorization of the scope and ordering exception before any implementation. The draft pair below stops without that authorization.

This is new platform execution behavior behind an existing protocol entry point, not a one-line fix. It may need staged, separately reviewed changes. Neither the repair nor a passing corpus case proves the complete Rust migration interactive contract.

Prepared draft prompts:

- [Remediator](prompts/wp0.6-macos-prerequisite-remediator-draft.md)
- [Independent reviewer](prompts/wp0.6-macos-prerequisite-reviewer-draft.md)

The remediator would implement only the approved native prerequisite and complete the remaining WP0.6 verification on the combined candidate. The fresh reviewer would verify both the native safety contract and the full WP0.6 identity/lockfile contract. Each role executes its own required final command union once successfully per host; failed, incomplete or invalidated runs remain preserved and require reruns. An extra auxiliary acceptance cycle is unnecessary. WP5.4 gets no DONE credit and remains NOT_READY.

## What the complete plan permits today

| Option | Assessment |
|---|---|
| Complete all of WP5.4 first | Not permitted by current dependencies. It needs WP3.2, WP4.3 and WP5.1 DONE, including their earlier phase chains. Native dual-process support alone cannot satisfy Rust orchestration, cancellation, result/event parity and scoring integration. |
| Bounded native prerequisite within an explicitly amended WP0.6 scope | Recommended proposal. Keeps the existing AC oracle, supported-platform obligations and security floor, while addressing the current failing baseline. Requires explicit approval that supersedes the prior deferral for this named prerequisite. |
| Start WP0.7 while WP0.6 remains failing | Its ledger row is READY because its listed dependencies are DONE, but detailed-plan §3.2 prohibits implementing later packages while the current package has a reproducible failing gate. It also cannot close G0. Avoid creating a second sequencing exception unnecessarily. |
| Skip/filter the Mac interactor or change its expected AC to JE | Would weaken accepted tests/platform oracles. Not proposed or authorized. |
| Continue leaving the blocker pending | Valid under Mon's current decision; WP0.6 cannot reach VERIFYING and normal implementation progress stays paused. Read-only planning, scope review and preparation of future test matrices can continue. |

The current blocker is reproducible through the existing Node → framed IPC → native executor path. `native-executor/src/platform/mod.rs:114–116` returns the Windows-only interactive failure for Mac. This is distinct from the future complete Rust-core interactive integration in WP5.4.

## Normal sequence after the proposed prerequisite

| Step | Required outcome |
|---|---|
| Explicit scope decision | Authorize only the named Mac native baseline prerequisite and its ordering exception; record ownership and the amended prompt pair. No automatic dispatch. |
| WP0.6 combined remediation/review | Repair the approved prerequisite, freeze all changed build/test inputs, pass fresh Windows/live Mac gates and security/cleanup evidence, hand off VERIFYING, obtain fresh independent DONE. |
| WP0.7 → G0 | Characterize/decompose Rust route domains without behavior drift, independently accept WP0.7, then independently close the Phase 0 gate. |
| Phase 1 | Backend supervision, HTTP authorization, native dialogs, checker containment, truthful capabilities, owned workspaces and observability. Its gate precedes later real-execution work. |
| Phase 2 → Phase 3 | Real persisted toolchain/package state and fail-closed resolution, then protected compiler service, six language adapters and pinned sessions. |
| Phase 4 → Phase 5 | Configuration, job ownership, cancellation/drain, stream/export contracts, then exact scoring/checkers and the complete WP5.4 interactive integration. Native prerequisite evidence can be referenced only where source/environment/assertion applicability is proven; fresh integrated acceptance remains required. |
| Phase 6 → Phases 7–8 | Complete remaining services; measure before PCH optimization and run isolated Node/Rust parity. Existing dependency and host-serialization rules still apply. |
| Phase 9 → Phase 10 | Desktop/platform/package and actual Mac GUI evidence, then deliberate cutover, coordinated eight-file 1.6.0 bump, release gates, stabilization and separately approved Node decommission. |

No phase gate, full WP contract, supported platform, security threshold or independent acceptance requirement is removed. Node remains the default until WP10.2; application source version remains 1.5.1 until WP10.3.

## Current evidence and documentation reconciliation

Current diagnostic source: main HEAD `8bc8ac9a2161a7468b633c421185d039c97e5a68` plus preserved dirty inputs; 3,177 regular archive members, 78,238,397 bytes, SHA256 `3B100EE59C20936D24CA173F882969DAB7ABB970C026E9AF8B294142B2F95B8A`. Windows full gate PASS; live Mac full gate FAIL on one interactor case; delayed cleanup and protected-state preservation PASS on both hosts. See [continuation evidence](artifacts/wp0.6/remediator-log0091-continuation-codex-20261001/remediation.md).

The current STATUS top ledger already reflected that evidence, but its YAML handoff block still referenced the older 3,176-member archive, resolved Windows/Unicode failures and pending cleanup. This planning pass reconciles only that stale handoff documentation. WP0.6 remains IN_PROGRESS and WP5.4 remains NOT_READY. Historical WORKLOG entries and immutable evidence remain unchanged.

Some roadmap prose still describes `check:full` before WP0.5 integrated Rust gates. Current `package.json` executes fast → Rust → server → static parity → version. Future agents must read the actual scripts and preserve all required children, not treat historical command prose as a waiver.

## Proposal review and limits

Two bounded fresh-context doubt-review cycles examined scope, ordering and acceptance. Actionable findings were incorporated: explicit future approval of the ordering exception; allowed-file/component boundaries and stop conditions; independent limits/isolation for both participants; partial-start and second-launch cleanup; certified source/role matrix; staged change sizing; and verification of the new caller's fail-closed behavior before hostile fixtures. The harness must itself terminate/drain descendants on deadlines. Different-model review was previously declined and was not requested again. This planning review is not independent WP acceptance.

No implementation, runtime tests, remote operations, package claim/transition, commit/push, dependency/version change or chat dispatch occurred. Runtime results in this proposal are references to preserved LOG-0091 evidence. Documentation validation is limited to source/reference checks and `git diff --check`.

When ready, the human can issue: “Approve and execute the draft WP0.6 Mac native prerequisite remediation scope and ordering exception, preserving WP5.4 NOT_READY and the existing security/oracle contracts.” Until such direct authorization arrives, the draft remediator is not executable.
