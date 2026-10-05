# Re-audit and rewrite the complete Rust core plan

## Assignment and authority

Work in `D:\Minh\Code\judgedesk`. The human explicitly requests a better complete Rust-core migration plan, workflows, detailed instructions, aims and expected results for every stage. Re-check the current plan against actual code and evidence, then **write the revised planning documents**. Do not stop at a critique or an outline.

This is a **planning/documentation task only**. Do not implement application or test code; change build/gate behavior, sandbox policy, dependencies, lockfiles or versions; run stateful builds/tests/backend launches; deploy/publish; commit/push; or start implementation/review chats. Read-only source, script, log and repository inspection is allowed. Updating planning/coordination documentation is authorized. Preserve all unrelated dirty work, historical verdicts and immutable evidence. No reset/stash/clean.

The selected conversation settings are GPT-6.1 with Extra High reasoning. This conversation is a fresh planning audit, not independent acceptance of WP0.6 or any other implementation package. No earlier same-session acceptance exception carries forward. Different-model review was previously declined; do not ask again or invoke another model CLI.

The human now authorizes rethinking the **whole plan**, not merely working inside its existing ordering. You may propose/rewrite future stages, split or consolidate future tasks, correct dependencies and redesign workflows. Do not preserve an unworkable ordering simply because the older plan says not to change it. Preserve architectural/security/quality/product outcomes and provide an explicit old-to-new mapping. A rewritten plan does not itself authorize runtime implementation, waive a failing test, or prove a work package DONE.

## Current situation and the problem to solve

Read current STATUS/WORKLOG rather than reconstructing state from this prompt. At the last verified checkpoint:

- WP0.1–WP0.5 are DONE; their accepted evidence must be preserved. WP0.6 remains IN_PROGRESS, WP5.4 is NOT_READY and no phase gate is DONE.
- WP0.6's inherited `CARGO_FEATURE_*` identity defect was repaired at the compiler-selected build source. Production-path feature/identity, focused and Cargo mutation evidence exists on Windows and live Mac. Independent acceptance of the repaired WP0.6 candidate is still NOT_RUN.
- Windows final `npm run check:full` PASS: 706 tests, 696 pass, 0 fail, 10 existing skips. Live Mac arm64 full gate FAIL: 706 tests, 697 pass, 1 fail, 8 existing skips. Fast/floor and all nine Rust steps pass on both hosts. Mac parity/version pass as separate actual commands after its full enclosure stopped at the server failure.
- The single remaining Mac failure is the existing Node/native `cpp_interactor` corpus case: expected AC, actual JE. `native-executor/src/platform/mod.rs:114–116` explicitly returns “interactive runner is only supported on Windows in this build.” This is a platform execution gap, not a remaining build-identity failure.
- The plan schedules the full interactive runner under WP5.4, with WP3.2/WP4.3/WP5.1 dependencies not DONE. Meanwhile WP0.6 must pass the existing full Mac gate before handoff, and the current workflow forbids later implementation while a required gate fails. This creates a practical sequencing deadlock. Identify its precise cause and design an explicit resolution without skipping the test, changing AC to JE or prematurely declaring full WP5.4 complete.
- Earlier Windows fixture/install/compiler-path failures, Mac literal Unicode extraction failure and cleanup blockers were resolved. Protected-state preservation and delayed cleanup now PASS on both hosts. Preserve raw earlier failures, but do not relist them as current blockers.
- The human previously said “Keep WP0.6 scope; leave this blocker pending.” The new request authorizes rewriting the plan, **not implementing that deferred repair**. Any proposed repair needs a clearly named scope and future implementation authorization.
- A previous planning proposal and draft amended WP0.6 prompt pair exist. Treat them as one option to evaluate, not a required answer. Compare a dedicated native baseline stage, an explicitly bounded prerequisite within WP0.6, and other sound ways to repair the DAG/workflow. Do not merely rubber-stamp the earlier recommendation.

Current diagnostic identity: main HEAD `8bc8ac9a2161a7468b633c421185d039c97e5a68` plus preserved dirty source; eight application versions 1.5.1. The latest preserved archive has 3,177 regular members, 78,238,397 bytes, SHA256 `3B100EE59C20936D24CA173F882969DAB7ABB970C026E9AF8B294142B2F95B8A`. This identifies historical diagnostic evidence, not a future repaired/accepted source. Refresh actual identity before planning edits.

