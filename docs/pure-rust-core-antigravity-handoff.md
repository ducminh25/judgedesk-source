# JudgeDesk Rust core — neutral package handoff guide

> Legacy filename retained for existing links. Revised 2026-10-01; provider/model-neutral.
> **2026-10-17 Adopted Streamlined High-Rigor Workflow (`HEAD = 488703a` + working tree):**
> On 2026-10-17, Mon authorized transitioning the Pure-Rust Core (`v1.6.0`) execution model to **Scoped Re-verification for `N0` (`N0-C10-GATE-R1`)** followed by **4 Macro-Milestones (`M1`: `WP0.6..G5`, `M2`: `WP6.1a..G6`, `M3`: `WP7.1..G8`, `M4`: `V9.1..G10`)** and **JSON-Only Hash Binding** (no hardcoded `(bytes, sha256)` tuples in Markdown prose), as specified in [`docs/pure-rust-core-efficient-execution.md`](pure-rust-core-efficient-execution.md) and [`docs/pure-rust-core-review-workflow.md`](pure-rust-core-review-workflow.md).
> Eight application version files are synchronized at **`1.5.5`** (`npm run release:check-version` PASS); `crates/judgedesk-core/Cargo.toml` remains at **`1.5.1`**; cutover target remains **`1.6.0`** (`WP10.3`). Working-tree Phase A (`Bước 1–5`) implementation and `WP*` mapping are documented in [`docs/reports/pure-rust-core-progress-2026-10-14.md`](reports/pure-rust-core-progress-2026-10-14.md) and [`docs/pure-rust-core-next-steps-audit.md`](pure-rust-core-next-steps-audit.md).

Use [start-here](pure-rust-core-start-here.md), [complete plan](pure-rust-core-detailed-implementation-plan.md), [workflow and reusable prompts](pure-rust-core-review-workflow.md), [efficient execution](pure-rust-core-efficient-execution.md) and [actual STATUS](verification/pure-rust-core/STATUS.md). The live ledger has precedence over old chat recollection or a proposed mapped state.

One bounded task or Macro-Milestone, one primary owner, one fresh independent acceptance role. Antigravity or Codex may act as remediator or reviewer when the human chooses; the contract is not bound to a provider/model. Keep actual executor attribution in reports. Different-model review was declined; do not ask again or invoke another model CLI. The original tool-specific CLI advice is archived in the before-image; this guide does not assert unverified current flags or start a headless campaign.

## Exact next action

Current formal WP ledger (`STATUS.md`): `WP0.1–WP0.5` `DONE`; `N0` (`candidate10`) `IN_PROGRESS`; `WP0.6` `IN_PROGRESS` (source edits suspended during `N0`); `WP5.4` `NOT_READY`; no gate `DONE`. Application source is eight-file `1.5.5` (`crates/judgedesk-core` crate version `1.5.1`). In `candidate10` (`codex-independent-review-20261017T054000Z` + Mac closure `codex-review-closure-20261017T065802Z`), `N0-C09-GATE-R1` (`74/74` focused union, `0` skips) and all prior packet/compiler/OSD/resource/logger items were independently verified, leaving only P2 **`N0-C10-GATE-R1`** (`npm run test:macos-process-supervisor` generation-guard count / prewarm isolation) open before `N0` reaches `DONE`.

Current prepared prompts (file existence alone dispatches none):

- **Streamlined `N0` (`N0-C10-GATE-R1`) Scoped Re-verification prompts (2026-10-17 Adopted Workflow):**
  - [Streamlined N0 Remediator Prompt](verification/pure-rust-core/prompts/n0-streamlined-remediator-20261017.md)
  - [Streamlined N0 Independent Reviewer Prompt](verification/pure-rust-core/prompts/n0-streamlined-reviewer-20261017.md)
- **Full-union `N0` closure prompts preserved from `codex-review-closure-20261017T065802Z`:**
  - [Closure N0 Remediator Prompt](verification/pure-rust-core/artifacts/n0/codex-review-closure-20261017T065802Z/next-remediator-prompt.md)
  - [Closure N0 Independent Reviewer Prompt](verification/pure-rust-core/artifacts/n0/codex-review-closure-20261017T065802Z/next-reviewer-prompt.md)
