# Rust core — rigorous, practical execution

> **2026-10-17 Adopted Execution Revision (Direct Human Authorization by Mon):**
> - Adopts **4 Macro-Milestones (`M1`–`M4`)** batching the remaining 46 work packages (`WP0.6`–`WP10.6`) and 11 phase gates (`G0`–`G10`), **Tiered & Scoped Re-verification**, **Persistent Incremental Build Caches**, and **JSON-Only Hash Binding** (eliminating per-micro-WP tarball/rebuild cycles and prose Markdown `(bytes, sha256)` self-referential traps).
> - Preserves **100% Engineering Rigor**: strict TDD (`RED` → `GREEN`), fresh-context 5-axis adversarial subagent review, zero-tolerance quality floor (`npm run check:fast`, `cargo clippy --locked --all-targets -- -D warnings`, `cargo test --locked`), Windows x64 + live Apple Silicon Mac (`judgedesk-mac`) execution, 1-to-1 `WP*` Traceability Matrix, fail-closed OS sandboxes, exact `BigUint` rational scoring, 8-file version lockstep `1.5.5` (`crates/judgedesk-core` at `1.5.1` until `WP10.3`), and independent Milestone review.
> - Current live package and milestone verdicts remain in [STATUS](verification/pure-rust-core/STATUS.md).

Read the [complete task contract](pure-rust-core-detailed-implementation-plan.md) and [role workflow](pure-rust-core-review-workflow.md). Efficiency comes from decisive preconditions, focused changes, applicable evidence and clear ownership. It never removes a test, security threshold, supported profile, host audit or independent verdict.

## 2026-10-17 Adopted Macro-Milestone & Streamlined Execution Protocol

1. **Macro-Milestone Batching (`N0` Prerequisite + `M1`–`M4`):**
   Instead of stopping for 56 separate micro-WP freeze/tarball/review handoffs across `WP0.6`–`WP10.6` and `G0`–`G10`, implementation and independent verification are batched into `N0` plus **4 Macro-Milestones**:
   - **Prerequisite `N0` (`N0-C10-GATE-R1` Scoped Closure):** Resolve the single remaining open P2 finding `N0-C10-GATE-R1` (`npm run test:macos-process-supervisor` generation-guard / prewarm isolation on macOS) under **Scoped Re-verification** (see Rule 3 below), retaining all independently verified Windows and Mac gates from `codex-independent-review-20261017T054000Z` / `codex-review-closure-20261017T065802Z` by `evidenceMode: reference`.
   - **Macro-Milestone 1 (`M1`: `WP0.6` → `G5` — Core Judging, Security, Toolchains, Batch & Interactive Semantics):** Batches `WP0.6`, `WP0.7`, `G0`, `WP1.1`–`WP1.7`, `G1`, `WP2.1`–`WP2.7`, `G2`, `N1`, `WP3.1`–`WP3.3`, `G3`, `WP4.1`–`WP4.5`, `G4`, `WP5.1`–`WP5.4`, and `G5`. Leverages the existing Phase A (`Bước 1–5`) implementation in `crates/judgedesk-core`, closes the remaining parity gaps in ordered TDD sub-slices with fresh-context 5-axis adversarial review per slice, maps every `WP*` requirement to exact code + test coverage in a **1-to-1 Traceability Matrix**, and undergoes one unified independent review at `G5`.
   - **Macro-Milestone 2 (`M2`: `WP6.1a` → `G6` — OSD Daemon & Complete HTTP Route Parity):** Batches `WP6.1a`, `WP6.1b`, `WP6.1c`, `WP6.2`, `WP6.3`, and `G6`. Implements the Rust OSD daemon (`crates/judgedesk-core/src/server/routes/osd.rs`) and completes all workspace, config, archive, export, and lifecycle route contracts, verified once at `G6`.
   - **Macro-Milestone 3 (`M3`: `WP7.1` → `G8` — Universal PCH, Prewarm & 100% Node-vs-Rust Semantic Parity):** Batches `WP7.1`–`WP7.4`, `G7`, `WP8.1`–`WP8.3`, and `G8`. Implements Universal PCH + selective background prewarm and proves 100% sequential Node-vs-Rust corpus parity across all 6 languages, verdicts, exact rational scores, and rankings, verified once at `G8`.
   - **Macro-Milestone 4 (`M4`: `V9.1` → `G10` — Desktop Packaging Matrix, `v1.6.0` Cutover & Decommission):** Batches `V9.1`–`V9.4`, `G9`, `WP10.1`–`WP10.6`, and `G10`. Executes full Windows MSI and macOS `.app` packaging, resource/single-instance/supervisor gates, GUI matrix, default backend switch to Rust (with Node rollback), atomic 8-file bump to `v1.6.0`, and separately authorized Node decommission.

