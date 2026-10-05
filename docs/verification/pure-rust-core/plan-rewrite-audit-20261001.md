# Rust-core plan re-audit — 2026-10-01/02

**Planning only; revised roadmap PROPOSED_NOT_ADOPTED.** Runtime implementation, acceptance, stateful commands, new dependencies/policy/version changes, dispatch and release are not authorized. The live ledger remains unchanged; historical evidence and before-images are preserved.

## Result and source identity

The old plan has an operational dependency cycle: WP0.6 requires the existing full Mac gate; that gate requires native interactive execution; the missing Mac implementation was scheduled inside late WP5.4; its prerequisites lead back through G0/WP0.6. The old workflow forbids later implementation while the required gate fails. This is an omitted native platform prerequisite plus conflated native/core scope, not a residual identity-build defect.

The selected proposal introduces **N0: Mac native interactive baseline**, with bounded future authorization and independent safety acceptance before WP0.6 resumes. WP5.4 retains full Rust orchestration/cancellation/event/exact-score integration. No oracle, skip or gate changes. Additional final-gate/review cycles versus a combined package are deliberate cost, justified by distinct security and identity ownership.

Fresh read-only intake: HEAD `8bc8ac9a2161a7468b633c421185d039c97e5a68` with preexisting dirty/untracked source; all eight application files (including package-lock root) read 1.5.1. Historical archive SHA256 freshly recomputed as `3B100EE59C20936D24CA173F882969DAB7ABB970C026E9AF8B294142B2F95B8A`, 78,238,397 bytes; declared regular closure 3,177. This is old diagnostic evidence, not future repaired/accepted source. [Intake](artifacts/plan-rewrite-20261001/intake.json) and [initial input hashes](artifacts/plan-rewrite-20261001/before-input-hashes.json) distinguish planning edits from runtime inputs.

Actual verdicts: WP0.1–WP0.5 DONE; WP0.6 IN_PROGRESS; WP5.4 NOT_READY; no phase gate DONE. WP0.3/0.4/0.5 historical authorized same-session exceptions remain bounded. This new audit is not independent package acceptance.

## Evidence and actual code

| Finding / applicability | Source and implication |
|---|---|
| Current only required Mac failure | [LOG-0091 continuation](artifacts/wp0.6/remediator-log0091-continuation-codex-20261001/remediation.md), [completion summary](artifacts/wp0.6/remediator-log0091-continuation-codex-20261001/completion-summary.json), [scope decision](artifacts/wp0.6/remediator-log0091-continuation-codex-20261001/scope-decision.json): Windows full 706 total/696 pass/0 fail/10 existing skips; Mac 706/697 pass/1 fail/8 existing skips. Both fast/floor and Rust nine steps pass; Mac static/version separately pass after full stopped. Native platform/mod.rs:114–116 rejects interactive on Mac. |
| Identity candidate repaired but unaccepted | [WP0.6 canonical report](wp0.6-version-build-identity-lockfile-policy.md) and LOG-0090 rejection/LOG-0091 remediation: compiler-selected core features and Tauri empty owner features replace inherited-name scan. Both-host 18 live cases/51 focused/19 Cargo assertions are remediator evidence; fresh independent acceptance NOT_RUN. |
| Foundations are accepted, not to restart | [WP0.3](wp0.3-corpus-expected-results.md) final Section 27/LOG-0050; [WP0.4](wp0.4-executor-boundary.md) final Section 18/LOG-0069 and [ADR](../../adr/0001-rust-core-executor-boundary.md); [WP0.5](wp0.5-rust-gates-ci-expected-skips.md) LOG-0084. Exact Node carriers/corpus, out-of-process generation/owner leases and gate policy are real foundations, not completion of all Rust product features. |
| Current versus resolved blockers | LOG-0091 continuation closes signed-resource fixture closure, Windows Temp/compiler-prefix, literal Unicode extraction and marker/descendant cleanup. Protected state and delayed cleanup PASS on both hosts, raw ambient differences retained. Earlier failed logs remain; they are not current blockers. |
| Backend/readiness gaps still partial | src-tauri/src/backend.rs:232–246 discards embedded task/late error; :261–318 chooses opt-in but implicitly falls back after Node lookup/spawn failure. Core status startup identity exists; lifecycle product acceptance does not. WP1.1 owns this. |
| HTTP/filesystem/caller boundaries incomplete | Core server/mod.rs CORS Any and native folder script interpolation; fixed/in-memory package/OSD routes. Frontend src/api.ts/useJudgeSession and shared/contracts define actual consumer shapes. WP1.2/1.3/1.5/1.6, then real service owners close them. |
| Compiler/checker route safety incomplete | Core engine/compiler.rs uses direct PATH g++/gcc/fpc, lacks Java/Scratch batch adapters; runner.rs custom checker spawns host python/binary and recv_timeout does not prove death. Executor client/guardians are accepted foundations but cannot make every caller safe. WP3.1/3.2 and moved WP1.4 use them. |
| Config/jobs/interactive/scoring incomplete | Core session.rs reads partial config, uses cancel flags/direct compile, isInteractive influences discovery while ordinary runner remains; rational.rs parses f64 and saturating arithmetic. Node testcase runner uses existing interactive IPC and exact Node award carrier. WP4.1/4.2/4.3/4.4, early WP5.1, later full WP5.4 own these distinct contracts. |
| Native/runtime support versus certification | diagnostics.rs still chooses ResourceOnly for some runtime paths; registry/release scope declares six production and dormant experimental profiles. Native support must be qualified before adapters, and each new caller denial verified before hostile execution. N1 extracts this obligation; unavailable cannot remove a required release language. |
| Crypto verification provider is a hidden implementation prerequisite | Node server/toolchains/manifest.ts verifies Ed25519 via existing crypto; source search finds no core/native/Tauri verifier implementation. Current core Cargo manifest has no declared verifier. Before WP2.3, research accessible vetted existing/system provider and present a concrete minimal dependency/provider decision if needed; no ad hoc crypto or automatic crate installation. |
| Commands/pipelines differ | package.json now full = fast → Rust → server → static parity → version. Rust wrapper attempts nine steps and aggregates failures. CI separately invokes supported-host Rust/live Windows oracle; CodeMagic and release have different source/package sequences. They are inspected coverage, not this task's executed PASS. |
| Performance/GUI/release claims need actual evidence | PRD supports six languages, OSD, interactive and <150 MB/<50 ms/<300 ms budgets; old overview's complete Stage1/instant boot/resource/anti-extraction claims exceed evidence. Actual Mac GUI cannot be established over SSH. Keep sampling/budget adoption, human GUI, installed rollback/stabilization and separate publication. |

