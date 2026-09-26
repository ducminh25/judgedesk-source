# JudgeDesk Pure Rust Core — Detailed Implementation and Verification Plan

> **Audience:** Antigravity and future coding agents implementing the migration
> **Plan date:** 2026-09-19
> **Repository:** `D:\Minh\Code\judgedesk`
> **Observed base commit:** `d80f997cdafaf85883e7602de26c32dd355795a1` plus a large dirty working tree
> **Historical released baseline:** `v1.5.0`; current source lockstep is `1.5.1` as reconciled in STATUS/LOG-0050
> **Execution revision:** 2026-09-26 — see `docs/pure-rust-core-efficient-execution.md`; WP contracts/dependencies/exit criteria remain intact
> **Next release target:** `v1.6.0` (bump all eight version files together only in WP10.3, immediately before release-candidate verification)
> **Status:** implementation handoff; this file does not assert that the migration is complete

This plan is intentionally self-contained. Before changing code, still re-read the current `AGENTS.md`, `guidelines.md`, `CONSTRAINTS.md`, and applicable skills because they may have changed since this plan was written.

The evidence behind this plan is recorded in:

- `docs/pure-rust-core-migration-plan.md`: original migration architecture and roadmap.
- `docs/pure-rust-core-next-steps-audit.md`: verified gaps, commands already run, Windows Computer Use evidence, and macOS SSH evidence.
- `docs/PRD.md`, `docs/TRD.md`, `docs/APP_FLOW.md`, `docs/BACKEND_SCHEMA.md`, and `docs/UI_UX_DESIGN.md`: product and platform expectations. When these disagree with running code, resolve the disagreement explicitly as described below.

---

## 1. Mission, outcome, and reasons

### 1.1 Product outcome

Replace the Node.js SEA judging backend with an embedded Rust core without changing how JudgeDesk behaves for teachers and contest operators. The final desktop app must retain:

- The existing React user interface, shortcuts, state transitions, localization, error presentation, and scoreboard behavior.
- Exact contest discovery, Themis compatibility, problem configuration, compiler selection, verdict, rational score, ranking, archive, Excel export, OSD, update, and lifecycle behavior.
- Zero-network execution and fail-closed filesystem/process/resource containment for untrusted submissions, custom checkers, and interactors.
- Six production languages: C++, C, Python, Pascal, Java, and Scratch.
- Windows x64 and macOS Apple Silicon behavior, with differences only where the product explicitly defines a platform-specific policy.
- A deliberate rollback route during rollout, without silently selecting an incomplete backend.

### 1.2 Engineering outcome

The migration is complete only when the Rust backend:

1. Implements every production API and state mutation used by the frontend.
2. Uses the same normalized contracts and exact rational scoring rules as the Node backend.
3. Routes all untrusted execution through the native executor with the correct role and isolation policy.
4. Passes contract, unit, integration, security, stress, parity, desktop, packaging, and cross-platform gates.
5. Has measured performance that meets the documented budget without weakening correctness or isolation.
6. Becomes the default only after an explicit cutover work package and remains reversible during the defined stabilization window.

### 1.3 Why this ordering matters

Universal PCH and boot-time improvements are valuable, but they optimize a pipeline that currently has correctness and trust-boundary gaps. The order is therefore:

```text
contract capture
  -> close unsafe execution and fallback paths
  -> real toolchain state and compiler pipeline
  -> session/config/scoring/checker/interactor parity
  -> remaining product services
  -> PCH and performance
  -> dual-backend parity
  -> desktop/platform/package validation
  -> controlled cutover
```

This sequence prevents a fast but behaviorally incorrect or insecure Rust core from becoming harder to replace later.

The migration may raise the cost of casual source extraction compared with shipping a Node SEA, but compiled Rust is still reversible and inspectable. Treat IP resistance as a packaging benefit, never as a security boundary. Likewise, lower memory use and faster startup are hypotheses until WP7.1 produces comparable measurements from packaged builds.

---

## 2. Authority, invariants, and contract resolution

### 2.1 Authority order

Use this precedence when sources disagree:

1. `AGENTS.md` and `CONSTRAINTS.md` for process and quality-floor rules.
2. Security and data invariants in `guidelines.md`, native-executor validation, and platform sandbox tests.
3. Current frontend consumers, shared TypeScript contracts, and the production Node implementation for observable runtime behavior.
4. Product requirements in PRD/UI documents for intended user-visible behavior.
5. Architecture/API prose documents and the original migration plan.

Do not silently choose one source. Record each conflict in the work-package report with:

- the conflicting sources;
- the behavior currently shipped by Node;
- the proposed canonical behavior;
- tests proving the chosen contract;
- documentation updated in the same work package.

Known conflict: the frontend calls `/api/batch-judge` and `/api/batch-judge/cancel` and consumes JSON-line events named `metadata`, `progress`, `problem_completed`, `done`, and `error`. Some prose refers to `/api/judge/session`, traditional SSE names, `job_start`, `test_progress`, or `job_complete`. Do not implement those prose-only names unless a deliberate contract migration is approved and both backends/frontend are updated together.

### 2.2 Non-negotiable invariants

- Keep all eight version files synchronized. Do not bump versions as part of an unrelated work package.
- Version state is deliberate: historical `v1.5.0` upgrade evidence is retained; current eight-file source lockstep is `1.5.1` (STATUS/LOG-0050). Preserve the verified source version until WP10.3; never revert it to the older prose baseline. WP10.3 performs one atomic eight-file bump to `1.6.0`, followed immediately by version/release gates. This reconciliation does not itself verify a public 1.5.1 release.
- No `@ts-ignore`, `@ts-nocheck`, skipped/deleted tests, empty error suppression, fake success response, placeholder metric, or hidden fallback.
- Never use floating-point arithmetic for score accumulation, grouping, ranking, or checker partial points. Converting an exact result for final display is allowed only at the existing presentation boundary.
- No compiler/runtime fallback when the selected source is unavailable or incompatible.
- All persistent writes use same-directory temporary files, flush where required, and atomic rename/replace semantics.
- All untrusted code runs through an explicit native-executor role. A process timeout must kill and drain the whole process tree.
- `ResourceOnly` does not satisfy the release sandbox contract for untrusted submissions, Scratch projects, custom checkers, or interactors because it does not prove zero-network and workspace-only filesystem access. A language/source/role combination that cannot run under strict isolation is release-unavailable; a documented exception cannot be counted as `PASS`.
- Do not widen CORS, filesystem roots, sandbox capabilities, network access, process/thread limits, or path allowances to make a test pass.
- Preserve managed-Python semantics: managed Python may be submission-ready; system/auto Python remains checker-only unless it passes the explicit product certification policy.
- Preserve Reload semantics: existing checked and unchecked choices remain; newly discovered contestants/problems default to selected.
- Preserve Node as the default until the cutover work package passes. A missing/broken Node sidecar is a visible startup failure during this period, not permission to launch incomplete Rust behavior.

### 2.3 Current implementation facts that must be reverified

The following were verified on 2026-09-19 and may drift:

- Node full gate passed: 532 pass, 10 pre-existing skips, 0 fail.
- Windows Rust core tests passed 36; native executor passed 54; Tauri passed 14 with 3 ignored.
- Windows embedded Rust desktop started and reported `windows-lpac-job`. C++ self-test showed real values: compile 2926 ms, run 60 ms, memory 1976 KB.
- macOS ARM64 native executor passed 76 tests from an exact transferred source archive.
- macOS Rust core passed 35 then failed C++ diagnostics with `iostream file not found`. Host `/usr/bin/clang++` and `xcrun clang++` compiled a smoke program; the saved C++ local path selected Xcode `clang`, not `clang++`.
- Rust server/toolchain/session implementations contain partial and fake-success paths described in `pure-rust-core-next-steps-audit.md`.

Treat these as baseline evidence, not current truth. Re-run the Phase 0 snapshot before implementation.

### 2.3.1 Current hotspot map for incoming agents

This is a navigation aid, not a substitute for re-reading current code:

| Area | Current implementation/reference | Why it matters next |
|---|---|---|
| Frontend HTTP wrapper | `src/api.ts` | Canonical header/error behavior and place to deliver HTTP authorization safely. |
| Judge streaming consumer | `src/features/judging/useJudgeSession.ts` | Uses streaming `fetch`/`ReadableStream` for `/api/batch-judge`; its actual event names/order outrank stale SSE prose. |
| Node judge contract | `server/judge/batch-judge-route.ts`, `server/judge/` | Observable rollback/reference behavior for admission, cancellation, events, scoring, checkers, and metadata. |
| Tauri backend selection | `src-tauri/src/backend.rs` | Contains opt-in/default/fallback decisions and embedded-server lifecycle ownership. |
| Rust route surface | `crates/judgedesk-core/src/server/mod.rs` | Large mixed-domain router with status/toolchain/OSD success paths; decompose before broad edits. |
| Rust server startup | `crates/judgedesk-core/src/server/mod.rs::start_embedded_server` | Currently spawns serving work; WP1.1 must make readiness and late failure supervised. |
| Toolchain discovery/resolution | `crates/judgedesk-core/src/toolchains/discovery.rs` | Current PATH/managed/local behavior and direct probes; replace assumptions with exact persisted resolution. |
| Toolchain diagnostics | `crates/judgedesk-core/src/toolchains/diagnostics.rs` | Mixes direct commands and native-executor calls; currently uses `ResourceOnly` for some local runtimes. |
| Compiler/session/runner | `crates/judgedesk-core/src/engine/compiler.rs`, `session.rs`, `runner.rs` | Incomplete compile/judge/checker path, config fallback, direct process execution, score and lifecycle work. |
| Executor protocol/platform | `native-executor/src/` | Existing framed IPC, role validation, Windows LPAC/Job and macOS Seatbelt boundary to preserve or deliberately supersede. |
| Frontend capability consumers | `src/App.tsx`, `src/features/toolchains/`, `src/features/osd/` | Must render truthful unavailable state and retain current workflows/shortcuts. |
| Exact scoring/export reference | `server/judge/scoring.ts`, `src/features/export/score-workbook.ts` | Rational arithmetic and workbook compatibility source of truth. |

