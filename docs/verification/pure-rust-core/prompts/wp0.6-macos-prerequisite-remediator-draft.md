# DRAFT — WP0.6 remediation with a bounded Mac native prerequisite

**NOT AUTHORIZED FOR IMPLEMENTATION.** Prepared on 2026-10-01 for planning only. The latest request explicitly says not to implement; the earlier instruction keeps the Mac blocker pending. Reading or preparing this prompt, starting a chat or inspecting source does not supersede those instructions.

Before any source edit, obtain direct human authorization that explicitly approves this named Mac native prerequisite within an amended WP0.6 scope and permits the ordering exception while WP0.6's Mac full gate fails. Record that authorization and the exact allowed boundary in the canonical report/WORKLOG; reconcile or explicitly transfer the current owner. Without it, stop after read-only intake. Do not ask for already granted permissions again once this exact scope has been approved.

This is a neutral remediator role. Do not self-accept, dispatch another chat, claim WP5.4 or mark it DONE/READY. Different-model review was declined; do not ask again. The existing LOG-0091 prompt pair/evidence remains historical/current until an approved amendment is recorded.

## Read and establish the bounded claim

Read AGENTS.md, guidelines.md, CONSTRAINTS.md, start-here, STATUS/latest relevant WORKLOG, detailed-plan §§2–4, WP0.6, WP5.4 and failure-triage rules, review-workflow and efficient-execution. Read `wp0.6-blocker-next-step-proposal.md`, the canonical WP0.6 report and LOG-0091 continuation evidence. Apply relevant TDD, doubt-driven, debugging, security, quality-floor and review skills.

WP0.1–WP0.5 are DONE. WP0.6 is IN_PROGRESS; WP5.4 is NOT_READY with unmet WP3.2/WP4.3/WP5.1 dependencies. This proposed prerequisite does not waive those dependencies or satisfy full Rust integration.

Refresh actual HEAD/dirty source, eight application versions, hosts/toolchains and ownership. Preserve unrelated dirty/untracked inputs; no reset/stash/clean, commit/push, new dependency, protocol/version bump or identity rename is authorized. Current diagnostic input, not a future repaired candidate: HEAD main `8bc8ac9a2161a7468b633c421185d039c97e5a68` plus dirty inputs; archive 3,177 regular members / 78,238,397 bytes / SHA256 `3B100EE59C20936D24CA173F882969DAB7ABB970C026E9AF8B294142B2F95B8A` under `artifacts/wp0.6/remediator-log0091-continuation-codex-20261001/`.

Claim: the existing supported macOS Node/native interactive path can execute both participants with truthful results, independent strict isolation/limits and complete cancellation/drain; WP0.6 compiled identity and lockfile contracts remain intact. Prove the claim through production callers, not a mock runner or a single AC fixture.

## Allowed implementation and hard stop conditions

Primary ownership is `native-executor/src/platform/mod.rs`, `native-executor/src/platform/macos.rs`, and existing native Mac process/launcher/controller/guardian/validation support modules strictly needed for the dual-process path, plus directly related tests. Search existing primitives before adding helpers. Reuse the accepted WP0.4 executor ADR, framed IPC, guardian/generation ownership, role validation, compiler selection and existing Node caller.

Audit callers in `native-executor/src/main.rs`, `protocol.rs`, `request_validation.rs`, Mac support modules, `server/executor/{client,protocol,workspace}.ts`, `server/judge/{testcase-runner,interactor-compiler}.ts`, corpus tests and Rust consumers. Audit Windows interactive behavior for regression, even when only the Mac platform arm changes.

No new Rust-core language adapter, job/cancellation owner, scoring implementation, stream/route contract, compiler fallback, backend cutover or UI change belongs here. Preserve the current IPC schema and existing Node behavior. If the fix requires any such change, a security policy expansion, a new dependency, or an authority decision outside this boundary, stop and present the concrete finding before proceeding. Do not indirectly implement WP5.4 dependencies under the prerequisite name. Preserve exact rational scoring; existing wire fields do not authorize new floating-point score arithmetic. Escalate if the bounded implementation cannot preserve that contract.

This is new platform behavior, potentially substantial. Apply detailed-plan §3.6 sizing: stage roughly 100–300 production lines per reviewable behavioral contract and revise the staged scope before exceeding it. Intermediate states must remain fail-closed; no temporary unsandboxed/direct-process success path.

## RED, security ordering and GREEN

Preserve current full-gate failure and reproduce `cpp_interactor` through the existing Node → framed IPC → native path on live Mac arm64. Current expected AC must remain unchanged; current actual JE originates in `platform/mod.rs`'s Mac branch. Add focused failing production-path tests before implementation.

