# Rust core — research, remediation and independent acceptance

> **2026-10-17 Adopted Revision (Mon-authorized Streamlined High-Rigor Workflow):**
> On 2026-10-17, Mon authorized transitioning the Pure-Rust Core (`v1.6.0`) migration workflow to the **4-Macro-Milestone + Scoped Re-verification + JSON-Only Hash Binding** model defined in [`docs/pure-rust-core-efficient-execution.md`](pure-rust-core-efficient-execution.md):
> 1. **Macro-Milestone Batching (`N0` Scoped Closure $\rightarrow$ `M1` $\rightarrow$ `M2` $\rightarrow$ `M3` $\rightarrow$ `M4`):** Instead of 46 separate per-`WP*` freeze/review cycles, remaining `WP*` and `G*` items are executed and independently reviewed at **4 Macro-Milestone boundaries** (`M1`: `WP0.6..G5`, `M2`: `WP6.1a..G6`, `M3`: `WP7.1..G8`, `M4`: `V9.1..G10`) after closing `N0` (`N0-C10-GATE-R1`). Every Milestone report MUST include a **1-to-1 `WP*` Traceability Matrix** (`WP ID` $\rightarrow$ `Code File/Symbol` $\rightarrow$ `Test Name` $\rightarrow$ `Command Log`) so individual `WP*` rows transition to `DONE` in [`STATUS.md`](verification/pure-rust-core/STATUS.md) only when backed by concrete code and test evidence.
> 2. **Scoped Re-verification on Bounded Remediations:** When an independent review rejects a candidate on a bounded finding (such as `N0-C10-GATE-R1` after `codex-review-closure-20261017T065802Z`), the next remediation and review round re-runs **only** the affected gate(s), directly coupled regression suites, and fast/unit gates (`npm run check:fast`, `npm run test:rust`), retaining unaffected independently verified gates by `evidenceMode: reference`.
> 3. **JSON-Only Hash Binding (Zero Prose SHA-256 Overhead):** Markdown reports, `STATUS.md`, `WORKLOG.md`, and handoff prompts MUST NOT hardcode `(bytes, sha256)` tuples in prose. All file sizes and SHA-256 digests live exclusively in machine-generated JSON manifests (`evidence-manifest.json`, `command-coverage.json`, `verdict.json`).
> 4. **Preserved Non-Negotiable Quality Pillars:** Strict TDD (`RED` $\rightarrow$ `GREEN` $\rightarrow$ `Refactor`), fresh-context 5-axis adversarial code review, live dual-host verification (`Windows x64` + `macOS arm64` on `judgedesk-mac`) at Milestone boundaries, and all `AGENTS.md`/`CONSTRAINTS.md` invariants remain mandatory.
>
> *Historical header notes (preserved):* Proposed workflow revision, 2026-10-01. Earlier same-session exceptions are historical and do not carry forward. Different-model review was declined; do not ask again or invoke another model CLI. Current limited adoption, 2026-10-02: N0 was directly dispatched and claimed IN_PROGRESS; N0 → WP0.6 ordering was adopted.

## Authority and ownership

Direct human adoption chooses the proposed graph; direct package/milestone authorization chooses runtime work. They are separate decisions. The [live ledger](verification/pure-rust-core/STATUS.md) retains real states until adoption is explicitly recorded. The [proposed mapped ledger](verification/pure-rust-core/proposed-ledger-20261001.md) never acts as a live READY claim.

One package/milestone owner coordinates research and remediation. A researcher supplies a concrete artifact, not code acceptance: current callers/contract conflicts, required upstream behaviors, environment/profile/source/role catalog, focused falsifiable claim/RED, scope/files/shared-owner plan, command coverage, provenance/cleanup and stop/rollback boundary. Research on an unavailable dependency may continue read-only. Implementation uses accepted inputs and authorization.

