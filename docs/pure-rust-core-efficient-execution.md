# Rust core — rigorous, practical execution

> 2026-10-01 proposed execution revision. Apply only after adoption and package authorization.
> Current live package verdicts remain in [STATUS](verification/pure-rust-core/STATUS.md). Version 1.5.1 until WP10.3.
> 2026-10-02: direct N0 authorization and limited N0 → WP0.6 ordering adoption are recorded. Continue that bounded package; other roadmap changes remain proposed.

Read the [complete task contract](pure-rust-core-detailed-implementation-plan.md) and [role workflow](pure-rust-core-review-workflow.md). Efficiency comes from decisive preconditions, focused changes, applicable evidence and clear ownership. It never removes a test, security threshold, supported profile, host audit or independent verdict.

## One accountable cycle

1. Research current callers, selected source/build identity, actual script coverage and cheap environment/capability prerequisites. Produce a claim, scope/files, upstream artifact list, matrix, commands/coverage, cleanup design and stop conditions. Prepare both neutral prompts; no automatic dispatch.
2. Remediator claims authorized READY task (or explicitly transferred current remediation) IN_PROGRESS; preserves dirty inputs and records before audit prior to stateful operations. Focused RED/GREEN proves each changed behavior. Validate exact selected cases.
3. Bounded adversarial design/diff review before expensive final gates; resolve concrete findings together. Freeze source/tests/scripts/fixtures/config/locks/resources/recipe/features/target and actual binary identity.
4. Execute one successful complete final command union per remediator per host. Retain failed/interrupted attempts and rerun changed/invalidated coverage. Write one canonical report and compact handoff; VERIFYING freezes edits.
5. Fresh independent reviewer validates intake/diff/inventory and critical falsifying preconditions first. If decisively rejected, complete cleanup and report findings without spending time on irrelevant broad gates. Otherwise execute its own successful final union and distinct contract/security/platform checks. Remediator logs are evidence inputs, never reviewer-executed PASS.
6. Rejection returns IN_PROGRESS with action list and both next-round prompts. Same-package remediation can continue in accurate context. Separate fresh acceptance remains required. After DONE, only separately authorized nodes with all accepted prerequisites are eligible.

“One successful union” is not a quota or permission to reuse a failed run. Stateful windows include builds, compiler probes, test initialization and failed harnesses. Do not start a second window to conceal an earlier leak/damage.

## Actual command composition

Verified by source inspection on 2026-10-01; no runtime command was executed for this rewrite.

| Command | Coverage and limits |
|---|---|
| `npm run check:fast` | check-node then lint: tsc --noEmit + quality gate |
| `npm run check:full` | **check:fast → test:rust → test:server → test:themis-parity → release:check-version**, stops at failed child |
| `npm run test:rust` / `npm run check:rust` | Sequential native/core/Tauri fmt, locked all-target clippy -D warnings, locked tests: nine steps, aggregate fails if any failed; native/core serial test threads |
| `npm run test:server` | check-node → build/stage native executor → read-only corpus:check → discovered server/frontend/shared/script test runner and expected-skip validation |
| `npm run test:corpus` | read-only corpus:check plus corpus-selected test files; no materialization |
| `npm run test:themis-parity` | Static checker comparisons; platform-specific packaged tiers retain actual platform limits; no full backend/live DLL/security/GUI proof |
| `npm run test:security` | rebuild executor and dedicated integration fixtures; distinct from full default Rust tests |
| `npm run test:desktop` | builds Node SEA and desktop preparation; cannot by itself establish a Rust-only product path |
| `npm run test:themis-oracle` | Separate verify gate for real reference/DLL inputs on Windows; :update-baseline is not repair authorization |

Successful same-candidate full coverage discharges duplicate fast/default Rust/server/static/version rows. If server fails, parity/version were not executed inside full; separate actual passes remain separate and do not turn full into PASS. Actual script outputs/inventory/configuration must match the required command, not just its name.