## Read and audit

Start with AGENTS.md, guidelines.md, CONSTRAINTS.md, then:

1. `docs/pure-rust-core-start-here.md`, current STATUS and latest relevant WORKLOG.
2. The complete `docs/pure-rust-core-detailed-implementation-plan.md`, `pure-rust-core-migration-plan.md`, `pure-rust-core-efficient-execution.md`, `pure-rust-core-review-workflow.md` and `pure-rust-core-antigravity-handoff.md`.
3. The next-steps audit and accepted executor ADR `docs/adr/0001-rust-core-executor-boundary.md`.
4. Canonical WP0.3/WP0.4/WP0.5/WP0.6 reports as needed to distinguish accepted foundations from unaccepted/unfinished behavior.
5. `docs/verification/pure-rust-core/artifacts/wp0.6/remediator-log0091-continuation-codex-20261001/{remediation.md,completion-summary.json,scope-decision.json}` and the preceding remediation/independent-review findings when relevant.
6. `docs/verification/pure-rust-core/wp0.6-blocker-next-step-proposal.md` and both `wp0.6-macos-prerequisite-*-draft.md` prompts.
7. Relevant PRD/TRD/API/frontend contracts and actual current source, package scripts, CI/CodeMagic and tests. Prefer targeted source searches after reading the roadmap; do not repeatedly reload immutable logs or enumerate copied toolchain trees.

Audit actual callers across React, Node, Tauri and Rust, especially backend selection, native IPC/guardians, interactive execution, toolchain resolution, job/session cancellation, scoring and streaming. Separate what currently ships, what exists only as partial Rust code, what has independent acceptance, and what remains planned. Inspection is not an executed PASS.

Apply relevant planning/review/doubt and quality-contract skill instructions. Conduct a bounded fresh-context adversarial review of the proposed dependency graph and workflow before finalizing. Reviewers find contradictions, scope leaks, hidden prerequisites and missing acceptance; they do not implement code or grant package acceptance. Do not start an unbounded review loop.

## Questions the revised plan must answer

### 1. Sound stages and dependencies

Define the end product: a compatible, fail-closed Rust backend on Windows x64 and Mac arm64, deliberate cutover, controlled rollback and eventual Node decommission. Recheck the complete roadmap against current reality.

Create an acyclic dependency graph with a justified order. Distinguish native executor/platform prerequisites from Rust-core orchestration/integration; fixture capture from implementation; pure/component checks from integrated/security/release acceptance. Identify required runtime/toolchain/platform capabilities early enough that a late feature cannot block an earlier unrelated identity/refactor package indefinitely.

For each proposed dependency, explain what concrete artifact or behavior the downstream task needs. Expose any gate that demands an outcome scheduled later. Resolve the Mac interactive deadlock explicitly, retaining the unchanged required oracle and quality floor. If policy/adoption decisions remain necessary, provide a concrete decision and exact authorization boundary; do not hide them behind vague “blocked” text.

Preserve accepted work instead of restarting the migration from zero. Provide a mapping for every existing implementation WP, validation task and phase gate: retained, split, moved, consolidated or proposed superseded, with justification and the unchanged required outcome. Keep historical IDs/results/evidence retrievable. Do not invent DONE/VERIFYING/READY transitions through a document rewrite.

### 2. Detailed instructions and expected results for every stage

Every stage/task must give an implementing agent a complete, bounded contract:

- Aim, why it belongs here, and observable behavior expected at completion.
- Entry criteria, accepted prerequisites, environment/toolchain/platform requirements and ownership.
- In-scope components/files and explicit stop conditions for scope expansion; trusted versus untrusted execution boundaries.
- Ordered implementation/research steps at a useful level of detail, with reviewable subdivisions for substantial changes.
- A falsifiable claim and focused RED/GREEN strategy, including edge cases/failure modes.
- Required outputs: code contracts where future implementation is authorized, executable tests/fixtures, reports, source/build manifests and handoff artifacts.
- Exact acceptance criteria, expected success/error behavior, important verdict/score/event/lifecycle assertions and supported platform/role/source matrix.
- Commands verified against actual scripts, coverage supplied by successful enclosing commands, and distinct checks that cannot be deduplicated.
- Cancellation/crash/deadline behavior, harness descendant drain, protected-state audit, owned root/port/handle cleanup and delayed observation wherever resources are involved.
- Missing-prerequisite and failed-check handling, rollback boundary, and the next eligible stage only after independent acceptance.