Do not mechanically port every direct `Command` occurrence: first classify it as trusted host discovery, protected compiler/runtime/checker execution, or native desktop shell/open behavior. Untrusted execution must cross the selected executor boundary; trusted discovery still needs argument safety, bounds, timeout, and redaction.

### 2.4 Architecture decision that must stand before compiler work

The current code mixes two executor models: `judgedesk-core` links the native-executor crate and calls `Platform` directly, while packaged JudgeDesk still ships the separate `judgedesk-executor` binary used by Node. Do not let both models become production paths accidentally.

**Provisional recommended decision:** keep the native executor out of process and communicate through the existing framed IPC protocol. This preserves process/panic containment, guardian ownership, independent fail-closed termination, and the rollback backend’s established security boundary. Shared Rust crates may hold protocol types and validation logic, but Tauri/core must not call the platform runner directly in production.

WP0.4 must confirm or replace this decision with an ADR covering:

- crash and panic containment;
- guardian/tree-guard ownership and initialization exactly once;
- cancellation, drain, shutdown, and updater handoff;
- executor cache/workspace ownership;
- duplicate initialization and shared-state races;
- binary packaging, architecture/signature, and rollback compatibility;
- attack surface and what happens when core or executor exits unexpectedly.

Whichever path is selected, prove the other path is unreachable in production builds except where the explicit Node rollback mode needs the packaged executor.

---

## 3. Agent operating protocol

### 3.1 Before every work package

1. Read `docs/pure-rust-core-start-here.md`, `docs/verification/pure-rust-core/STATUS.md`, and the latest relevant `WORKLOG.md` entries. Confirm the package is `READY`, dependencies are `DONE`, and no other owner holds it.
2. Claim the package in `STATUS.md` and append the claim to `WORKLOG.md` before editing. Record agent/tool, workspace/branch/HEAD, timestamp, primary/shared files, and report path.
3. Read this plan and the package-specific files listed below.
4. Read the applicable skills from `.agents/skills/`:
   - logic or behavior: `test-driven-development` and `doubt-driven-development`;
   - failures: `debugging-and-error-recovery`;
   - executor, paths, IPC, HTTP boundary, toolchains: `security-and-hardening`;
   - performance/PCH: `performance-optimization`;
   - gates: `constraint-driven-development`;
   - completion: `code-review-and-quality`.
5. Capture `git status --short`, `git rev-parse HEAD`, tool versions, and relevant environment variables. The current working tree is dirty; do not overwrite or normalize unrelated changes.
6. State one reviewable claim for the package. Example: “An invalid `local_path` selection returns an unavailable result and never resolves a PATH compiler.”
7. Write the smallest test that disproves the claim under current code. Run it and preserve the RED output.
8. Implement only enough to make the test pass. Refactor after GREEN.
9. Run an adversarial review of the diff and the package contract before broad gates.
10. When implementation evidence is complete, update the row to `VERIFYING`, append a WORKLOG handoff, and stop. An independent agent moves it to `DONE` or returns it to `IN_PROGRESS`/`BLOCKED`.

### 3.2 Change sizing and sequencing

- Target one behavioral contract per change, normally about 100–300 changed lines plus tests.
- Split files approaching 1,000 lines before adding unrelated responsibilities. `crates/judgedesk-core/src/server/mod.rs` should be decomposed by route/domain rather than growing further.
- Keep refactoring separate from behavior changes when practical.
- Do not implement later packages while the current package has a reproducible failing gate.
- Do not delete apparent dead code without listing it and obtaining the user's direction, as required by the review skill.

### 3.3 Test isolation rules

- Run native-executor, Rust core, desktop, and security gates sequentially when they share `%TEMP%/JudgeDeskExecutor`, AppData, ports, or compiler caches. Parallel runs previously produced an `os error 32` cache-lock failure.
- Give each Node/Rust parity run distinct ports, executor roots, workspaces, preferences, toolchain snapshots, logs, and output directories.
- Never run performance comparisons concurrently. Run alternating sequential trials under comparable idle conditions.
- Destructive or adversarial security fixtures may run only after their sandbox caller path is verified fail-closed. Use dedicated disposable roots and assert they remain inside those roots.
- A timeout in the test harness must terminate descendants and report whether drain succeeded. Do not simply stop awaiting a child.

### 3.4 Status vocabulary

Every test and acceptance item must use exactly one status:

- `PASS`: command or scenario executed and all asserted requirements passed.
- `FAIL`: executed and produced a product or test failure.
- `BLOCKED`: could not execute because of a named external prerequisite; include evidence and a next action.
- `NOT_RUN`: intentionally not executed; include the reason. Inspection is never `PASS`.
- `INCONCLUSIVE`: executed, but environmental interference or incomplete evidence prevents a verdict; include a clean rerun plan.

“Looks correct”, “should pass”, “code inspected”, and “covered elsewhere” are not test results.

For phase aggregation, add `evidenceMode: executed | reference` under the efficient-execution protocol. A reference links the original independent execution ID/verifier/log hash, exact test inventory/assertions and source/environment applicability; it is not a newly executed PASS. Missing or changed evidence requires a rerun. Live phase/security/cleanup/performance/desktop/release scenarios remain fresh executions.

### 3.5 Dependency graph and parallel-work rules

The dependency graph is intentionally stricter than the phase numbering:

```text
WP0.1 baseline
  -> WP0.2 contract matrix -> WP0.3 corpus
  -> WP0.4 executor ADR
  -> WP0.5 gates/skip policy
  -> WP0.6 version/build identity policy
  -> WP0.7 minimal server decomposition

WP0.4 + WP0.7
  -> WP1.1 startup/lifecycle
  -> WP1.2 HTTP authorization
  -> WP1.3 folder picker
  -> WP1.5 capability truthfulness
  -> WP1.6 workspace/path containment
  -> WP1.7 observability

WP0.4 + WP1.6 -> WP1.4 checker containment
WP1.* -> WP2.* -> WP3.* -> WP4.* -> WP5.* -> WP6.*
WP3.* + WP5.* -> WP7.*
WP0.2 + WP0.3 + WP6.* -> WP8.* -> WP9.* -> WP10.*
```

| Work | May run in parallel with | Must serialize with / reason |
|---|---|---|
| Contract fixtures | ADR and CI script design | Frontend contract changes; one canonical fixture owner |
| Windows CI | macOS CI on an isolated source hash | Shared Windows executor/cache/AppData tests |
| Independent language adapters | Documentation and fixture preparation | `registry.rs`, shared compiler/session code, profile fixtures |
| UI scenario authoring | Backend unit tests | Live desktop runs sharing ports/AppData/workspaces |
| Package-store fixture generation | Pure parser tests | Install/uninstall/recovery tests sharing package roots |
| Performance analysis | Documentation | Any build, test, indexer, prewarm, or benchmark using the same host |

Agents editing `crates/judgedesk-core/src/server/mod.rs`, session/job registries, toolchain registry/preferences, executor protocol, or shared golden fixtures must use one owner at a time. Before parallel work starts, assign file ownership and the merge order in the verification report.

### 3.6 Work-package size rule

A work package should end in one reviewable contract and one unambiguous verdict. If implementation exceeds roughly 300 changed production lines, spans more than one trust boundary, or requires unrelated fixtures, split it before coding. The subdivisions below are minimum boundaries; agents may make them smaller, but may not recombine them merely to reduce the number of reports.

### 3.7 Shared progress and handoff ledger

`docs/verification/pure-rust-core/STATUS.md` is the mutable current-state source of truth. `WORKLOG.md` is append-only history. Every Antigravity/Codex conversation must leave these files accurate before it ends, including interrupted or blocked work.

- One owner per work package and one owner for overlapping shared files.
- `DONE` requires the package report, required test/cleanup evidence, and independent verification.
- `SKIPPED` requires an explicit allowance in this plan plus linked evidence; existing partial code is not enough.
- Do not infer ownership or completion from chat history, Git timestamps, or a green aggregate test.
- Independent verification uses a fresh context distinct from the implementer. Implementation may continue in the same accurate session after the previous WP is independently DONE and the next authorized READY WP is separately claimed using a compact handoff. Refresh context at a new phase/trust boundary, ownership transfer, material drift or lost scope. Continue focused debugging in the same WP. See `docs/pure-rust-core-efficient-execution.md`.
- If the source state changes after recorded tests, invalidate and rerun affected evidence before `DONE`.

---

## 4. Verification evidence and output standard