One fresh independent reviewer owns acceptance and may write reports/ledger/history/handoff text, not candidate fixes. An in-flight adversarial subagent finds design/diff issues but cannot confer DONE or substitute for a separate acceptance role. Providers/models are execution provenance, not prompt audience. Do not start implementation/review chats automatically when preparing prompts.

## State machine

| State/action | Entry and permitted work | Exit artifact/owner |
|---|---|---|
| Proposed/adoption | Read-only planning and proposed ledger; no runtime permission | Human records adopted revision and explicitly authorizes package/milestone |
| READY claim | Authorized bounded task or Macro-Milestone (`N0`, `M1`–`M4`), all dependencies DONE/applicable, unowned or explicit transfer; refresh actual intake | Remediator records scope/files/owner/start and IN_PROGRESS in live STATUS + append WORKLOG |
| IN_PROGRESS | Ordered TDD sub-slices (focused RED/GREEN/refactor) and bounded 5-axis adversarial review within scope; reuse persistent incremental build caches (`target/`); serialize shared files/stateful runs | Complete final source/required evidence (plus 1-to-1 `WP*` Traceability Matrix for Milestones) and claim VERIFYING; missing item stays here with precise test status |
| VERIFYING | Source/tests/scripts/fixtures/config/locks/build inputs frozen (`git diff` + `evidence-manifest.json`; full tarball only at Macro-Milestone `M1`–`M4` handoff); report/handshake identify exact candidate, paired reviewer and JSON manifest | Ownership to fresh reviewer; no remediator edits while acceptance runs |
| DONE | All required intake/coverage/security/platform/cleanup pass under independent reviewer execution (full union at Milestone boundary; scoped union on bounded remediation when prior gates are retained by `evidenceMode: reference`) | Reviewer attributed verdict + accepted report/JSON manifest; update all verified `WP*`/`G*` rows in `STATUS.md` |
| Rejected → IN_PROGRESS | Decisive defect/missing required evidence; finish reviewer-owned cleanup and preservation | Actionable findings + retained `evidenceMode: reference` rows + next-round neutral prompts (without prose SHA-256 tuples); transfer remediation ownership |
| External evidence blocked | Package/milestone stays its real state; scenario BLOCKED/NOT_RUN/INCONCLUSIVE with named prerequisite | Concrete prerequisite resolution/scope decision, no inferred READY/DONE |

Scenario vocabulary: PASS executed assertions satisfied; FAIL executed failure; BLOCKED named unavailable prerequisite; NOT_RUN not executed with reason; INCONCLUSIVE executed but insufficient/contended evidence. `evidenceMode: reference` links a prior independently executed result, not a new PASS. On bounded remediation rounds where touched files cannot affect previously verified subsystems, unaffected gates that already passed independent review may be retained via `evidenceMode: reference` with explicit file-diff justification. Suspended means no edits under current scope; it does not silently rewrite package state or erase its owner.

A reviewer starts only with synchronized report/STATUS/handoff and actual frozen VERIFYING candidate. Review critical disproving probes before broad gates; rejection can stop unnecessary suites, never omit cleanup. If preconditions survive, execute the required verification union on required hosts (scoped union for bounded remediations; full union for Macro-Milestone `M1`–`M4` gates), inventory/skips, real caller/security and protected-state/descendant audits. No remediator full PASS, diagnostic badge, single AC or text review discharges this responsibility.

## Scope escalation and prerequisite repair

Required failure stops downstream implementation. Diagnose the root across React, Node/core, Tauri, native executor/guardian/toolchain/harness; list concrete upstream behavior missing. An authorized correction inside current contract needs no repeated permission. Outside it, complete a reviewable scoped proposal/prompt pair and record the exact human decision before implementation.