2. **Tiered Verification & Persistent Incremental Build Caches:**
   - **Inner Development Loop (Sub-Slices within a Milestone):** Run directly against the workspace on Windows x64 and a persistent development directory on `judgedesk-mac` (preserving `target/` for incremental Cargo builds) using `npm run check:fast`, `cargo clippy --locked --all-targets -- -D warnings`, and focused `cargo test --locked` / `node scripts/run-all-tests.js --filter=...`. Do **not** build `.msi`/`.app` installers or re-extract source tarballs on every sub-slice.
   - **Milestone Gate (`VERIFYING` Handoff at `G5`, `G6`, `G8`):** Run `npm run check:full` and `npm run test:security` on both Windows x64 and live Apple Silicon Mac (`judgedesk-mac`), plus the milestone-specific integration suites (`test-build-feature-identity.mjs` in `M1`; OSD suites in `M2`; PCH benchmark and full Node-vs-Rust parity harness in `M3`).
   - **Packaging & Platform Resource Gates (`N0` Mac Supervisor, and `M4` / `G9`–`G10`):** Full `.msi`/`.app` installer builds, `windows-resource-gate.ps1` (`512 MiB` / `1024 MiB`), `windows-single-instance-gate.ps1`, `test:macos-process-supervisor`, and `test:macos-packaged-checkers` are required only when `native-executor` or `src-tauri` packaging/supervisor code is modified (such as `N0-C10-GATE-R1`) and at **Macro-Milestone 4 (`G9`–`G10`)**.

3. **Scoped Re-verification on Bounded Remediation Rounds:**
   - When an independent review (`V7` or a Milestone review) verifies a set of gates and isolates specific open findings, the subsequent remediation round **only re-runs the gates affected by the touched files plus fast/unit/core regression checks** (`npm run check:fast`, `npm run test:rust`, and the specific failing gate/suite), retaining unaffected independently verified gates by `evidenceMode: reference` as long as their owning layers were not modified.
   - Specifically for **`N0` (`N0-C10-GATE-R1`)**: because `codex-independent-review-20261017T054000Z` / `codex-review-closure-20261017T065802Z` already independently passed Windows `test:server` (`948/958`) and Mac `check:fast`, `OSD 8/8`, `test:server` (`950/958`), `harmless 23/23`, `logger falsifier`, `91-row production`, `74/74 focused union`, `check:full` (`9/9` Rust + `950/958` server), `test:security` (`17/20`), and `.app` codesign, the `N0-C10-GATE-R1` remediation and its independent re-review only need to execute:
     1. Passive root-cause attribution + TDD `RED` → `GREEN` + 5-axis adversarial review for `N0-C10-GATE-R1`,
     2. `npm run check:fast` and `npm run test:rust` on Windows and Mac (plus `npm run test:server` if `server/` is touched), and
     3. Re-building the Mac `.app` (if `src-tauri` / `native-executor` / `server` is touched) and passing `npm run test:macos-process-supervisor` (repeated `3/3` consecutive runs to prove determinism) + `npm run test:macos-packaged-checkers` (with port rebind and zero orphan processes/descriptors) on `judgedesk-mac`, while retaining the unchanged Windows/Mac gates by `evidenceMode: reference`.

4. **JSON-Only Hash Binding (Zero Prose Hash Ceremony):**
   - Markdown documents (`STATUS.md`, `WORKLOG.md`, reports, handoffs, and reviewer/remediator prompts) **must never hardcode `(bytes, sha256)` tuples** for evidence logs, historical manifests, or self-referential markdown files.
   - All file byte sizes and SHA-256 digests are recorded exclusively in machine-generated JSON manifests (`evidence-final-manifest.json` / `review-evidence-manifest.json` + `.sha256` sidecar). Prompts and reports reference artifacts by relative path only.

5. **Streamlined Protected-State Auditing:**
   - All unit and integration tests must isolate `THEMIS_APP_DATA_DIR`, `LOCALAPPDATA`, and `TMPDIR`/`TEMP` inside test-owned temporary directories (`OwnedWorkspace`).
   - Full `before`/`after` SHA-256 inventories of the 4 host Protected Roots (`ThemisV2` and `JudgeDeskExecutor` on Windows and Mac) are captured **once per Milestone `VERIFYING` window** (and whenever running packaged `.app`/`.msi` gates that touch host default paths), rather than on every inner-loop test run.

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
