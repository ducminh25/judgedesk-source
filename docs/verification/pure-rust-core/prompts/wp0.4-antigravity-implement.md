# Prompt 1 — Antigravity: implement WP0.4 only

You are the implementer/remediator for JudgeDesk's Pure Rust Core migration. Mon has explicitly restored the normal separation of roles: Antigravity implements; a NEW Codex conversation independently reviews and verifies. Start the authorized work now. Do not ask Mon to re-authorize this assignment.

## Assignment and current baseline

Work in the existing saved checkout: `D:\Minh\Code\judgedesk`. **WP0.4 ONLY: executor architecture ADR and the minimum real enforcement/tests needed to accept that boundary.** Continue the existing draft; do not create a second ADR or restart WP0.3.

At this handoff, WP0.1–WP0.3 are DONE; WP0.4 is IN_PROGRESS, handed from Codex's initial draft to Antigravity in LOG-0053. Progress is 3/51 implementation WPs and 0/11 phase gates. WP0.5–WP0.7 have READY rows, but this assignment does not authorize starting them. G0 remains NOT_READY. WP0.3's Mon-authorized self-acceptance exception does not apply here.

Observed HEAD: `b68242131eaf8db15990fadf1c48c8c16c45473e`, plus preserved dirty WP0.3 and documentation changes. Verify the actual checkout; HEAD alone is not source identity. Preserve all existing work, including untracked evidence. Do not reset, stash away the accepted edits, create a clean worktree that omits them, commit/push, or bump versions. Eight-file source lockstep is **1.5.1**; target **1.6.0** is deferred to WP10.3.

## Read and claim before implementation

Read `AGENTS.md`, `guidelines.md`, `CONSTRAINTS.md`, then:

1. `docs/pure-rust-core-start-here.md`.
2. `docs/verification/pure-rust-core/STATUS.md` and the latest relevant entries in `WORKLOG.md` (LOG-0050 onward at this handoff).
3. `docs/pure-rust-core-efficient-execution.md` and `docs/pure-rust-core-antigravity-handoff.md`.
4. WP0.4, its dependency/verification rules, and the relevant Phase 1–5 sections in `docs/pure-rust-core-detailed-implementation-plan.md`.
5. `docs/adr/0001-rust-core-executor-boundary.md` and `docs/verification/pure-rust-core/wp0.4-executor-boundary.md`.

Load task-relevant project skills: TDD, doubt-driven development, security/hardening, debugging when needed, constraints, and code review/quality before submission. Apply required fresh-context adversarial review at nontrivial decisions; this does not replace Codex's independent acceptance. Refresh the accepted WP0.1/WP0.3 reports only where needed; do not replay their full suites as separate packages.

Record your WP0.4 ownership claim and initial dirty/source inventory in STATUS and a new append-only WORKLOG entry using the actual next free LOG ID. Keep the package IN_PROGRESS. If current state differs from this handoff, reconcile against current authoritative evidence before proceeding.

## Research order and implementation direction

First write a short falsifiable contract and assertion/command map. Inspect these paths before choosing abstractions:

- Node reference: `server/executor/client.ts`, `protocol.ts`, `workspace.ts`.
- Native boundary: `native-executor/src/main.rs`, `protocol.rs`, `request_validation.rs`, `tree_guard.rs`, and the actual platform guardian/controller modules.
- Partial Rust callers: `crates/judgedesk-core/src/server/mod.rs`, `engine/runner.rs`, `engine/session.rs`, `toolchains/diagnostics.rs`.
- Tauri ownership/packaging: `src-tauri/src/backend.rs`, startup/update guards, Cargo dependency/features, and sidecar build/package configuration.
- Existing client, protocol, native lifecycle, workspace and core tests.

Known starting facts to recheck: Node uses a separate executor through private framed stdio; the partial Rust core initializes/passes `Platform` in process, and runner invokes it directly. Native main acquires its tree guard before Platform initialization. Frames have a nonzero four-byte little-endian JSON length, capped at 1 MiB. `executorVersion` is a build/application field, not proof of wire negotiation. Private pipes alone do not establish the proposed authenticated-parent contract.

Recommended model: **out-of-process `judgedesk-executor`, typed Rust client, protocol-only type sharing**. Core/Tauri own HTTP/domain orchestration; native executor owns OS execution and sandbox/process cleanup. Resolve one narrow client/ownership seam before adapting callers. Prevent production release paths from directly executing Platform, including alternate Cargo features, test helpers and failure fallback paths. Reuse existing validation/lifecycle primitives rather than duplicating the executor.

Resolve exact Windows/macOS parent and generation binding, readiness, request correlation, frame/error handling, and crash/drain ownership against real source. Distinguish executor-generation guard from per-run guardian/controller. Cancellation must cover accepted reservations as well as active runs; a timeout/ack is not a completed native drain. Do not replace a generation until the old ownership chain is drained or proven terminated. Keep secrets out of logs and submission environments. Node rollback must retain compatibility with the same packaged executor and mutually exclusive backend generation.