### 4.1 Required work-package report

Each work package must produce a Markdown report under:

```text
docs/verification/pure-rust-core/<work-package-id>-<short-name>.md
```

The report must contain:

Use one canonical report; append attributable implementer/reviewer result sections and link immutable artifacts rather than copying logs into STATUS/WORKLOG. Keep all fields below; documentation-only WPs record non-applicable runtime rows as NOT_RUN with a scope reason. Compact tables may cover multiple independently asserted scenarios without omitting rows.

```markdown
# <WP ID> — <name>

## Scope
- Claim:
- STATUS/WORKLOG claim event:
- Dependencies satisfied:
- User-visible behavior:
- Trust boundaries touched:
- Primary files owned/changed:
- Shared files/fixtures and assigned owner:
- Explicitly out of scope:
- Rollback point and rollback procedure:
- Focused verification command:

## Source identity
- Commit before:
- Commit/diff after:
- Dirty paths before:
- OS / architecture:
- Node / npm / Rust versions:
- Rust core mode and feature flags:

## Contract decisions
| Decision | Node behavior | Rust behavior before | Required behavior | Evidence |
|---|---|---|---|---|

## TDD evidence
### RED
- Test name and command:
- Expected failure:
- Actual failure excerpt:

### GREEN
- Same focused command:
- Result:

### REFACTOR
- Structural change:
- Verification after refactor:

## Automated test results
| ID | Layer | Command | Start/end | Duration | Status | Passed | Failed | Skipped | Log/artifact |
|---|---|---|---|---|---|---:|---:|---:|---|

## Manual / Computer Use results
| Scenario | Backend | Data set | Steps | Expected | Observed | Status | Screenshot/log |
|---|---|---|---|---|---|---|---|

## Cross-platform results
| Scenario | Windows x64 | macOS arm64 | Parity verdict |
|---|---|---|---|

## Security and cleanup
- Processes remaining:
- Ports remaining:
- Temporary roots created/removed:
- External files touched:
- Sandbox/network/path assertions:

## Review
- Correctness:
- Architecture:
- Security:
- Performance:
- Maintainability:
- Adversarial findings and disposition:

## Known limitations
- PASS/FAIL/BLOCKED/NOT_RUN items only.

## Final package verdict
- READY / NOT READY
- Next permitted work package:
- Rollback verified: PASS / FAIL / NOT_RUN with reason
- STATUS/WORKLOG updated and independent verifier assigned:
```

### 4.2 Machine-readable run record

For parity, stress, performance, and release-candidate gates, also emit JSON using this shape:

```json
{
  "schemaVersion": 1,
  "workPackage": "WPx.y",
  "source": {
    "commit": "<40-hex>",
    "dirty": true,
    "sourceArchiveSha256": null
  },
  "host": {
    "os": "windows|macos",
    "version": "...",
    "arch": "x86_64|arm64",
    "hostnameAlias": "local|judgedesk-mac"
  },
  "runtime": {
    "backend": "node|rust",
    "appVersion": "1.5.1",
    "releasedBaseline": "1.5.0",
    "targetRelease": "1.6.0",
    "executorMode": "windows-lpac-job|macos-seatbelt|unavailable",
    "toolchainSnapshot": {}
  },
  "command": ["program", "arg1"],
  "environmentAllowlist": {},
  "startedAt": "ISO-8601",
  "finishedAt": "ISO-8601",
  "durationMs": 0,
  "status": "PASS|FAIL|BLOCKED|NOT_RUN|INCONCLUSIVE",
  "counts": { "passed": 0, "failed": 0, "skipped": 0 },
  "failures": [],
  "artifacts": [
    { "path": "...", "sha256": "...", "bytes": 0 }
  ]
}
```

Do not include secrets, raw private paths in user-facing UI evidence, source submissions in reports, bootstrap tokens, or updater signing keys.

### 4.3 Standard command-output rules

For every command:

- Capture the complete log to a uniquely named file.
- Report the exact command, cwd, environment allowlist, exit code, elapsed time, pass/fail/skip counts, and final 20–50 meaningful lines.
- Hash durable test artifacts and cross-machine source archives with SHA-256.
- If a command is killed by an outer timeout, record `INCONCLUSIVE` unless the test explicitly asserts a product timeout and drain behavior.
- List every skipped/ignored test by name and reason. A green process with new or unexplained skips is not accepted.
- Compare test inventory before/after. Deleted or undiscovered tests block the package.
- Maintain `docs/verification/pure-rust-core/expected-skips.json` with test ID, OS, exact prerequisite, owner, expiry/removal condition, and whether the case belongs to a release-supported profile. A missing compiler/runtime may justify `BLOCKED` during development, but a skipped real-judge test for a release-supported profile blocks release.
- For language diagnostics, emit one independently named result per release profile and selected source mode. An aggregate “toolchains passed” test is supplementary and must not hide an unattempted compiler/runtime.

---

## 5. Phase 0 — freeze the observable contract and reproduce the baseline

### WP0.1 — workspace and environment snapshot

**Goal:** establish a reproducible starting point without altering the dirty tree.

**Why:** later agents must distinguish their changes from existing work and environment-dependent failures.

**Actions:**

1. Record Git HEAD, status, diff summary, untracked files, relevant config hashes, and version lockstep.
2. Record Node/npm/Rust/Tauri versions and Windows/macOS OS/architecture.
3. Inventory active JudgeDesk/Node/executor processes and ports before tests.
4. Record paths and hashes of installed managed-toolchain receipts, without copying large toolchains into the report.
5. On macOS, do not use either dirty checkout directly. Use an isolated checkout at a named commit, or an exact source archive that excludes build outputs and has matching sender/receiver SHA-256.

**Tests:**

```powershell
npm run check:fast
npm run release:check-version
node scripts/run-all-tests.js --dry-run
```

```bash
git status --short
git rev-parse HEAD
cargo --version
node --version
uname -sm
sw_vers
```

**Exit criteria:** source identity and baseline report exist; no user changes were overwritten; test inventory is recorded.

### WP0.2 — API and stream contract inventory

**Goal:** create one executable contract matrix for every `/api/*` endpoint used by the frontend.

**Why:** prose documents and code currently disagree. Byte-compatible migration cannot be verified without a canonical request/response/event inventory.

**Primary references:**

- `src/api.ts` and every `apiFetch` caller.
- `src/features/judging/useJudgeSession.ts` and result reducer.
- `shared/contracts.ts`, `server/types.ts`, toolchain types, OSD types.
- `server.ts`, `server/routes/`, `server/judge/batch-judge-route.ts`.
- `crates/judgedesk-core/src/server/` after decomposition.

**Actions:**

1. Add a deterministic route/caller inventory script that extracts frontend literal `/api/*` callers plus Node and Rust route declarations, emits stable JSON/Markdown, and fails CI when a caller lacks a contract row or a production route is unintentionally added/removed. Dynamic path families require an explicit manifest entry.
2. Enumerate method, path, request headers/body/query, status codes, success/error body, streaming framing, event order, persistence, concurrency gates, and frontend consumer.
3. Capture golden Node responses for success and representative failure cases with volatile fields normalized.
4. Add contract tests that run the same fixture against a backend adapter. Tests must initially fail for incomplete Rust routes.
5. Include shutdown, cancellation, disconnect, malformed JSON, missing paths, Unicode paths, and oversized inputs.

**Output:** `docs/verification/pure-rust-core/api-contract-matrix.md` plus sanitized golden fixtures under a test-owned directory.

**Exit criteria:** every frontend-used endpoint has a contract row and at least one automated assertion; conflicts with docs are listed.

### WP0.3 — corpus and expected-result manifest

**Goal:** define the workloads used for Node/Rust parity.

**Why:** “same results” is meaningless without fixed inputs, expected verdicts, exact scores, toolchain identities, and hashes.

**Corpus requirements:**

- Six languages, supported extensions, file and stdio I/O.
- AC, WA, PE, PARTIAL, CE, RE, TLE, MLE, OLE, JE.
- Custom C++ and Python checkers; testlib exit/message variants.
- Interactive C++ and Python interactors, missing expected output for input-only tasks.
- Rational decimal/fraction points, groups, dependencies, complete-group policy, overflow boundaries.
- Unicode/long names, spaces, case collisions, missing/malformed config, empty folders.
- Security fixtures only after Phase 1 exits.

Create a manifest containing every input file hash and expected canonical output. Do not modify expected results to match a failing Rust implementation; resolve mismatches against the Node contract and product specification.

### WP0.4 — executor architecture ADR

**Goal:** decide and freeze the production boundary between Tauri/core and `judgedesk-executor` before compiler or runner work.

**Recommended starting position:** retain the executor as an out-of-process, framed-IPC service. The ADR may choose a different model only if it provides equally strong evidence for panic/crash containment, guardian ownership, fail-closed termination, cancellation/drain, independent resource limits, and rollback compatibility.

**Required output:** `docs/adr/<next-id>-rust-core-executor-boundary.md` containing:

- selected and rejected models;
- process tree and trust-boundary diagram;
- IPC versioning, framing, authentication/parent identity, maximum frame sizes, and failure semantics;
- exactly-once guardian/tree-guard initialization and ownership;
- startup readiness, cancellation, crash, shutdown, updater handoff, and orphan recovery;
- cache/workspace/package ownership and cleanup;
- release packaging and how the temporary Node rollback path reaches the executor;
- tests proving the unselected production path is unreachable.

