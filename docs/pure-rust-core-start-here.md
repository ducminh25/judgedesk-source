# START HERE — Pure Rust Core v1.6.0

This is the small entry point for humans, Antigravity, Codex, and other agents. Do not begin by loading every migration document into one prompt.

## Release state

- Historical released baseline: `v1.5.0`; current verified source lockstep: `1.5.1` (STATUS/LOG-0050).
- Development target: `v1.6.0`.
- Keep the eight authoritative version files at the verified source lockstep (`1.5.1` currently) until WP10.3; do not restore an older prose baseline.
- WP10.3 is the only package allowed to bump all eight files together to `1.6.0`.

## Where the files live

Open Antigravity/Codex at the repository root:

```text
D:\Minh\Code\judgedesk
```

Keep the shared coordination files inside the repository:

| Read order | File | Purpose |
|---:|---|---|
| 1 | `AGENTS.md` | Mandatory project and skill-dispatch rules. |
| 2 | `docs/pure-rust-core-start-here.md` | This compact navigation guide. |
| 3 | `docs/verification/pure-rust-core/STATUS.md` | Current owner, dependency, verdict, and whether a package may be skipped. This is the mutable source of current truth. |
| 4 | `docs/verification/pure-rust-core/WORKLOG.md` | Append-only chronological record of work and evidence. |
| 5 | Current WP section in `docs/pure-rust-core-detailed-implementation-plan.md` | Exact goal, reason, actions, tests, and exit criteria for the package being worked. |
| 6 | Applicable `.agents/skills/*/SKILL.md` files | Required engineering workflow for the current package. |
| 7 | Current code/tests named by the WP | Runtime truth. |

Read these only when needed:

- `docs/pure-rust-core-next-steps-audit.md`: baseline evidence and known gaps.
- `docs/pure-rust-core-migration-plan.md`: original architecture and historical intent.
- `docs/pure-rust-core-antigravity-handoff.md`: CLI flags, full paste-ready prompt, and steering prompts.
- `docs/pure-rust-core-efficient-execution.md`: final gate deduplication, evidence references, audit windows and compact handoffs; WP contracts and exit criteria remain intact.
- `guidelines.md`, `CONSTRAINTS.md`: mandatory architecture and quality contract; every implementing agent must read them before edits even when they are not attached to the prompt.
- PRD/TRD/API/UI documents: read the sections referenced by the current WP, not all documents by default.

Do not copy these files into an Antigravity-private memory folder. Agents must read the repository copies so changes remain reviewable and shared.

If Antigravity works in this exact dirty checkout, it can see untracked files. A new clone, Git worktree, Teamwork workspace, or Mac source archive will not automatically contain uncommitted/untracked documents. Before using one, either commit the coordination documents to the working branch or copy them into the isolated workspace and verify their SHA-256/source identity. Never assume a new worktree inherited the current dirty tree.

## The first action

Open `docs/verification/pure-rust-core/STATUS.md`. Do not replay the historical WP0.1 bootstrap: WP0.1–WP0.3 are DONE and WP0.4 is IN_PROGRESS as of LOG-0051. Resume only the authorized current owner/package, or claim a permitted READY package after dependencies are DONE. A plan-review request does not itself authorize runtime implementation.

Use the compact current-package prompt:

```text
Work from D:\Minh\Code\judgedesk. Read AGENTS.md, guidelines.md, CONSTRAINTS.md, start-here, STATUS/latest relevant WORKLOG and efficient-execution. Confirm ownership and DONE dependencies for <WP_ID>; separately claim it before editing. Execute only its detailed-plan contract using the required skills. Keep the verified source version (currently 1.5.1) until WP10.3. Use focused RED/GREEN and mandatory edit checks, then one successful final completion command union plus required Rust/security/platform evidence. Write the report, set VERIFYING, append handoff evidence and stop for fresh independent review.
```

After Antigravity stops at `VERIFYING`, ask Codex in a separate fresh review conversation to verify the diff/report and update `STATUS.md` to `DONE` or back to `IN_PROGRESS`/`BLOCKED` with findings.

## Conversation lifecycle

### Continue the same conversation when

- the same agent is still implementing or debugging the same WP;
- a focused test failed and the agent is following the recorded hypotheses;
- the reviewer requested fixes within the same package;
- a command timed out and the same evidence package needs a clean rerun;
- the conversation still has an accurate package claim and has not started rereading unchanged files or expanding scope.
- the previous WP is independently DONE and the next authorized READY WP is separately claimed with a compact handoff in the same phase/trust boundary; refresh STATUS, source identity and changed authorities first.

### Start a new conversation when

- switching from implementer to independent verifier;
- moving to a new phase or trust boundary;
- transferring ownership between Antigravity and Codex;
- the agent repeatedly rereads files, loses the package claim, or mixes another WP into the diff;
- resuming after a long interruption with stale identity/context, or after source HEAD/diff changed materially;
- performing the fresh-context adversarial review required by the project skills.

Before ending an unfinished conversation, the current agent must update `STATUS.md` and append a `WORKLOG.md` entry containing the exact state, last command/result, artifacts, blocker, and next action. A new conversation must never reconstruct state from chat history alone.

## Shared ownership protocol