Extra feature/no-default/Cargo identity mutations, caller-specific hostile probes, `test:stress`, `test:performance`, Windows resources/single-instance, Mac supervisor/packaged-checkers, full semantic parity, real GUI and actual package/install/update/rollback/signature acceptance remain distinct. Exact commands/prerequisites appear in the detailed plan. Future parity/benchmark/Rust desktop scripts are required deliverables, not pre-existing commands.

Current CI runs separate lint/server, supported-host Rust, static parity and Windows live oracle; CodeMagic/release use different source/package sequences. Inspect and map their real union at handoff. No CI badge substitutes for this plan's independent local/live-platform coverage. A new pipeline change requires its own authorized code scope and regression proof.

## Focused selection

Use `node scripts/run-all-tests.js --filter=<file-pattern> --dry-run` to enumerate files, then same filter with `--test-timeout=30000` for tests. The runner rejects empty file selection, but that does not prove every required nested assertion executed. Rust filters must name actual tests; exact fully qualified selection and no unexpected skips must be recorded. A suite parent regex may run everything; a filtered run is never a full gate.

Structural hash/schema/path mutants exercise real validator in owned copies; semantic verdict/score/group/checker/interactor mutants exercise the actual production caller. No native compile is needed to prove malformed schema refusal. No synthetic result proves a judge verdict. Fixture capture precedes implementation and preserves the unchanged accepted oracle.

## Source, build and environment provenance

Record HEAD plus attributable dirty/untracked bytes; HEAD alone is insufficient. Include source/test/script/config/golden/generated/resource closure, npm/Cargo owning lockfiles, profile/features/target/recipe, environment allowlist, OS/hardware/SDK/compiler/runtime/signature identity, actual launched executor/core/Node/Tauri/helper paths and hashes. Keep core crate version distinct from eight-file app version.

Complete archives include required signed resources even if ignored by Git; exclude/rebuild generated targets/caches rather than silently reusing stale outputs. Verify archive SHA/bytes and regular-member manifest, unique safe literal Unicode paths/types, hash/size, no links/linked ancestors, missing/extra nodes and extracted bytes before/after runtime work. BSD tar's observed name decomposition must not be “fixed” by weakening fixture normalization. Use the proven exact extraction contract when needed.

Selected binary hash must bind to source/build-input manifest and actual recipe/log or independently reproduced build. A frozen old target/debug/fixture binary cannot prove repaired source. Validate architecture and executable ownership/ACL/no-reparse policy. Feature identity comes from compiler-selected configuration, not inherited CARGO_FEATURE names; runtime labels cannot spoof build identity.

Do not inherit signing keys/secrets into disposable mutants or untrusted execution. Record required signed-resource fingerprints and public trust inputs; private signing credentials are never archive closure.

## Reuse and invalidation

| Evidence | Reuse permitted | Invalidation |
|---|---|---|
| Accepted immutable corpus/Node golden | same bytes/reference semantics/schema/config and accepted provenance | changed reference behavior/fixture/normalization |
| Build cache | exact relevant source/recipe/locks/generated/resources/features/target/compiler/SDK/env/OS and trusted selected binary proven | any changed or unknown input, corrupted/writable/stale executable |
| Independent pure/component PASS at phase aggregation | original verifier/log hash, inventory/assertions/skip/matrix and applicability recorded | changed relevant inputs, missing row, instability or unknown dependency map |
| Role's final full gate | own successful same frozen candidate/config and every child actually executed | edits/config/source closure drift; failed/unexecuted child; other role's logs |
| Host before audit | uninterrupted same role-owned stateful window | interruption/reboot/drift must be reconciled, not erased; later work gets fresh baseline |

Add `evidenceMode: executed | reference`. Reference points to the original result; never relabel it a newly executed PASS. Unknown applicability forces rerun. In absence of a proven dependency map, assume broader invalidation. App-level source changes invalidate required full candidate gates even if a small pure unit can be retained as reference.