**Exit criteria:** ADR accepted, tests name the selected boundary, and Phase 1–5 packages no longer need to guess whether to call `Platform` in process or use the executor protocol.

### WP0.5 — Rust gates, CI, and expected-skip policy

**Goal:** make Rust regressions capable of failing the same required gate that agents and CI use before completion.

**Actions:**

1. Add locked `fmt`, all-target `clippy -D warnings`, core tests, executor tests, and Tauri tests to repository scripts/CI for relevant Windows and macOS jobs.
2. Keep sequential execution where components share executor roots, caches, ports, or AppData.
3. Add explicit source checks or lints for runtime `unwrap()`/`expect()` and floating-point scoring, because clippy alone does not enforce these project rules.
4. Create and validate `expected-skips.json`; fail on new, expired, renamed, or release-blocking skips.
5. Split the current Rust toolchain mega-diagnostic into independently reported tests per release profile so one unavailable runtime cannot short-circuit later checks.

**RED evidence:** demonstrate that an intentionally failing core test, clippy warning, prohibited runtime unwrap, new skip, and missing supported runtime each fail the intended local/CI gate. Revert the intentional faults before GREEN.

### WP0.6 — version, build identity, and lockfile policy

**Goal:** remove ambiguity between the authoritative eight-file application version and the new core crate’s package version.

**Required decision:** preserve the existing eight-file lockstep unless `AGENTS.md` and the checker are deliberately revised as a separate approved policy change. Prefer keeping `judgedesk-core`’s crate version independent while injecting the application version, build commit, target, feature set, and backend identity from Tauri/build environment into `/api/status` and logs. Define which lockfile is authoritative for workspace and packaged builds; never hardcode release metadata inside request handlers.

**Tests:** version mismatch fixtures, dirty/dev build identity, reproducible packaged identity, missing injected metadata failure, and `npm run release:check-version` over the unchanged eight-file contract.

### WP0.7 — minimal Rust server decomposition

**Goal:** create reviewable route/domain boundaries before Phase 1 changes expand `crates/judgedesk-core/src/server/mod.rs`.

Move code without changing behavior into at least `auth`, `lifecycle/status`, `workspace`, `judge`, `toolchains`, and `osd` route modules plus shared response/error helpers. First capture characterization tests, then compare existing tests and route inventory before/after. Only the smallest startup/security fix needed to make extraction safe may share this package; all other behavior changes remain in their dedicated work packages.

**Exit criteria:** no route disappears, behavior/fixtures remain stable, and subsequent packages have a single domain owner instead of repeatedly editing one large module.

---

## 6. Phase 1 — close unsafe paths and misleading backend behavior

### WP1.1 — backend selection must fail explicitly

**Goal:** Node remains default and Rust remains explicit opt-in until cutover, and either backend is reported ready only after it owns a listening socket and a supervised lifecycle.

**Why:** `src-tauri/src/backend.rs` currently falls back to Rust when the sidecar cannot be found or spawned, exposing partial behavior without user intent.

**Required behavior:**

- Normal startup: launch Node and complete its authenticated startup handshake.
- `JUDGEDESK_PURE_RUST_CORE=1`: launch embedded Rust deliberately.
- Node missing/spawn/handshake failure without opt-in: show structured startup failure and do not launch Rust.
- Rust binds the real loopback listener first, preferably on port `0`, and publishes its selected port only after bind and route initialization succeed.
- Tauri retains the server task handle, shutdown sender, terminal error receiver, port, backend identity, and readiness state in managed state. A detached `tokio::spawn` is not ownership.
- Late serve failure/crash is surfaced to the UI/supervisor, not lost after an optimistic startup result.
- Stop waits for admission close, active-run cancellation/drain, server completion, socket release, and state clear in that order. Updater handoff uses the same supervised drain path.
- Cutover logic is implemented only in Phase 10.

**RED tests:** missing sidecar, invalid sidecar, startup timeout, wrong bootstrap frame, occupied requested port, concurrent port race, Rust opt-in, duplicate start, duplicate stop, stop during startup, late server error, backend crash, updater handoff, and restart after confirmed stop.

**Verification:** Tauri focused tests; Windows manual startup cases; process/port cleanup; macOS Tauri tests via SSH. Each case asserts zero orphan process/task, released port, and truthful final state.

**Exit criteria:** no implicit Rust fallback remains; startup error names cause and action; no orphan backend.

### WP1.2 — HTTP origin/authentication boundary and input bounds

**Goal:** match the loopback security boundary of the production backend.

**Why:** Rust currently allows any CORS origin/method/header and exposes filesystem/judge mutations on localhost.

**Required design work:**

1. Separate the **parent startup handshake secret** used to prove the spawned backend belongs to Tauri from the **loopback HTTP authorization credential** used on every protected request. Specify generation entropy, process delivery, storage lifetime, rotation/restart behavior, comparison, and redaction for each.
2. Define an endpoint authorization table. Default all filesystem, toolchain, judge, OSD, archive/export, and lifecycle mutations to protected. List any unauthenticated readiness endpoint with its minimal response and rationale.
3. Define browser delivery. `fetch` may attach an authorization header; browser `EventSource` cannot. Prefer an authenticated streaming `fetch`/reader or another transport that does not put long-lived credentials in URLs, history, referrers, or logs. If a short-lived stream ticket is chosen, make it single-use, narrowly scoped, expiring, and tested.
4. Match the approved desktop origins exactly. Define `Origin: null`, no-Origin native requests, development origins, `OPTIONS`, CSRF-style simple requests, and the precise `401` versus `403` response schema.
5. Reject hostile origins, absent/incorrect/expired credentials, invalid methods, oversized bodies/headers/query/path, malformed JSON, and duplicate/ambiguous authorization headers.
6. Decide whether each difference from Node is required parity or an intentional security correction. Security corrections must be applied to Node and Rust during the rollback window so selecting the backend does not select a weaker boundary.

**Tests:** allowed production/development desktop origins, hostile `http://evil.invalid`, `null`/missing origin policies, preflight allow/deny, CSRF-style form/simple requests, wrong/missing/expired/replayed credential, stream reconnect, ticket reuse where applicable, oversized body/header/query/path, malformed JSON, duplicate auth header, loopback-only binding, IPv4/IPv6 policy, and log redaction.

**Security output:** threat-boundary table and raw HTTP assertions. A CORS header test alone is insufficient; assert that mutations are denied.

### WP1.3 — native folder selection and command-injection removal

**Goal:** eliminate PowerShell string interpolation from `defaultPath`.

**Why:** a filesystem path is untrusted input even when supplied by another local process.

Prefer Tauri’s native dialog command/channel. If a helper process is unavoidable, pass arguments through structured OS APIs and validate/canonicalize the allowed path rather than embedding it in a script.

**RED fixtures:** paths containing `'`, `;`, newline, `$()`, backtick, Unicode, spaces, UNC syntax, nonexistent roots, and excessive length. The test must prove no marker command/file is executed or created.

**Manual test:** native folder dialog opens, respects a safe initial directory, cancel returns the current frontend contract, and focus returns to the app on Windows and macOS.

### WP1.4 — all custom checker execution through native executor

**Goal:** remove direct `std::process::Command` execution of checker binaries/scripts from Rust core.

**Why:** direct execution bypasses filesystem/network/resource/process-tree containment; the current timeout stops waiting but does not prove process death.

**Prerequisite:** WP1.6 has established owned workspaces and race-resistant path handling. Do not run hostile checker fixtures before that boundary exists.

**Required behavior:**

- Compile and execute checker with explicit executor roles and pinned checker toolchain.
- Stage only required input/answer/output/files and problem-local headers.
- Apply role-specific timeout, memory, output, process/thread/open-file/write limits.
- Kill and drain the complete process tree on deadline, cancel, disconnect, or core shutdown.
- Preserve Themis/testlib argv/stdin/message/partial-score semantics.
- Compilation failure returns JE/FAIL according to the canonical Node contract; never choose another checker automatically.

**Tests:** AC/WA/PE/PARTIAL/FAIL, infinite checker, fork/thread child, large output/write, external read, network socket, missing checker, compile error, Unicode message, cancel during checker, Python checker source policy.

**Exit criteria:** repository search finds no production checker execution outside the executor boundary; security tests demonstrate process death and containment.

### WP1.5 — truthful capabilities and unavailable operations

**Goal:** prevent incomplete routes from claiming success and prevent the UI from advertising features that cannot work.

Replace hardcoded `/api/status` capabilities, directory-name toolchain heuristics, in-memory fake install state, fixed-success OSD responses, and similar stubs with one typed capability manifest derived from the selected backend, executor mode, platform, compiled features, and verified runtime state.

Each route declares `available`, a stable unavailable reason/code, and the owning component. An incomplete route returns the canonical unavailable response and performs no mutation. The frontend renders that state and disables or explains the action. A test fails if a route returns success without the expected state transition or durable evidence.

**Tests:** executor unavailable, package service unavailable, OSD unavailable, unsupported language/source/role, missing compiled feature, stale capability cache, backend restart, and UI state for every unavailable reason. Contract tests assert `/api/status` identity/version/capabilities match the actual backend and build metadata from WP0.6.