Avoid stages defined only as “implement X” or “tests pass.” Do not invent outputs/results for unfinished Rust routes or accept fake success, a diagnostic badge or a single AC case as full integration.

### 3. Practical workflows that stay rigorous

Rewrite the researcher/remediator/reviewer process around concrete deliverables and one clear owner. Define planning/adoption versus implementation authorization, READY claim, IN_PROGRESS edits, frozen VERIFYING handoff, fresh independent acceptance/rejection and retry.

Provide reusable neutral prompt templates and a compact handoff schema. Explain when to continue a chat versus start a fresh one, file ownership for shared modules, serialized stateful runs, Windows/Mac scheduling, and independent review without self-acceptance. Preparing prompts must not dispatch chats or grant implementation permission.

Keep feedback loops efficient: cheap decisive preconditions first, focused RED/GREEN during edits, one successful final command union per role on the frozen candidate, and reuse only proven-applicable evidence. Preserve every failure and rerun changed/invalidated coverage. Do not solve overhead by lowering mandatory gates, removing assertions, weakening audits or confusing remediator logs with reviewer execution.

Define source/build/environment provenance and invalidation, including complete archive closure, literal Unicode member names, signed resource inputs, stale binary/cache detection, actual launched target/features/backend identity and authoritative locks. Match current `check:full`: fast → Rust → server → static parity → version. Static parity is not live oracle/security/GUI/package acceptance.

Verify the new execution caller fails closed before hostile fixtures; toolchain certification alone is insufficient. Destructive/adversarial tests require verified disposable roots and harness tree termination/drain. Track ambient host changes truthfully instead of forcing equality.

### 4. Security, parity, performance and release remain complete

Preserve zero-network strict sandboxes, out-of-process executor/guardian ownership, rational scoring, no compiler fallback, no new unapproved dependencies, the four-tier boundaries and quality floor. Do not edit AGENTS.md/guidelines.md/CONSTRAINTS.md to make a new workflow easier; report any necessary authority change as a separate unapproved proposal.

Retain all six production languages, supported source/role/platform obligations, HTTP and filesystem safety, cancellation/lifecycle, Node/Rust semantic parity, OSD, configuration, export/archive/update ownership and UI compatibility.

Keep benchmarks measured before optimization with explicit comparable inputs, sample counts, distributions and real budgets. Preserve actual Mac GUI/manual acceptance where SSH cannot prove behavior. Keep Node default until approved cutover, version 1.5.1 until the coordinated release stage, rollback/stabilization before decommission and separate explicit release/publication authorization.

## Required written deliverables

1. A concise plan-audit report under `docs/verification/pure-rust-core/`: contradictions/current gaps, evidence, alternatives, selected design/tradeoffs, old-to-new mapping, unresolved human decisions and adversarial review findings/disposition.
2. A rewritten complete detailed implementation plan with dependency diagram, stage contracts, expected deliverables, acceptance matrices and the concrete next action from today's checkpoint.
3. Consistent revised start-here, efficient-execution, review-workflow and handoff documents, with reusable remediator/reviewer prompt templates. Reconcile the original migration-plan overview where needed; preserve historical facts and clearly distinguish the new proposed roadmap from accepted implementation evidence.
4. A compact human summary: what changed, why it fixes the current deadlock, what can be authorized next, what remains blocked, and how each later stage contributes to the final product.

Preserve immutable artifact collections, historical prompts, append-only WORKLOG and accepted package verdicts. If the new graph changes task IDs or ledger shape, provide a proposed mapped ledger instead of silently overwriting implementation states; retain the live ledger's current real verdicts. Record this planning task and link revised documents without claiming runtime acceptance. Clearly label any outstanding plan adoption/scope decision.

Validate references, graph acyclicity, prerequisite completeness, mapping coverage, owner/role transitions and command accuracy; run documentation whitespace/link checks such as `git diff --check`. Report runtime/build/security/platform tests as NOT_RUN because this assignment is planning only. Do not execute the new roadmap.

Finish with the rewritten documents and concrete next-step instructions. No implementation, automatic chat dispatch, package acceptance, release or publication is authorized by this prompt.