- **Macro-Milestone 1 (`M1`: `WP0.6` $\rightarrow$ `G5`) prompts (for dispatch after `N0` reaches `DONE`):**
  - [M1 Milestone Remediator Prompt](verification/pure-rust-core/prompts/m1-milestone-remediator-20261017.md)
  - [M1 Milestone Independent Reviewer Prompt](verification/pure-rust-core/prompts/m1-milestone-reviewer-20261017.md)
- Historical initial N0 prompts: [remediator](verification/pure-rust-core/prompts/n0-remediator-20261002.md), [continuation](verification/pure-rust-core/prompts/n0-continuation-20261002.md), [reviewer](verification/pure-rust-core/prompts/n0-reviewer-20261002.md)

After `N0` reaches independent `DONE`, execute and independently verify the remaining roadmap in 4 Macro-Milestones (`M1`: `WP0.6..G5`, `M2`: `WP6.1a..G6`, `M3`: `WP7.1..G8`, `M4`: `V9.1..G10`), with a mandatory 1-to-1 `WP*` Traceability Matrix at each Milestone gate.


## Handoff preparation

1. Refresh HEAD/dirty source, current live states, accepted dependency applicability and exact scope authorization. Do not overwrite dirty/untracked work; worktree/clone does not inherit it automatically.
2. Read relevant actual React/Node/Tauri/Rust callers and scripts; distinguish partial code, shipped Node behavior, accepted foundations and planned integration. Research ownership/claim/matrix/preconditions/cleanup before implementation.
3. Prepare the paired prompts in the same round with neutral role wording. Include all required contracts and hard stop conditions. Reviewer intake has no fabricated candidate hash; fill it only at a real frozen VERIFYING handoff.
4. One owner writes shared route/job/registry/IPC/workspace/golden modules. Other authorized research/review is read-only; same-host stateful runs serialize. Separate hosts use exact-source isolated roots.
5. Preserve version/security/quality authority and immutable failures. Freeze inputs before final union; write compact report/manifests/cleanup and handoff. Prompt preparation never dispatches a chat.
6. Stop edits at VERIFYING. A fresh independent reviewer owns DONE/rejection; rejection returns concrete findings and both next-round prompts. Continue accurate same-package remediation chat; acceptance always starts fresh.

See the workflow's reusable researcher/remediator/reviewer prompts and YAML handoff schema. For a large OS/lifecycle implementation, extract smaller reviewable designs and perform the prescribed fresh-context adversarial review before coding; fail-closed intermediate states are mandatory. Already authorized N0 slices need that design review, not repeated human scope approval. Request a concrete human decision only if the design crosses the authorized boundary.

## Practical steering text

For scope expansion:

```text
Return to the exact authorized <ID> contract. Inventory your attributable expansion
separately from prior dirty changes. Stop dependent work; present the concrete
missing prerequisite and bounded proposal. Do not reset/stash/clean or reverse
another owner's changes.
```

For insufficient evidence:

```text
Do not claim ready for review. List exact selected test/profile/source/role rows,
actual backend/target/features/binary provenance, full children that executed,
required missing checks and native/harness drain/protected-state results.
Execute the smallest missing decisive check within authorized scope, preserve
failure and refreeze if inputs changed; no inferred PASS from another OS/role.
```

For repeated investigation:

```text
Use the recorded claim and immutable evidence already inspected. State the one
remaining uncertainty and the focused observation that can resolve it.
Keep original failures, finish cleanup/audit and report a concrete finding.
Do not repeatedly replay full gates or reopen accepted foundations without drift.
```

For failure:

```text
Classify owning layer across frontend/API/core/Tauri/native/toolchain/harness.
Preserve current source/oracle/logs and full audit window. Form explicit ranked
hypotheses; reproduce with focused production-path RED before edits.
Repair only authorized scope; shared native prerequisite needs a named upstream
authorization. No test filtering/skip/oracle change, fallback or sandbox relaxation.
```

## Completion communication

State package claim, ready-for-review or rejected/not-ready, attributable files, exact executed/reference command coverage and limits, actual source/build identities, protected-state/descendant/port/root cleanup, missing decisions and dependency-derived next eligible task. Never self-DONE. No commit/push/release/publication/chat dispatch follows from handoff.

For this planning assignment, only rewritten docs, mapping/DAG/link/whitespace checks and append-only planning record are authorized. Runtime/build/security/platform tests remain **NOT_RUN**.