### WP1.6 — owned workspace and hostile-path lifecycle

**Goal:** establish containment before any real submission, compiler, checker, or interactor execution.

**Required design:**

- Allocate unpredictable workspace IDs beneath a configured canonical root; create an ownership marker containing schema/run identity.
- Open/validate components with no-follow and platform-appropriate reparse-point handling. Require expected file type and ownership; do not rely on one earlier `canonicalize` followed by a later path operation.
- Stage via handles or race-resistant primitives where possible. Revalidate before destructive operations and before passing paths across IPC.
- Reject absolute paths, `..`, alternate streams/device names, link/reparse traversal, unexpected hardlinks, control characters, and platform-confusable/case-collision conditions under the documented policy.
- Use RAII cleanup, but clean only marked, owned roots. Cancellation, crash recovery, and startup scavenging must never recurse through an untrusted link or delete an unrelated directory.

**Tests:** symlink/junction/reparse leaf and ancestor, ancestor swap between validation/use, hardlink fixtures, mount/volume boundary where supported, Windows reserved/ADS paths, Unicode normalization/case collisions, newline/control names, long paths, concurrent cleanup, cancellation at each staging step, core/executor crash, stale owned root, forged/missing ownership marker, and unrelated neighboring data. Destructive fixtures run only inside a disposable test-owned root.

**Exit criteria:** all real-execution packages depend on this workspace API; no route constructs an executable workspace by string concatenation alone.

### WP1.7 — structured observability and redaction

**Goal:** make startup, requests, judge jobs, executor calls, cancellation, drain, and crashes diagnosable without leaking secrets or submissions.

Define structured log events with request/job/run correlation IDs, backend/app/build identity, executor mode, route/result/error code, bounded durations/counts, lifecycle transition, and cancellation/drain reason. Token values, stream tickets, signing material, source contents, answer/output contents, and full unsafe user paths must never appear. Path fields use a safe label or test-owned relative identity.

**Tests:** log capture for Windows development, Windows packaged Rust/Node modes, and packaged macOS paths; deliberate auth failure; compiler/checker error; cancellation; crash; updater drain. Add secret canaries and source/path canaries and fail if raw values occur. Verify log rotation/bounds and that one request/job can be reconstructed by correlation ID.

### Phase 1 gate

Run the required command coverage sequentially. A successful final check:full already executes check:fast and test:server; do not repeat those children on the identical candidate merely because they appear below. Rust/security coverage remains additional, with fmt/all-target clippy also required for touched native/Tauri crates. Fresh integrated sandbox/lifecycle/drain checks and independent phase acceptance remain mandatory.

```powershell
npm run check:fast
cargo fmt --check --manifest-path crates/judgedesk-core/Cargo.toml
cargo clippy --locked --manifest-path crates/judgedesk-core/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path crates/judgedesk-core/Cargo.toml -- --test-threads=1
cargo test --locked --manifest-path native-executor/Cargo.toml -- --test-threads=1
cargo test --locked --manifest-path src-tauri/Cargo.toml
npm run test:security
npm run test:server
```

Phase 1 is not complete if any unsafe route is merely hidden behind the opt-in flag.

---

## 7. Phase 2 — real toolchain state and fail-closed resolution

### WP2.1 — complete domain ownership after the minimal decomposition

**Goal:** extend WP0.7’s reviewable boundaries only where Phase 2 needs new modules; do not perform another whole-server move.

**Suggested boundaries:**

```text
server/
  auth.rs
  status.rs
  workspace_routes.rs
  problem_routes.rs
  judge_routes.rs
  toolchain_routes.rs
  osd_routes.rs
  export_routes.rs
toolchains/
  model.rs
  preferences.rs
  package_store.rs
  resolver.rs
  certification.rs
  diagnostics.rs
engine/
  compiler.rs
  language_adapters/
  session.rs
  runner.rs
```

This package is structural: preserve behavior, run existing tests before/after, and avoid mixing new toolchain semantics into the file move. Skip it when WP0.7 already produced these boundaries; record `NOT_RUN` with that evidence rather than churning files.

### WP2.2 — persistent preference document and execution policy

**Goal:** port revisioned, atomic persistence and recovery behavior.

**Requirements:** schema/version/revision validation; per-profile selections; atomic write; corruption recovery diagnostics; concurrent update conflict handling; no path leakage; parity with Node response fields and status codes.

**Tests:** first run, round-trip, restart, concurrent writes, truncated JSON, invalid mode/path, legacy migration, write/rename failure, revision mismatch, no partial file after crash simulation.

### WP2.3 — package trust, manifest, and receipt model

**Goal:** define verified disk truth before implementing mutation.

Verify signed manifests, manifest schema/version, package/entry size and SHA-256, platform/architecture, provenance, SBOM/license metadata, tool identity, and canonical receipt format. Reject unknown key IDs/algorithms, expired/revoked policy entries where applicable, ambiguous duplicate files, and metadata that is not covered by the signature.

**Tests:** valid fixture, signature/key/hash/size/platform/architecture mismatch, malformed/canonicalization ambiguity, missing provenance/license, duplicate entry, downgrade/rollback policy, and receipt tamper/restart detection.

### WP2.4 — bounded extraction and atomic installation

**Goal:** turn a verified local package into an owned installed tree without exposing a partial destination.

Require preflight quotas, streaming byte/file-count/depth limits, link/traversal/device-file rejection, owned staging from WP1.6, per-package mutation lock, cancellation, executable/permission normalization, post-extract verification, fsync where required, and atomic publish/rollback. Unit tests use signed local fixtures; live download belongs to a separate integration gate and must use the approved network client/pinning policy.

**Tests:** valid install, compressed/expanded size mismatch, zip bomb, traversal, symlink/hardlink/reparse entry, deep/file-count flood, interrupted extraction, destination collision, permission failure, cancellation at each publish phase, active-judge 409, and no partial destination.

### WP2.5 — uninstall, deduplication, and crash recovery

**Goal:** remove only owned packages and recover only owned stale staging.

Handle selected/in-use package refusal, shared-content reference accounting if deduplication is used, idempotent retry, corrupted receipt, partial prior publish, and startup cleanup. Never recursively delete from a path derived only from package metadata.

**Tests:** normal uninstall, selected/in-use 409, duplicate install, concurrent install/uninstall, stale owned staging, forged/missing marker, corrupted receipt, destination replacement race, unrelated package preservation, and cancellation/restart recovery.

### WP2.6 — exact source resolver

**Goal:** make `none`, `managed`, `local_path`, and `local_auto` mutually explicit.

**Required matrix:**

| Selected source | Available | Result |
|---|---:|---|
| none | any | disabled; no fallback |
| managed | yes | exact verified managed package |
| managed | no/invalid | unavailable; no fallback |
| local_path | valid and certified | exact selected path/snapshot |
| local_path | invalid/incompatible | unavailable; no fallback |
| local_auto | certified candidate exists | deterministic chosen candidate |
| local_auto | none certified | unavailable; no managed/system substitution |

Record executable path, runtime path, source root, version, package digest, certificate, snapshot digest, and isolation mode in a pinned immutable session snapshot.

### WP2.7 — macOS compiler-driver and SDK correction

**Goal:** fix the observed Apple Clang diagnostic failure with a focused reproduction.

**Hypotheses to test separately:** selected `clang` versus `clang++`; SDK/sysroot/environment stripped during native execution; local snapshot misses headers/resource directory; source-language override; Xcode developer-root selection.

**Required RED evidence:** reproduce `iostream file not found` with the Rust diagnostic path while host `xcrun clang++` succeeds. Do not fix by copying arbitrary host directories or bypassing Seatbelt.

**Success:** C and C++ diagnostics compile and execute through the production-compatible protected path on Apple Silicon; the selected driver identity is preserved; invalid `clang` for C++ is rejected or mapped only under an explicit tested policy.

### Phase 2 gate

- Restart persistence tests on both OSes.
- Every **release profile × declared source mode** in the versioned profile registry. Do not fabricate four modes for profiles that intentionally support fewer modes; Scratch may be managed-only. Each unsupported combination must be absent or return one stable unavailable reason, never fall back.
- Managed receipt and install security tests.
- macOS core tests and C/C++ diagnostics via SSH against an exact source hash.
- UI Toolchain Manager reflects persisted truth after app restart; it must not show `Submission ready` from directory-name heuristics.
- Dormant or experimental registry entries such as Go, Rust, JavaScript, or C# remain undiscoverable unless a separate product change adds them to release scope with full tests. Record the registry/release-scope revision in every result.

---

## 8. Phase 3 — protected compiler pipeline and six language adapters

### WP3.1 — compiler service contract

**Goal:** one compiler service is used by self-test, submission, checker, and interactor compilation with role-specific policy.

**Baseline limits to preserve unless the product contract is deliberately changed:**

- Submission compile timeout: 15,000 ms.
- Generated submission binary cap: 32 MiB.
- Custom-checker compile timeout: 60,000 ms.
- Checker compiler memory policy: preserve Node’s current explicit value and verify it in tests.

Do not copy the original plan’s obsolete 10-second/50-MB values.

**Required behavior:** async orchestration, pinned executable, minimal environment, protected source/output arguments, no shell, stdout/stderr cap, complete tree kill/drain, output validation, atomic artifact publish, RAII workspace cleanup, structured CE/JE diagnostics.