Update the EXISTING ADR with selected/rejected alternatives, trust/process diagram, actual protocol/version compatibility, parent identity, exactly-once ownership, lifecycle, workspace/cache/package ownership and packaging/rollback. Clearly separate implemented proof from later integration work. Do not claim an unreachable production path based only on a future WP. A different architecture requires evidence equivalent to the plan's crash containment, limits, fail-closed termination, guardian, cancellation and rollback criteria.

Keep this package bounded: implement only the boundary enforcement and proofs required by WP0.4. Full backend supervision belongs to WP1.1, custom-checker integration to WP1.4, workspace work to WP1.6, session cancellation integration to WP4.3, compiler adapters to Phase 3, decomposition to WP0.7, and gate automation to WP0.5. Reuse their shared contract without implementing those packages now. If a narrow patch reveals a larger dependency, document the exact split and unresolved exit requirement; do not silently waive it or start a future WP.

## RED/GREEN and acceptance coverage

Map every ADR acceptance row to actual test names, production path, platform, command and evidence. Existing tests may satisfy a row only after checking their assertions and applicability. Required proof areas:

1. Production core cannot execute Platform in process, including release feature/build paths.
2. Rust client resolves the exact packaged executor; missing/incompatible binary fails unavailable without fallback.
3. Node/Rust legacy framed-v1 compatibility, correlation and strict frame-size/malformed/truncated handling.
4. Wrong parent or generation rejected before authenticated readiness on the required platforms.
5. One executor guard/client generation under concurrent startup.
6. Cancellation drains accepted reservations and active native runs.
7. Protocol failure/crash drains before replacement; no overlapping surviving generations.
8. Parent EOF leaves no owned child, port or temporary root.
9. Updater exclusive handoff waits for native-tree ownership release.
10. Explicit Node rollback uses the compatible packaged boundary without dual execution.

Use focused failing tests before behavior changes, then GREEN and refactor. Test the actual production caller/native boundary where the claim concerns execution or containment. Mocked responses and source regexes alone cannot prove native cleanup or release unreachability. Never run hostile fixtures before establishing containment. Keep exact rational scoring, fail-closed sandbox, no compiler fallback, no runtime Rust unwrap/expect, RAII, strict ESM/types, and all existing tests/quality floors intact.

## Fast execution with complete evidence

Follow `pure-rust-core-efficient-execution.md`: focused tests during edits, mandatory edit/pre-build floor checks, then one successful complete final-source acceptance run per actor. Inspect available toolchains/platform prerequisites early. Preserve failed/interrupted logs; fix causes and rerun affected tests after source changes.

On the stabilized candidate, run `npm run check:full`. It currently includes check:fast, test:server, static Themis parity and release:check-version: verify the actual script composition and record child results instead of separately repeating identical successful final children. This is not coverage for separate Rust/security/platform checks. Run required locked Rust tests, fmt and all-target clippy with `-D warnings` for affected core/native/Tauri crates and the platform-specific boundary probes required by this package. Record every discovered/selected test and skip; no empty selection or missing supported runtime may pass silently. Do not advertise static parity as live DLL, full migration parity or GUI acceptance.

Before the FIRST stateful probe/build/test, capture your own complete host baseline: both ThemisV2 and JudgeDeskExecutor roots with full per-file hashes and semantic state, relevant processes, listening ports, owned roots and required security state. Use isolated writable roots and verified containment/ownership; never clean arbitrary host paths or kill whole-host processes. Serialize suites sharing AppData/cache/ports. Check scenario cleanup, then complete the after audit and a delayed 5–10 second process/port/root observation. Preserve original baselines and raw drift; reboot or unrelated mutations must be reconciled, not rewritten as equality. A missing platform result remains missing evidence.

Freeze actual source/test/script/fixture/build inputs and executable provenance; hash/mtime snapshots must detect concurrent changes. Reuse builds only with verified input/toolchain provenance and executable ownership/ACL/reparse checks. Reuse immutable inputs; allocate fresh writable runtime roots. Record focused/final/audit times so savings are measured without reducing assertions.

## Submit and stop

Update `wp0.4-executor-boundary.md` as the canonical report: exact diff scope, decisions, RED/GREEN evidence, ten-row coverage matrix, commands/exit codes/counts/skips/durations, source/binary identities, platform limits, failed attempts, before/after preservation and cleanup. Link immutable logs instead of copying them into every ledger.

Only when required implementation evidence is complete, change WP0.4 IN_PROGRESS -> VERIFYING, append the handoff log, leave ADR proposed/submitted pending independent acceptance, and **stop all source/test changes**. Do not mark DONE or begin WP0.5. Finish with the frozen source identity, report/log locations, remaining limits and a concise summary for the new Codex reviewer. If completion is prevented by a real prerequisite, report it truthfully with the applicable lifecycle state; do not submit a simulated green result.