The prepared N0 contract places dedicated native repair before WP0.6. N0 uses accepted WP0.1–0.5 and the prior identity candidate as *unaccepted input*, with no reverse acceptance dependency. Its native safety acceptance cannot accept WP0.6. After N0 DONE, separately resume identity owner and refreeze/revalidate WP0.6. WP5.4 remains NOT_READY for Rust integration. Document preparation alone never supersedes the prior deferral; the subsequent direct dispatch below does so only for N0.

Current limited adoption: Mon directly dispatched N0 on 2026-10-02T06:15:45Z, lifting that deferral only for N0 and adopting only N0 → WP0.6 ordering. This is recorded in the live ledger; do not seek the same approval again. Other proposed graph changes remain proposals. The [N0 continuation clarification](verification/pure-rust-core/n0-plan-conflict-resolution-20261002.md) permits required coordinated private native launcher/control/stdio work within N0 while preserving public framed IPC and sandbox authority.

Protected-state incident: original FAIL remains immutable. With original-root audit pinning and verified private harness guards, bounded source remediation/isolated focused tests may continue in IN_PROGRESS while exact recovery inputs and protected-write authorization are pending. Complete the concrete manifest/trusted original bytes before requesting that authorization. No VERIFYING intake is allowed until verified closure against the original baseline plus the full required final evidence; a fresh baseline against mutated state does not close an incident. The independent reviewer verifies restoration provenance/whole-inventory closure as well as its own audit window and execution. This is recovery, not a preservation exception or a new acceptance shortcut.

Shared modules have one writer: server routes, session/job registry, resolver/preferences, IPC/guardians/workspaces and goldens. Record primary/shared ownership and merge/freeze order. Different-host stateful work may overlap only on verified exact-source isolated roots; same-host shared caches/ports/AppData tests serialize. Lost ownership or source drift stops intake; no reviewer races an active edit.

## Chat lifecycle and bounded review

Continue a chat for accurate same-WP debugging, concrete rejection remediation, or a separately claimed/authorized adjacent package after independent DONE. Start fresh for independent acceptance, role/ownership transfer, new major trust/phase boundary or materially stale context. Never replay unchanged immutable logs or reopen accepted packages as a substitute for intake.

For non-trivial design, extract artifact + contract into one bounded fresh-context adversarial review. Find contradictions/scope leaks/hidden prerequisites/missing acceptance; classify findings as contract misread/actionable/trade-off/noise and record disposition. Maximum three cycles; unresolved substantive findings remain visible. No cross-model request/CLI follows the earlier decline. Plan review is not runtime acceptance.

## Compact handoff schema

```yaml
schema_version: 1
roadmap_revision: proposed-20261001 # adopted reference if approved later
work_package: <ID>
role: remediator|independent-reviewer
authorization: <direct human decision reference and exact scope>
state: IN_PROGRESS|VERIFYING|DONE
owner: <actual executor, workspace, startedAt>
prerequisites: [{id: <ID>, verdict: DONE, report: <path>, applicability: <why>}]
scope: {claim: <observable>, owned_files: [], shared_owner: <name>, stop_conditions: []}
source: {head: <40hex>, dirty_manifest: <path+sha>, archive: <path+sha+bytes+members>}
build: {recipe: <path>, locks: [], target: <triple>, features: [], backend: <actual>}
environment: {os_arch: <identity>, tools: <manifest>, role_source_matrix: <path>}
artifacts: {report: <path>, command_coverage: <path>, raw_log_inventory: <path+sha>}
audit: {before: <path>, after: <path>, ambient_delta: <path>, delayed_cleanup: <path>}
results: {required_failures: [], missing_rows: [], invalidated_evidence: []}
review_pair: {remediator: <path>, reviewer: <path>, round: <unique>}
next_eligible: <dependency-derived ID or none; no dispatch>
```

Every executed command records argv/cwd/env allowlist/start/end/duration/exit/test inventory/counts/skips/raw output and actual selected binary. Resource runs include drain and protected-state results. Required machine JSON for parity/performance/stress/release plus canonical report keeps evidence compact.