**Tests:** hung compiler and descendants, template/macro pressure, output oversize, diagnostic flood, missing output, wrong output type, path with space/Unicode, cancellation at spawn/compile/link/publish, crash cleanup.

### WP3.2 — language adapters

Implement one adapter at a time, each with focused RED/GREEN evidence:

1. C++: selected GCC/Clang, flags/profile, static policy by OS, stack flags, later PCH hook.
2. C: C11 profile and `-lm`/platform policy.
3. Python: syntax pre-check and runtime execution; managed submission policy; checker-only local policy.
4. Pascal: compile artifact and strict sandbox support. If the platform executor cannot provide the release isolation contract, mark the affected source/platform unavailable.
5. Java: `javac` output tree, main-class discovery, JVM runtime, thread/process/memory policy, and strict sandbox support. Broad JVM filesystem/network access is not an accepted compatibility shortcut.
6. Scratch: actual `.sb3/.sb2/.sb` compilation/execution path and output contract; no diagnostic-only shortcut.

**Per-adapter tests:** valid program, syntax/compile error, runtime error, stdio, file I/O where supported, Unicode path, source ambiguity, wrong version, selected source unavailable, timeout, memory/output limit, cancellation, metadata identity.

For every release profile × declared source × supported OS × execution role (submission, checker, or interactor where allowed), add hostile probes for network, external read/write, descendant escape, process/thread/open-file limits, and kill/drain. `ResourceOnly` results are reported as `FAIL` for release readiness. If strict isolation cannot be implemented, the combination must be unavailable with a stable reason and the UI must say so.

Do not allow one language failure to skip the remaining matrix. Each adapter diagnostic is a distinct test/result row and the aggregate command reports which profiles were attempted. A supported release profile that is missing its runtime is `BLOCKED` during development and blocks the release gate.

### WP3.3 — session pinning and maintenance gate

Resolve every required submission/checker/interactor toolchain before execution, emit metadata from that immutable snapshot, and block toolchain mutations for the session lifetime. A changed preference during a run must affect only the next run.

**Race tests:** preference change during prewarm/compile/test; uninstall during judge; rescan during judge; cancellation before/after pinning; session cleanup releases the lease exactly once.

### Phase 3 gate

Every release language profile must pass a real batch-judge fixture and produce the expected event/result on each platform where the release claims support. A diagnostic badge is insufficient. The gate includes the hostile role/source matrix above, the expected-skip validator, and an assertion that dormant profiles are not exposed.

---

## 9. Phase 4 — problem configuration, session lifecycle, and stream parity

### WP4.1 — normalized problem configuration

**Goal:** port `resolveProblemConfig` semantics rather than inventing a new precedence.

Cover stored config, request config, defaults, legacy `useStdIO`, split stdin/stdout, memory 8–1024 MiB, time bounds, test scores, Polygon groups, checker, interactor, compile profile, custom flag validation, and persisted compile snapshots.

**Tests:** table-driven Node/Rust normalization on identical JSON, malformed/unknown fields, stored/request conflict, legacy files, fractions, invalid flags, missing config, Unicode filenames.

### WP4.2 — admission, job identity, and registry

**Goal:** accept at most the canonical number of sessions, allocate unique bounded job IDs, and make registration/removal linearizable.

Port the observable behavior of `SingleJudgeSessionGate`, cancel-before-register tombstones, job lookup, and toolchain maintenance lease without yet mixing native drain logic into the registry.

**Race tests:** simultaneous requests, duplicate/invalid/exhausted ID, cancel before register, register versus cancel, second cancel, maintenance versus admission, registry cleanup, and new run after clean removal.

### WP4.3 — cancellation, disconnect, and native drain

**Goal:** every admitted job has one cancellation owner and reaches a terminal drained state.

Define state transitions for preparation, compile, testcase, checker/interactor, stream disconnect, cancel timeout, backend shutdown, crash recovery, and updater handoff. Wire them to the supervised backend lifecycle from WP1.1 and the executor boundary from WP0.4.

**Race tests:** cancel during every phase, disconnect before/after terminal event, shutdown during every phase, repeated cancel, executor refusal/crash, cancellation timeout, drain completion, lease release exactly once, zero descendant/orphan, and new run only after cleanup.

### WP4.4 — event writer and stream contract

**Goal:** match frontend-consumed framing, event names, camelCase fields, order, flush behavior, and terminal semantics.

**Required assertions:**

- Initial progress and metadata order matches the canonical Node contract.
- `problem_completed` merges into the existing reducer without frontend changes.
- Exactly one terminal `done` or `error` policy as defined by Node.
- Malformed/internal errors do not leak private paths or stack traces.
- Slow/disconnected clients do not leave judging work unbounded or orphaned.

Use chunk-boundary tests: multiple events per chunk, event split across chunks, multibyte UTF-8 split, blank lines, final event without extra buffering.

### WP4.5 — run metadata and export compatibility

Emit complete metadata for every required language/toolchain and executor. Feed Rust-produced metadata/results directly into `score-workbook.ts` tests. Verify Excel Summary and Details content and displayed sort order.

### Phase 4 gate

- Node/Rust API golden tests.
- Frontend reducer and export tests with Rust fixtures.
- Cancellation/concurrency stress loops.
- Desktop load → judge → details → rejudge/delete → export smoke on Windows.

---

## 10. Phase 5 — exact scoring, checkers, and interactive execution

### WP5.1 — exact rational model

**Goal:** remove f64 parsing/multiplication and saturating corruption from scoring paths.

Use exact decimal/fraction parsing from strings/JSON lexical form, reduced numerator/denominator representation, checked overflow with explicit JE/config error, exact group/dependency arithmetic, and final presentation conversion only at the boundary required by existing UI contracts.

**Property and table tests:** `1/3 + 2/3`, `0.35 * 10`, negative/zero denominator policy, large numerator/denominator, malformed strings, JSON decimal lexical preservation, partial checker multiplier, group dependencies, permutation invariance, Node/Rust canonical output.

### WP5.2 — standard checker parity

Map every built-in checker identifier and alias: token, line, exact/binary, integer/huge integer, floating tolerance, yes/no, Polygon names, PE distinctions, trailing whitespace/newline, NUL/binary, UTF-8 policy.

Use table/property tests that exercise empty input, very large tokens/integers, signed zero/exponents/NaN/Infinity policy, invalid UTF-8, mixed line endings, embedded NUL, and bounded memory/output. Expected aliases and default checker selection belong in the canonical contract matrix.

### WP5.3 — custom checker parity

Custom-checker tests must cover testlib and Themis layouts, exit codes, stdout/stderr parsing, partial points, invalid scores outside the accepted range, timeout, and sandbox denial.

The existing `result = 2` → `PARTIAL, 2` versus `JE, 0` discrepancy is a product contract decision. Do not bury it inside implementation. Record the selected rule and update checklist/tests together.

This package depends on WP1.4 and reuses the same native-executor path; it must not create a second custom-checker runner.

### WP5.4 — interactive runner

**Goal:** dual protected processes with bounded bidirectional pipes and reliable teardown.

**Tests:** normal exchange, contestant/interactor timeout, either-side crash, pipe close/deadlock, output flood, child process escape, cancel, input-only test, C++/Python interactor, partial/testlib verdict, no expected output, cleanup after each failure.

**Exit criteria:** neither participant can outlive the run; both sides have independent roles/limits; event/result parity is documented.

---

## 11. Phase 6 — remaining production services

### WP6.1a — OSD parser and durable state

Port filename/content parsing, validation, canonical contestant/problem identity, duplicate policy, durable logs/state, and bounded error reporting from Node. Test malformed/Unicode/case-colliding names, duplicates, invalid/oversized content, partial records, restart recovery, and atomic state writes.

### WP6.1b — OSD watcher, debounce, and queue

Port watcher semantics, stable-write/rename detection, debounce, bounded FIFO order, backpressure, and batch-judge conflict gate. Test partial file writes followed by rename, rapid duplicate events, watcher restart/overflow, queue depth limit, concurrent batch start, cancellation, inaccessible watch root, and no lost/duplicated accepted item.

### WP6.1c — OSD status stream and lifecycle

Port start/stop, live status/events, reconnect/replay policy, cancellation, backend shutdown, and cleanup. Test repeated start/stop, disconnect/reconnect, slow consumer, terminal error, shutdown with queued/running item, updater drain, released watcher handles, and truthful unavailable capability.

### WP6.2 — workspace/problem/config routes

Port discovery, natural sort, custom checker/interactor listing, test previews with bounded UTF-8-safe reads, config atomic writes, path validation, and exact error schemas. Test symlinks/reparse points, case behavior, large directories, inaccessible paths, Unicode, and races.

### WP6.3 — archive/export/update/lifecycle touchpoints

Rust core does not need to absorb Tauri-owned responsibilities unnecessarily. Define the ownership boundary explicitly and test the complete frontend flow. Preserve archive traversal/zip-bomb protections, Excel system-open behavior, update handoff, and single-instance lifecycle.

### Phase 6 gate

Every endpoint in the WP0.2 matrix is `PASS` for both backends or has an explicitly approved backend-specific ownership note. No endpoint may remain a fixed success stub.

---

## 12. Phase 7 — Universal PCH and prewarm