The [2026-09-19 next-steps audit](../../pure-rust-core-next-steps-audit.md) is preserved as historical evidence; its version/count/ResourceOnly wording does not override current authority. Current inspection was targeted across React/Node/Tauri/Rust, scripts/tests/CI/CodeMagic/product documents; it creates no runtime/security/platform PASS.

## Contradictions repaired in the proposal

1. **Native baseline hidden in late WP5.4:** N0 fixes the DAG under explicit future scope/ordering authority; identity and full Rust interaction remain separate verdicts.
2. **G3 demands real batch before WP4 session/stream implementation:** G3 now accepts protected components; G4 proves actual six-language batch/metadata/cancel/streams, G5 complete custom/interactive semantics.
3. **Scoring/config after consumers:** pure exact WP5.1/WP5.2 and normalized WP4.1 precede compiler/session integration.
4. **Checker containment in G1 before real selected compiler/runtime/lease services:** move WP1.4 after WP3.1/3.2/3.3. G1 must deny unfinished unsafe execution/diagnostics truthfully; opt-in hiding alone is insufficient.
5. **Native runtime policy gaps embedded in core language adapters:** extract N1, with per-gap named native subcontracts and same supported matrix. Provision/gap inventory starts early.
6. **Parity only late:** build isolated harness/comparison/failing artifacts early; keep actual migration mismatches FAIL until strict G8 after all services and optimization. No known-gap allowlist becomes acceptance.
7. **Decomposition repeated / READY ambiguous:** one WP0.7 extraction then WP2.1 independently evidenced delta closure; proposed WP0.7 follows identity acceptance. The old live READY is retained without permission.
8. **Outdated scripts/provider prompts/version/architecture:** reconcile full composition, neutral prompt roles, 1.5.1 source, accepted separate executor and actual frontend NDJSON names. Archive original planning prose rather than rewrite historical verdicts.
9. **Verification overclaimed by shared helpers/diagnostics/SSH:** separate component/integrated/caller-security/static/live-oracle/GUI/package acceptance; own successful union per role, source/build/Unicode/signed-resource provenance and cleanup mandatory.
10. **Failure blanket stalls owning prerequisite:** proposed workflow allows only explicitly authorized bounded upstream repair under suspended dependent scope. No generic permission to implement later features while red.

## Alternatives assessed

| Option | Benefit | Cost / decision |
|---|---|---|
| Dedicated N0 native baseline, then WP0.6 | Clear platform/native owner, independent safety and identity verdicts; no dependency on Rust jobs/scoring/streams | Extra final command/review cycles; selected. Requires direct adoption and N0 ordering/scope authority. |
| Explicit native prerequisite inside amended WP0.6 | One combined freeze/union per role; fewer handoffs; earlier draft already specifies guardrails | Mixes substantial OS execution and identity scope; harder accountable verdict/rollback. Sound if explicitly authorized with full paired review, but not selected after whole-plan audit. Prior draft preserved. |
| Separate native maintenance task outside migration ledger | Could repair shipped/reference capability independently | Hidden prerequisite/ownership/evidence unless recorded; effectively N0 with poorer traceability. Prefer named ledger package. |
| Complete all WP5.4 first | Could eventually satisfy interaction and future core integration | Requires unmet adapters/jobs/cancel/scoring and phase chain; expands far beyond native defect, recreates cycle. Rejected. |
| Start unrelated later implementation or accept identity conditionally on failed full | Could appear to advance | Does not repair native oracle; violates existing full handoff/quality contract unless authority separately changes. No conditional DONE or gate waiver proposed. |
| Leave pending | Exactly respects current prior human decision | WP0.6 handoff and normal implementation remain stopped. Still valid until a new specific decision. |
| Skip/filter/AC→JE/platform de-scope | Apparent green | Violates retained oracle/quality/product outcome. Rejected. |