Phase gates aggregate accepted evidence and fresh integration scenarios. Live security/drain/stress/performance/GUI/package/install/upgrade/rollback/release acceptance scheduled by a gate runs freshly. Accepted foundations are not restarted simply to refresh a report date; new current-source intake supplements their history.

## Hosts and cleanup

One owner for shared route/session/job/registry/IPC/workspace/golden files. Serialize stateful tests sharing executor/cache/AppData/ports/package roots on a host. Windows and Mac may run in parallel on independent hosts with identical source and separate writable roots. Read-only independent research can overlap only by explicit owner arrangement. Never run performance trials while builds/tests/prewarm/indexers contend.

Before first stateful operation fully hash ThemisV2 and JudgeDeskExecutor contents/types/links plus semantic preferences/receipts/cache authority; capture processes/listeners/temp and Defender/Mac host state. Hash every file even with stable mtime/size. After each resource scenario, check actual native/container/descendant drain and handle/root/port release. After window, repeat full protected hash/semantic comparison and immediate/delayed 5–15 s cleanup; use actual port rebind, exact PID/start/owner, safe marked roots. Ambient system differences are separate raw records, not forced equality.

Pin the actual original protected root set independently of private runtime TMPDIR/AppData overrides. Environment isolation must precede process startup and test initialization; health/self-test may already mutate generated state. Audit tools must continue observing the original roots. After protected damage, retain the original FAIL, prepare exact recovery inventory/trusted original bytes and obtain authorization for concrete protected-path operations before writes. Safely guarded source work and isolated focused tests may continue while recovery is pending; no VERIFYING until verified incident closure, fresh linked final union and cleanup. See the [N0 incident procedure](verification/pure-rust-core/n0-plan-conflict-resolution-20261002.md); never replace the original baseline with the mutated state.

Harness deadline, logger write failure, assertion exception and partial spawn must close admission, terminate/reap/drain all owned descendants and retain guard ownership until proof. The existing feature-identity script's inner spawnSync lacks a timeout: inspect/contain it with a verified outer harness before a future run. The previously rejected experimental logger is not evidence of a safe replacement harness. No host-global process kill or unowned temp recursion.

Verify new caller fail-closed behavior with harmless validation/denial/partial-start probes **before** hostile fixtures. Disposable root identity and no-link boundary are mandatory; toolchain certification alone does not authorize the new caller.

## Failure routing without a scheduling deadlock

Suspend the failing package and preserve logs/oracle/source/audit. Identify the actual missing artifact/behavior and owning layer. Same-contract remediation continues in scope. If it is a shared/native prerequisite omitted from the graph, present a concrete bounded upstream repair and require direct human ordering/scope authorization. Record ownership transfer and new edge; do not grant DONE, skip/filter/change expected verdict or implement unrelated later features.

N0 is the bounded application already authorized by direct dispatch on 2026-10-02: only N0 → WP0.6 ordering was adopted, with separate independent native safety acceptance; future complete WP5.4 remains late Rust integration. N0 and WP0.6 each retain their own final required union; additional gate cost is explicit. The rest of the proposed graph remains unadopted. N0 may coordinate private native launcher/guardian pipe/control representation under the detailed boundary while public framed IPC and sandbox authority remain fixed. An expected focused RED or open preservation incident does not suspend all safe authorized N0 source work; the incident still blocks VERIFYING.

## Handoff and measured overhead

Use one report with immutable logs/manifest links, STATUS for current verdict/owner, append-only WORKLOG for transition history. Continue an implementation chat for accurate same-WP debugging or a separately authorized next READY claim after DONE; start fresh for independent acceptance, ownership transfer, major trust/phase boundary or lost/drifted context. Prompts never dispatch chats or assign a model.

Track research/edit/focused/final-gate/audit/review/rerun/external-wait time separately. Historical full/audit times show that budgets may be expensive; do not delete checks to fit an estimate. One old duplicated server run cost about 2.2 minutes of test execution in WP0.3; no whole-migration speedup percentage follows. This planning task performs only documentation checks and records runtime **NOT_RUN**.