### WP7.1 — benchmark before optimization

Measure packaged backend startup, idle memory, judge orchestration overhead, and cold/warm C++ compile time on each supported compiler/OS with PCH disabled. Record compiler path/version/hash, SDK/header identity, flags, source hash, CPU model/core count, RAM, OS/power mode, foreground/background process load, thermal state where available, cache state, and build identity.

Define “idle” as ready with no active/prewarm job and after a fixed quiet interval. Use at least 3 warmups and 20 measured trials per scenario, alternate Node/Rust order for comparisons, and run no build/indexer/antivirus scan or competing test on the host. Report p50, p90, p95, minimum, maximum, failures, and raw samples. Repeat a noisy run; mark it `INCONCLUSIVE` instead of discarding inconvenient samples.

The PRD currently supplies these release targets: total app + backend idle memory `<150 MiB`, per-testcase JudgeDesk orchestration overhead `<50 ms`, and warm PCH C++ compilation `<300 ms`. WP7.1 must define the exact measurement points and a startup target/regression ceiling before optimization. Until reviewers accept that measurement contract, startup claims remain `INCONCLUSIVE`; do not invent a threshold to obtain `PASS`.

### WP7.2 — cache identity and atomic generation

Fingerprint must cover canonical executable identity, executable metadata/hash as practical, compiler version, target, language/standard, complete relevant flags, resource directory/system headers or SDK identity, JudgeDesk PCH schema, and platform architecture.

Use single-flight generation, a private staging directory, bounded compiler policy, validation compile, atomic publish, ownership marker, and stale-cache cleanup limited to owned cache entries.

### WP7.3 — safe consumption and fallback

PCH hit uses the same pinned compiler/profile. A missing/corrupt/incompatible PCH may fall back only to ordinary compilation with that same toolchain. Emit hit/miss/rebuild/bypass diagnostics without exposing private paths.

**Tests:** cold miss, warm hit, concurrent first use, compiler/flags/SDK/header change, corrupt/truncated cache, path with spaces/Unicode, generation timeout, cancellation, restart, permissions, fallback correctness, no cross-profile reuse.

### WP7.4 — background prewarm

Prewarm must be low priority, cancellable, single-flight, blocked appropriately by shutdown/update/toolchain mutation, and unable to delay first judge indefinitely. Foreground judge may join a valid in-flight prewarm or use direct compile under the documented policy.

### Performance acceptance

- Correctness and security gates remain identical with PCH enabled/disabled.
- Warm PCH compile p50 and p95 meet the approved `<300 ms` interpretation on the declared reference fixtures/hardware, or the package is `FAIL` until a documented product requirement change is approved.
- Total packaged app + selected backend idle memory remains `<150 MiB` under the WP7.1 idle definition; report process-tree RSS/working-set methodology per OS.
- JudgeDesk’s own per-testcase overhead remains `<50 ms`, measured separately from contestant execution and checker time.
- Backend startup meets the WP7.1 approved target and does not exceed the accepted regression ceiling relative to the recorded baseline.
- Warm compile improvement reports absolute values, percentage, p50/p90/p95, confidence/noise notes, and PCH hit rate; a single best run is not evidence.
- Benchmark results are reproducible on Windows x64 and macOS arm64.

---

## 13. Phase 8 — automated Node/Rust parity harness

### WP8.1 — isolated sequential harness

Run Node and Rust sequentially against immutable copies of the same corpus. Each backend gets its own:

- port and bootstrap context;
- executor root and workspace root;
- preferences and toolchain snapshot;
- result/log directory;
- cache/PCH directory.

Normalize only explicitly volatile fields: timestamps, job IDs, temp roots, and measured time/memory where tolerances are contractually allowed. Never normalize verdict, score, order, language, compiler source/version, error code, or event type.

### WP8.2 — comparison dimensions

Compare:

- HTTP status/error code/body shape.
- Event sequence and required fields.
- Discovered contestants/problems/tests and order.
- Compile status/error category.
- Every testcase verdict, exact score, checker message category, and execution diagnostic reason.
- Problem totals/status and final rank order.
- Metadata/toolchain identity.
- Persistence effects on disk.
- Cleanup: processes, ports, workspaces, file handles.

Timing/memory comparisons require documented tolerances and raw values. A faster result with a different verdict is a failure.

### WP8.3 — mismatch artifact

For each mismatch emit a minimal diff containing corpus case ID, backend source identity, request, normalized event/result, expected contract, and triage owner. The harness exits nonzero if any non-allowlisted mismatch remains.

**Exit criteria:** 100% semantic parity over the approved corpus on Windows and macOS; zero unexplained mismatch allowlists.

---

## 14. Phase 9 — desktop and UI/UX validation

### 9.1 Windows Computer Use protocol

Launch a clean desktop run with explicit backend selection. Use Computer Use only for JudgeDesk UI actions; do not automate terminals through the UI. After every UI state change, refresh the window state before using element indexes or coordinates.

Before relying on UI evidence, add a dedicated `npm run test:desktop:rust` (or equivalently named documented command) that:

- builds/launches the Rust desktop path without building or starting the Node server/SEA;
- uses an isolated AppData/preferences/workspace/executor/cache root;
- sets explicit Rust backend selection and fails unless `/api/status` reports the expected Rust backend/build identity;
- snapshots process trees and fails if a Node process or Node server sidecar starts;
- cleans ports, processes, and owned roots on success, failure, cancellation, and outer timeout.

Keep separate packaged `Core` and `Full` desktop commands so each distribution’s included toolchains and capability manifest can be verified. Existing `npm run test:desktop` output is insufficient if its setup builds Node or permits ambiguous backend identity.

For each scenario capture:

- backend mode and `/api/status` health;
- exact test data manifest/hash;
- steps and expected state;
- screenshot at the stable final state;
- frontend-visible error text and relevant sanitized backend log;
- cleanup result.

### 9.2 Required desktop matrix

| Area | Required scenarios |
|---|---|
| Startup | cold/warm, Node/Rust explicit modes, backend failure, unavailable executor, second instance, close/crash, no orphan |
| Workspace | empty/missing/Unicode/space paths, 18×5 and 72×20 data, F2/F3/F5, Reload selection and score preservation |
| Scoreboard | resize axes, scrollbar/sticky cells, 3-state sort, ties/unjudged, keyboard, context menu, double-click details, no oscillation |
| Problem config | save/reopen, fractions/groups/dependencies, limits, I/O, checker/interactor, presets/custom flags, invalid values |
| Toolchains | every release profile × declared source mode, unavailable/corrupt/wrong version, dormant-profile hiding, restart persistence, mutation lock, dynamic per-profile self-test metrics/errors |
| Judge | all verdicts, all languages, progress, details, cancel phases, rejudge, delete score, error recovery |
| Archive/export | new/open/save/save-as/dirty prompts, portable archive, Excel order/content, viewer failure |
| OSD | start/stop, file arrival/debounce/queue, duplicate/malformed input, batch conflict, reconnect |
| Presentation | Vietnamese/English, light/dark, tab/focus/Escape, shortcuts, overflow, loading/empty/error, Help |
| Updates | check/error/cancel/handoff, Core/Full messaging; installation only against a packaged test build |

### 9.3 macOS validation over SSH

SSH can verify source identity, compilation, unit/integration/security tests, executor/Seatbelt behavior, process supervisor, packaged checker gates, bundle structure/signature/architecture, logs, and process cleanup.

Use an exact commit or source archive and verify SHA-256 on both ends. Do not overwrite `/Users/mac/Code/judgedesk` or `/Users/mac/Code/judgedesk-source` when dirty. Use an isolated path under `/tmp` or a dedicated worktree.

Minimum SSH coverage after relevant implementation stabilizes (one successful final check:full includes its child checks; add the distinct Rust/platform rows):

```bash
npm run check:full
cargo fmt --check --manifest-path crates/judgedesk-core/Cargo.toml
cargo clippy --locked --manifest-path crates/judgedesk-core/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path crates/judgedesk-core/Cargo.toml -- --test-threads=1
cargo test --locked --manifest-path native-executor/Cargo.toml -- --test-threads=1
cargo test --locked --manifest-path src-tauri/Cargo.toml
npm run test:security
npm run test:macos-process-supervisor
npm run test:macos-packaged-checkers
```

SSH cannot prove visual WKWebView layout, native dialog interaction, keyboard focus, menu behavior, DMG drag/install UX, or animation stability. Mark those `BLOCKED` pending a real macOS GUI session or a human checklist with screenshots/video and app logs. Do not report them as passed by inference from Windows.

Because the current Tailscale Mac has SSH but no remote-control channel, create a release-blocking human-run artifact at `docs/verification/pure-rust-core/macos-gui-checklist.md`. It must contain:

- exact commit/source-archive SHA-256, bundle SHA-256, app version/build/backend identity, macOS/hardware, and isolated data-root identity;
- numbered launch/install/upgrade/rollback, native dialog, keyboard/focus/menu, judging, Toolchain Manager, OSD, archive/export, update, close/reopen, and DMG drag/install steps;
- expected text/state for each step and the precise PASS/FAIL/BLOCKED field the human fills in;
- required screenshot names and one short video for focus/menu/animation-sensitive flows;
- sanitized frontend/backend/executor log paths and a secret/path redaction check;
- cleanup commands/checks for processes, ports, mounts, temporary roots, and restored user data;
- tester name/date and a signed-off final verdict.