The dedicated choice preserves Node default and 1.5.1. It neither activates new runtime behavior nor waives failing checks. N0 checks all newly reachable certified strict participant/source/role combinations; an unproven generic launch cannot be excused by its one AC regression.

## Complete mapping and adoption

[Proposed mapped ledger](proposed-ledger-20261001.md) maps every 51 WP, four validation and eleven gate IDs; [JSON](proposed-roadmap-20261001.json) has 68 nodes including N0/N1 and concrete per-edge artifact/use fields. No old ID/verdict is removed; historical evidence stays in canonical reports/STATUS and [before-ledger](artifacts/plan-rewrite-20261001/before-ledger.json).

Adopted mapping must be a separate recorded human decision, followed by explicit N0-only implementation/ordering scope and ownership transfer. Until then, STATUS stays unchanged; old combined draft pair remains inactive historical alternative. No current reviewer can accept a failing diagnostic candidate as WP0.6 merely because this plan is better.

Future decisions exposed: approved crypto verification provider before package trust implementation if existing capabilities are insufficient; named native strict-support gap scopes; unresolved checker out-of-range policy before WP5.3; startup metric/hardware/target before optimization; real Mac GUI access/tester; stabilization minimum interval/releases/exit owner before cutover; separate cutover/signing/publication/rollout/decommission authority. No AGENTS/guidelines/CONSTRAINTS change is proposed. If a solution needs authority/dependency/sandbox change, present it separately; do not edit those files in the implementing WP to green it.

## Bounded adversarial review

Fresh-context reviewer `/root/plan_adversary` received graph/task contracts, workflow/efficient execution, dedicated N0 pair and explicit planning/security/state contract, without the author's rationale. Same-model review only; earlier cross-model decline respected. Two bounded text cycles completed. This review cannot implement or grant package acceptance.

Cycle 1 found three valid, actionable defects: N0 demanded new-caller ownership proof before its implementation; the reviewer before-audit appeared after stateful probes; and WP1.3 deferred required Mac native-dialog evidence to a later GUI gate. Corrected the graph, detailed contracts and prompts to put pre-edit harness refusal before bounded fail-closed implementation, implemented-caller harmless ownership proof before hostile probes, the complete before-audit before execution, and real Windows/Mac native-dialog evidence before WP1.3 DONE. Missing early Mac GUI access blocks WP1.3/G1; final package GUI remains V9.4/G9.

Cycle 2 confirmed all three repairs are textually complete across the relevant artifacts and found no remaining substantive contradiction within the bounded recheck. [Attributed findings and disposition](artifacts/plan-rewrite-20261001/adversarial-review.md) preserve the limits: runtime NOT_RUN and no implementation/package acceptance. No additional review campaign was opened.

## Validation and limitations

Documentation validation checks graph acyclicity, known/complete prerequisites, 66/66 mapping, task/gate/command inventory, local references/anchors, whitespace and preservation of frozen runtime inputs/live states. Text review checks owner transitions and authorization boundaries. After the review corrections, 68 nodes/183 edges are acyclic; all 66 old ledger IDs remain mapped; referenced npm command names exist; local links/anchors and `git diff --check` pass. All 3,177 initially hashed closure members are accounted for: four authorized planning documents changed, 3,173 inputs remain byte-identical. All six rewritten documents have preserved before-images; live STATUS is byte-identical and WORKLOG has only the appended planning record. [Final documentation validation](artifacts/plan-rewrite-20261001/validation-final.json) records exact counts and outcomes.

Initial documentation whitespace check found generated trailing spaces in the new task entry sentences; they are corrected only in owned planning documents. Windows rejected an oversized shell-argument graph write before mutation, a duplicate delete/add patch attempt was rejected, and the first inline validator used the Windows default text encoding and failed on UTF-8 prose. The graph was written with file patch tooling, the field update used a targeted patch, and validation was rerun with explicit UTF-8. Earlier failures remain in conversation tool outputs and are summarized in [documentation tooling events](artifacts/plan-rewrite-20261001/tooling-events.json); this summary does not claim separately captured raw failed logs. These are documentation tooling events, not runtime failures.

**Runtime/build/security/platform/backend/remote/GUI/package tests: NOT_RUN** by this assignment. No deployment/publication, commit/push/reset/stash/clean, implementation/test/script/gate/version/dependency/authority edits, accepted-report mutation or automatic chat dispatch. Fresh adversarial planning subagent was authorized for text review only.
