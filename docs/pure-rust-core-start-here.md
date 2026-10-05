# Start here — JudgeDesk Rust core

> 2026-10-01/02: **revised roadmap proposed; adoption outstanding. Planning does not authorize implementation.**
> Limited adoption update: Mon directly authorized N0 on 2026-10-02; only N0 → WP0.6 prerequisite ordering is adopted. Other graph changes remain proposed.

The product target is a compatible Rust backend on Windows x64 and Mac arm64, with strict out-of-process execution, all six languages and current UI/API behavior. Node remains default through readiness review; deliberate cutover, packaged explicit rollback and stabilization precede Node decommission.

Current reality: WP0.1–WP0.5 DONE; N0 IN_PROGRESS with strict pair admission implemented but Mac dual launch outstanding; WP0.6 IN_PROGRESS with source edits suspended and no fresh independent acceptance; WP5.4 NOT_READY; all phase gates NOT_READY. Eight application version files are 1.5.1. Keep them there until coordinated WP10.3 → 1.6.0. Historical 1.5.0 evidence stays valid within its original scope; no public 1.5.1 release is inferred.

Read [AGENTS](../AGENTS.md), [guidelines](../guidelines.md), [CONSTRAINTS](../CONSTRAINTS.md), [live STATUS](verification/pure-rust-core/STATUS.md) and latest relevant [WORKLOG](verification/pure-rust-core/WORKLOG.md) first. They supply authority and actual ownership. Then use:

| Document | Purpose |
|---|---|
| [Detailed complete plan](pure-rust-core-detailed-implementation-plan.md) | Every task's aim, dependencies, files, steps, tests, expected results, outputs, command matrix and stop/rollback conditions |
| [Historical plan audit](verification/pure-rust-core/plan-rewrite-audit-20261001.md) | Evidence and proposal at the 2026-10-01 rewrite; later direct authorization is in STATUS/WORKLOG and the continuation clarification |
| [Proposed mapped ledger](verification/pure-rust-core/proposed-ledger-20261001.md) | Every old WP/validation/gate mapped; live verdicts preserved; proposed dependencies have no execution effect yet |
| [Proposed DAG JSON](verification/pure-rust-core/proposed-roadmap-20261001.json) | Exact edges, required upstream artifacts, task contracts and topological schedule |
| [Review workflow](pure-rust-core-review-workflow.md) | Research/remediation/frozen handoff/independent acceptance/retry and reusable neutral prompts |
| [Efficient execution](pure-rust-core-efficient-execution.md) | Successful command union, provenance/invalidation, host audits and serialization |
| [Handoff guide](pure-rust-core-antigravity-handoff.md) | Provider-neutral package handoff and concrete next-step authorization |
| [Architecture overview](pure-rust-core-migration-plan.md) | Product stages and target trust/deployment boundaries |
| [Accepted executor ADR](adr/0001-rust-core-executor-boundary.md) | LOG-0069 accepted decision; earlier chronological proposal/rejection sections remain historical |
| [Current N0 continuation/recovery](verification/pure-rust-core/n0-plan-conflict-resolution-20261002.md) | Limited adoption already recorded, original-root audit pinning, protected incident closure and bounded native transport scope |

The preserved [LOG-0091 continuation](verification/pure-rust-core/artifacts/wp0.6/remediator-log0091-continuation-codex-20261001/remediation.md) is the historical WP0.6 checkpoint: Windows full PASS; Mac full FAIL only on existing `cpp_interactor` AC → JE; fast/floor/nine Rust steps and both-host protected-state/delayed cleanup pass. Mac static parity/version passed separately after its full gate stopped. Older Windows fixture/long compiler path, Unicode extraction and cleanup issues are resolved. The later [N0 report](verification/pure-rust-core/n0-native-interactive-baseline.md) records the admission slice and still-missing dual launch, plus the first Mac RED protected-root incident. Neither historical WP0.6 preservation nor later private-root equality closes that incident.

The directly authorized fix is **N0: Mac native interactive baseline**, independently accepted before separately dispatched WP0.6 revalidation. It repairs the existing Node/native path and does not complete WP5.4's future Rust job/score/event integration. The earlier within-WP0.6 proposal/drafts remain historical unselected alternatives; no reviewer or later-package dispatch is inferred from document existence.

Continue the existing N0 owner using the [continuation prompt](verification/pure-rust-core/prompts/n0-continuation-20261002.md) and [conflict/recovery clarification](verification/pure-rust-core/n0-plan-conflict-resolution-20261002.md). The direct dispatch already lifted the earlier Mac deferral only for N0; do not request that decision or full-roadmap adoption again as a prerequisite. Guard original-root audit/private-harness isolation, prepare exact recovery inputs and continue bounded native source work. Unresolved preservation still blocks VERIFYING; protected writes need authorization of a concrete transaction. After independent N0 DONE, separately authorize WP0.6 revalidation/freeze and fresh independent review; later WP0.7/G0 still need their own authorization.

Work in `D:\Minh\Code\judgedesk`. Preserve the dirty tree; no reset/stash/clean or assumption that a new worktree/clone contains untracked source/docs. Exact transferred archives need complete build/resource closure and literal Unicode filename validation. Keep coordination here in the shared repository.

Today's planning validation is documentation/graph/link/whitespace only. Runtime/build/security/platform checks: **NOT_RUN**.