Automated SSH/package results may be attached to that artifact, but cannot satisfy GUI rows. Every required GUI row without human evidence remains a release blocker; purely cosmetic exploratory rows may be marked informational only if the checklist identifies them in advance.

### Phase 9 exit criteria

Every matrix row has Windows evidence and an explicit macOS result. All GUI-only macOS items are either genuinely executed or visibly listed as release blockers.

---

## 15. Phase 10 — cutover, rollback, and stabilization

Phase 10 has two separate release milestones. Milestone A makes Rust the default while shipping an explicit Node rollback. Milestone B removes Node only after stabilization. Passing Milestone A does not authorize Node decommission.

### WP10.1 — cutover readiness review

Required inputs:

- All prior phase gates independently DONE and their required reports accepted.
- Zero open Critical/Required review findings.
- Zero unexplained parity mismatches.
- Current Windows/macOS security and package gates.
- Measured resource/boot/compile results.
- Updated architecture/API/user docs.
- Rollback exercise evidence.

### WP10.2 — default backend switch

Only now make Rust the default. Define one explicit emergency rollback flag such as `JUDGEDESK_LEGACY_NODE=1`, with tests for selection, logging, packaging availability, and no ambiguous dual-backend startup.

The fallback flag is temporary product policy, not permission for automatic fallback after a Rust startup failure. A failed default backend must surface a structured error unless the user/admin deliberately selected rollback.

### WP10.3 — final coordinated version bump to v1.6.0

Run this package only after WP10.1 and WP10.2 are DONE and the implementation is otherwise release-candidate complete. Change exactly the eight authoritative version files from the verified source lockstep (`1.5.1` currently) to `1.6.0` in one reviewable change:

1. `package.json`
2. `package-lock.json`
3. `src/version.ts`
4. `src-tauri/Cargo.toml`
5. `src-tauri/Cargo.lock`
6. `src-tauri/tauri.conf.json`
7. `native-executor/Cargo.toml`
8. `native-executor/Cargo.lock`

Do not bump `judgedesk-core` or any ninth file unless WP0.6 has deliberately changed the authoritative policy and its checker. Regenerate lockfiles through the correct package managers rather than hand-editing dependency data. Update release notes/changelog and expected package/update metadata in the same package.

**Required tests:** `npm run release:check-version` must report exactly `1.6.0`; frontend status, Tauri/package metadata, executor identity, Core/Full manifests, clean install, upgrade from released `v1.5.0` and the current source baseline where packaged, and rollback compatibility must all report the intended version. A partial bump is `FAIL` and blocks every later release action.

### WP10.4 — release-candidate gates

Run the complete current repository gates, platform gates, parity corpus, desktop matrix, package builds, artifact integrity/signature/architecture checks, clean install/upgrade/rollback, and anonymous updater/release validation applicable to the release process.

Do not publish, move immutable tags, regenerate updater keys, or clean staging artifacts as part of this implementation plan without a separate explicit release instruction.

### WP10.5 — stabilization window

Keep rollback packaging and diagnostics for the agreed release window. Define its minimum release/time duration and exit owner before cutover. Track Rust-vs-Node issue categories, crash/orphan reports, judge mismatches, unavailable capabilities, security boundary failures, and performance regressions. Exercise rollback from an installed packaged build, including preference/data compatibility in both directions.

### WP10.6 — Node decommission milestone

Start only after the stabilization exit review explicitly approves it. Remove the Node server/SEA and rollback flag plus every distribution/build dependency that existed only for it: sidecar declarations, SEA/postject scripts, Node runtime payloads, permissions/capabilities, package hooks, updater component/size manifests, notices/licenses, process supervision, and stale documentation/tests.

**Required evidence:**

- clean `Core` and `Full` package builds on Windows/macOS contain no Node executable/runtime/server sidecar or Node-server-only artifact;
- package contents, signatures, architecture, notices, update manifests, install/upgrade/uninstall, and bundle-size diffs are recorded;
- repository searches and build graph show no production Node backend entry point;
- TypeScript frontend/build tooling that remains is classified correctly and is not confused with a shipped Node backend;
- full Rust, parity-history regression, desktop, security, and package gates pass without the rollback component;
- rollback after this milestone uses the documented installer/release rollback strategy rather than a hidden automatic backend fallback.

---

## 16. Standard gate ladder

Use the smallest relevant rung during RED/GREEN, preserving CONSTRAINTS' edit/pre-build floor checks. Then run one successful complete gate on the frozen final source per implementer and independent verifier. Failed, interrupted or invalidated runs require reruns; “once” is not a quota. Deduplicate final child commands only when the enclosing command actually executed them successfully. See `docs/pure-rust-core-efficient-execution.md` for evidence references, selection and audit windows.

### Focused loop

```powershell
# Example TypeScript focused test
node scripts/run-all-tests.js --filter=<stable-file-or-suite-pattern> --test-timeout=30000

# Example Rust focused test
cargo test --locked --manifest-path crates/judgedesk-core/Cargo.toml <test_name> -- --exact --nocapture --test-threads=1
```

### Fast edit gate

Preserve the required edit/pre-build types/invariants/version floor checks. Apply equivalent fmt/all-target clippy to each touched Rust runtime crate; examples below use core. Completion children may be deduplicated only after a successful final enclosing command.

```powershell
npm run check:fast
cargo fmt --check --manifest-path crates/judgedesk-core/Cargo.toml
cargo clippy --locked --manifest-path crates/judgedesk-core/Cargo.toml --all-targets -- -D warnings
```

### Component gates

```powershell
cargo test --locked --manifest-path crates/judgedesk-core/Cargo.toml -- --test-threads=1
cargo test --locked --manifest-path native-executor/Cargo.toml -- --test-threads=1
cargo test --locked --manifest-path src-tauri/Cargo.toml
node scripts/run-all-tests.js --test-timeout=30000
```

### Security/platform gates

```powershell
npm run test:security
npm run test:windows-resources
npm run test:windows-single-instance
```

### Package-completion gate

```powershell
npm run check:full
```

At the 2026-09-26 source, `check:full` runs check:fast, test:server, static Themis checker parity and release:check-version. Do not repeat those child commands merely to fill separate report rows; link their successful outputs in the complete gate. It does not replace Rust core fmt/all-target clippy/full locked tests, security/platform gates, strict Node/Rust parity, live DLL oracle where required or desktop verification. Re-read package.json when composition changes. WP0.5 must add a documented Rust gate and make the required CI/package-completion path invoke it. Until then, run applicable explicit Rust commands and never treat check:full alone as completion.

After the scripts exist, the release-candidate ladder also includes the dedicated Rust desktop/backend identity command, packaged Core/Full tests, Node/Rust parity (through Milestone A), and the platform-specific commands from Phase 9. A script name is not evidence: its captured output must show the expected backend/build identity, inventory, skips, and cleanup.

---

## 17. Failure triage protocol

When any gate fails:

1. Stop implementing later features.
2. Preserve full logs, source identity, process list, ports, cache/root identity, and the smallest failing fixture.
3. Classify the failing layer: frontend, API contract, core orchestration, native executor, toolchain, OS policy, test harness, or environmental contention.
4. Reproduce in isolation. If it disappears after serializing tests, mark the original result `INCONCLUSIVE`, not fixed.
5. Write or retain a focused regression test before changing implementation.
6. Fix the root cause, rerun focused RED/GREEN, then the directly affected component gate, then the package gate.
7. Record whether cleanup completed. A passing assertion with an orphan process or locked workspace is still a failure.

Known example: running executor tests and desktop simultaneously can contend on the shared executor cache and yield Windows `os error 32`. The clean diagnostic is to stop only the test processes started by the agent, verify exact process identities, then rerun sequentially. Do not weaken startup cache cleanup to hide contention.

---

## 18. Definition of done

The Pure Rust migration is done only when all statements below have direct evidence:

- Rust is behaviorally compatible with every frontend-used production endpoint.
- All six languages judge real submissions with configured/pinned toolchains on Windows and macOS.
- Submission, checker, interactor, and compiler process trees are contained, bounded, cancellable, drained, and cleaned.
- Toolchain preferences/packages/certificates persist atomically and never silently fallback.
- Config precedence, rational scoring, all checkers, interactors, OSD, export, archives, updates, and lifecycle match the approved contract.
- Node/Rust parity corpus has zero unexplained differences.
- PCH improves measured performance without changing compiler identity or correctness.
- Windows desktop UI/UX matrix passes through Computer Use/manual evidence.
- macOS automated/platform/package gates pass, and GUI-only items have real macOS evidence.
- Full gates contain no new skips, suppressions, stubs, warnings, orphan processes, locked roots, or weakened thresholds.
- Milestone A cutover and explicit Node rollback have both been exercised from packaged builds.
- After the stabilization exit review, Milestone B proves shipped packages contain no Node backend/runtime/SEA/sidecar footprint and still pass clean install/upgrade/uninstall and rollback-at-installer level.
- Documentation describes the final architecture rather than the migration’s intermediate state.

Until Milestone A, keep Node as the default and describe Rust as an opt-in migration backend. Between Milestones A and B, describe Rust as default with a packaged legacy rollback. Call the migration fully decommissioned only after Milestone B.