First validate the **new dual-process caller path** using non-destructive sandbox-denial, request-validation and partial-start/ownership checks. Existing language/toolchain certification alone does not prove the new launch path fails closed. Only after that precondition passes may hostile fixtures execute in verified disposable owned roots. The harness must kill/drain its complete owned descendants on deadline and report failed drain as FAIL.

Define the selected matrix before running tests: supported C++ and Python participant combinations, currently certified managed/local source and role combinations, host/compiler/runtime identities, and supported/unsupported policies. Cover every newly reachable supported combination; retain unsupported combinations as unavailable and retain the existing manifest/skip authority. Missing supported runtime is BLOCKED and prevents the corresponding acceptance, never a fallback or new skip.

Required independently reported cases include:

- Normal bidirectional exchange, C++/Python interactor where supported, input-only/no expected output, and existing testlib/verdict/partial-score semantics through the canonical mapping.
- Independent participant time, memory, output, process/thread/open-file/write limits; bounded pipe/transcript buffering and diagnostic retention.
- Contestant and interactor timeout/crash separately; pipe close, saturation/deadlock/output flood, invalid request and second-launch failure after the first participant has started.
- Cancel during partial startup and active exchange, repeated cancel, Node/client disconnect, executor crash/EOF/shutdown and guardian/generation loss; no participant or descendant may survive any terminal path.
- Both participants' zero-network and filesystem isolation, denied external reads/writes, unauthorized cross-participant access and descendant escape attempts. Use verified OS sandbox primitives; never ResourceOnly or a direct host launch.
- Windows regression through the existing interactive path and unchanged non-interactive native/Node behavior on both hosts.

Assert actual process death/drain, handle closure, runtime port rebind where used, safe owned-root removal and delayed final cleanup after each resource-owning scenario. Failed assertions, outer timeouts and failed startup must receive the same cleanup scrutiny as successful cases.

## Complete WP0.6 on the combined candidate

After focused GREEN and bounded adversarial review, freeze the complete combined source/test/script/fixture/build closure. Record every hash/size/exact Windows UTC-mtime and archive size/SHA/regular-member inventory; preserve all preceding archives, failed runs and mutation evidence. Validate literal Unicode filenames on Mac and include the existing trusted signed manifest without changing trust policy. Never reuse stale compiled executors as evidence for repaired source.

Recheck every WP0.6 criterion and LOG-0090 finding: compiler-selected features under forged declared/undeclared parent variables, default/no-default/actually enabled test-server, development/packaged release, build-input refresh, both shared core/Tauri consumers, startup/status/NDJSON equality, Node/frontend compatibility, actual target/backend/executable hashes and authoritative lockfiles. Preserve eight-file 1.5.1 and the independently governed core crate version. Use the original LOG-0091 production-path RED as labeled reference; rerun invalidated GREEN/build/runtime evidence. Native changes invalidate affected binaries/integration results. Without a demonstrated dependency map, assume broader affected coverage rather than inheriting the old PASS.

Each host requires one successful final-source `npm run check:full` union, with actual locked Rust fmt/all-target Clippy/tests, server/corpus, static parity and version children. Deduplicate only identical successful children. Add distinct security/native interactive/guardian/supervisor checks, including `npm run test:security` and applicable existing `test:macos-process-supervisor`/packaged-checker coverage after inspecting their actual contracts. Existing broad commands do not substitute for new interactive security and failure cases. Capture before/after full protected-state audits and per-scenario plus delayed process/port/root cleanup, with raw ambient deltas retained.

Windows must remain PASS and the live Mac full gate must become PASS, including the unchanged interactive oracle, before VERIFYING. Additional unrelated failures remain FAIL with actionable findings; do not mask them or expand implementation scope automatically. No skip/filter/changed oracle, sandbox relaxation or compiler substitution is permitted.

## Handoff and stop

Write one canonical WP0.6 combined report with the separately identified native prerequisite contract, scope authorization, attributable diff, RED/GREEN inventory, real commands/results/counts/times, source/build/lock/toolchain identities, audits/cleanup and limitations. Link immutable artifacts and preserve the earlier collection. Record unscheduled signing/installer/GUI/publication/cutover/performance acceptance as NOT_RUN without claiming it passed.

Update this draft's paired reviewer intake with the actual new immutable candidate only after the amendment is authorized and implementation gates pass. Then set **WP0.6 VERIFYING**, append WORKLOG and stop source edits for fresh independent review. Never mark WP0.6 DONE yourself. WP5.4 remains NOT_READY; no WP0.7/G0 work or automatic dispatch. If the approved scope cannot pass the required gate, leave WP0.6 IN_PROGRESS with exact findings and safe cleanup.