## Neutral researcher prompt template

```text
Research <ID> only in D:\Minh\Code\judgedesk; no implementation or acceptance.
Read AGENTS/guidelines/CONSTRAINTS, start-here, live STATUS/latest WORKLOG,
adopted-or-proposed exact contract, accepted prerequisite reports and actual callers.
Preserve dirty source and immutable evidence. Produce a bounded claim/scope,
contract conflict table, dependencies with concrete artifacts, platform/toolchain/
source/role prerequisites, focused falsifying tests, ordered implementation slices,
commands/coverage/provenance and fail-closed/cleanup/rollback design.
Name unresolved scope decisions. Prepare neutral remediator/reviewer prompts if
requested; never dispatch chats, change live verdicts or run stateful commands
unless this research assignment explicitly authorizes them.
```

## Neutral remediator prompt template

```text
Execute only <ID> under <direct authorization reference and adopted revision>.
Read AGENTS/guidelines/CONSTRAINTS, start-here, STATUS/latest relevant WORKLOG,
exact detailed contract, review workflow, efficient execution and actual callers.
Confirm accepted dependencies, owner/transfer, source/version/platform/role inputs;
claim IN_PROGRESS before edits. Preserve unrelated dirty work, version 1.5.1 until
WP10.3, strict out-of-process sandboxes, exact scoring and selected compiler.
Record scope/shared file owner and rollback/stop boundary. RED then GREEN for each
behavior; verify the new caller fails closed before hostile disposable fixtures.
Contain and drain harness descendants on deadlines/logger/assertion failures.
Run mandatory edit checks; bounded adversarial review; freeze complete source/
build/resources/locks/target/features; execute own successful final union per host
and distinct contract/security/platform checks. Preserve all failures and invalidate
changed coverage. Write canonical report/JSON/immutable manifests, full protected
state and immediate/delayed cleanup. Claim ready for review only if every required
row passes; synchronize VERIFYING handoff and stop edits.
Otherwise remain IN_PROGRESS with concrete findings/missing prerequisite.
Do not self-accept, implement later WPs, dispatch chats, add dependencies, waive
gates, alter expected oracle, publish/commit/push or expand authority.
```

## Neutral independent reviewer prompt template

```text
Independently accept or reject <ID> only in fresh context under <review authorization>.
Read authorities, live STATUS/latest WORKLOG, exact contract/accepted prerequisites,
workflow/efficient execution, remediator report and actual frozen candidate intake.
Require synchronized VERIFYING, owner transfer, complete closure and actual build/
launched identity. Fix no code. Inspect tests/inventory/diff across five axes and
run critical falsifying production preconditions before expensive broad commands.
If decisively rejected, preserve results, finish your full owned cleanup/audit and
return actionable findings plus invalidated coverage and both next-round prompts.
If it survives, run your own successful final union on each required host plus
distinct security/role/lifecycle/GUI/package checks under verified owned roots.
Reference only proven-applicable independent evidence with exact attribution;
remediator runs never become your executed PASS. Missing host/runtime/GUI or failed
drain prevents acceptance. Record your source/build/env/command and before/after/
delayed preservation artifacts. DONE only when every required criterion passes;
otherwise IN_PROGRESS. No self-remediation, automatic next task/chat, dependency/
version/policy change, waived assertion, publication/commit/push or external model CLI.
```

A prompt's file existence is not dispatch, permission, readiness or acceptance. Draft candidate fields stay unset until a real authorized frozen handoff exists. The historical LOG-0091 pair remains preserved; at initial preparation the dedicated N0 drafts were inactive.

The N0 remediator prompt was subsequently directly dispatched as recorded above. That fact does not dispatch its reviewer or the later WP0.6 pair. The [N0 continuation prompt](verification/pure-rust-core/prompts/n0-continuation-20261002.md) is prepared for Mon to send to the existing owner; it neither creates a chat nor changes the current verdict.