1. Read `STATUS.md` immediately before claiming work.
2. Confirm dependencies are `DONE` and the row is `READY` or explicitly handed off.
3. Change the row to `IN_PROGRESS`, add owner/tool, timestamp, workspace/branch/HEAD, and report path.
4. Append a claim entry to `WORKLOG.md`.
5. Work only inside the named WP. One owner edits shared route/session/registry/golden-fixture files at a time.
6. At implementation completion, write the required report and change status to `VERIFYING`; do not self-mark `DONE` when independent review is required.
7. The verifier checks source identity, diff, tests, skips, cleanup, and report. It then marks `DONE`, `IN_PROGRESS`, or `BLOCKED` and appends its decision.
8. A package may be `SKIPPED` only when the detailed plan explicitly permits it and the verifier links evidence proving the condition. “Code already exists” or “another aggregate test passed” is not sufficient.
9. Update dependency rows from `NOT_READY` to `READY` only after all prerequisite rows are `DONE`.

If two agents claim the same row, both stop edits. The agent with the earlier valid WORKLOG claim retains ownership until handoff; the other may perform read-only review or choose a non-overlapping READY package.

## Status meanings

| Status | Meaning |
|---|---|
| `NOT_READY` | Dependencies or required decisions are incomplete. Do not start. |
| `READY` | Dependencies are complete and no owner currently holds the package. |
| `IN_PROGRESS` | One named owner is implementing/debugging it. |
| `VERIFYING` | Implementation stopped; an independent verifier is checking evidence. |
| `BLOCKED` | A concrete prerequisite/external condition prevents required work; evidence and next action are recorded. |
| `DONE` | Exit criteria passed, report exists, required review is complete, and dependent work may use it. |
| `SKIPPED` | The plan explicitly allowed skipping and linked evidence proves the condition. |
| `SUPERSEDED` | A recorded decision replaced the package; link the decision/report. |

`PASS/FAIL/BLOCKED/NOT_RUN/INCONCLUSIVE` remain the per-test result vocabulary. They are not package workflow states.

## When to add verification

Always add or run:

- the focused RED/GREEN test for changed behavior;
- the component gate directly affected by the change;
- `npm run check:fast` before handing a code package to verification;
- package-specific security, cleanup, and cross-platform checks from the detailed plan;
- a verification report under `docs/verification/pure-rust-core/`.

Add broader verification at these boundaries:

| Trigger | Additional verification |
|---|---|
| Shared API/event/type contract changed | Node/Rust contract fixtures, frontend consumer/reducer tests, malformed/oversized input, error schema. |
| Executor, compiler, runner, checker, interactor, workspace, path, cancellation, or IPC changed | Security tests, hostile fixtures, kill/drain/orphan/port/root cleanup, relevant Windows and macOS automated tests. |
| UI state or workflow changed | Component tests plus Windows Computer Use for the affected scenario. Capture backend identity and stable screenshots. |
| macOS-specific/toolchain/sandbox/package behavior changed | SSH tests against an exact isolated source hash. GUI remains BLOCKED until human macOS evidence exists. |
| Persistence/package/archive/update changed | Restart, corruption, atomicity, interrupted-operation, upgrade/rollback, and unrelated-data preservation tests. |
| A phase is about to close | Phase gate, fresh-context review, inventory/skip comparison, status reconciliation. |
| WP10.3 version bump | All eight files together, `release:check-version` reports `1.6.0`, then full release-candidate gates. |

Do not run `check:full`, desktop matrices or performance suites after every small edit. Preserve CONSTRAINTS' types/invariants/version edit and pre-build checks. Run focused RED/GREEN, then one successful final completion gate per implementer and independent verifier after the diff stabilizes. check:full's successfully executed children discharge duplicate final check:fast/server/static-parity/version commands. Required Rust/security/platform/desktop gates remain separate. Failures, interruptions and relevant source changes require reruns; “once” is not a quota. Phase gates distinguish original independent execution references from fresh integrated/live tests under efficient-execution.

## Recommended division between Antigravity and Codex

- **Antigravity primary:** implement one WP, produce RED/GREEN evidence and report, stop at `VERIFYING`.
- **Codex primary:** fresh-context review, reproduce critical commands, inspect security/contract boundaries, update the verdict.
- Reverse the roles when Codex implements a WP: Antigravity performs the independent review.
- Either agent may run Windows Computer Use or macOS SSH checks when the package requires them, but the report must identify who ran each test and the exact source identity.
- Parallel work is allowed only for rows marked `READY` whose file ownership and test roots do not overlap under Section 3.5 of the detailed plan.

## Minimal prompt for every later WP

```text
Read AGENTS.md, guidelines.md, CONSTRAINTS.md, docs/pure-rust-core-start-here.md, efficient-execution and STATUS/latest relevant WORKLOG. If <WP_ID> is READY and unclaimed with dependencies DONE, claim it in STATUS and WORKLOG. Execute only its detailed-plan contract with required skills, focused tests and edit checks. Preserve unrelated dirty changes and current source version 1.5.1 until WP10.3. Freeze the candidate; run one successful completion union plus required Rust/security/platform checks. Write one report with linked evidence, set VERIFYING, append evidence, and stop for fresh independent review. Begin no next WP before DONE.
```
