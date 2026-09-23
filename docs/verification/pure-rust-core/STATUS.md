# Pure Rust Core v1.6.0 — Shared Status

> **Authoritative current-state ledger:** all agents must read and update this file.
> **Released baseline:** `v1.5.0`
> **Development target:** `v1.6.0`
> **Last reconciled:** 2026-09-23T20:30:00+07:00 by Antigravity (LOG-0046)
> **Observed source:** Windows HEAD `d80f997cdafaf85883e7602de26c32dd355795a1` plus the recorded dirty tree; current macOS saved checkouts are different and dirty, so no macOS source-parity result is implied.

## Current control state

| Field | Value |
|---|---|
| Current implementation package | `WP0.3` — `VERIFYING`, LOG-0045-F1 and F2 remediated, awaiting fresh independent Codex review |
| Next permitted package | None; verify WP0.3 and await independent review; do not start WP0.4 or any later package |
| Current phase | Phase 0 — contract/baseline freeze |
| Package progress | `2 / 51 DONE` |
| Phase gates | `0 / 11 DONE` |
| Version files | Expected to remain synchronized at `1.5.0` until WP10.3 |
| Last required action | Codex independent verification of WP0.3 LOG-0046 remediation |

Existing partial Rust code does not make a work package `DONE`. Only the report, required test evidence, cleanup evidence, and independent verification can do that.

## Planning and coordination artifacts

| Artifact | Status | Owner | Evidence / note |
|---|---|---|---|
| Baseline gap audit | `DONE` | Codex | `docs/pure-rust-core-next-steps-audit.md` |
| Detailed implementation/test plan | `DONE` | Codex | `docs/pure-rust-core-detailed-implementation-plan.md` |
| Antigravity protocol handoff | `DONE` | Codex | `docs/pure-rust-core-antigravity-handoff.md` |
| Verification root and ledger | `DONE` | Codex | `docs/verification/pure-rust-core/STATUS.md`, `WORKLOG.md` |

## Execution ledger

| ID | Work package / gate | Dependencies | Status | Owner / workspace / started | May skip | Report / evidence |
|---|---|---|---|---|---|---|
| WP0.1 | Workspace and environment snapshot | None | `DONE` | Antigravity implementation; Codex independent verification / 2026-09-19T23:26:41+07:00 | NO | `docs/verification/pure-rust-core/wp0.1-workspace-snapshot.md` + `artifacts/wp0.1/` |
| WP0.2 | API and stream contract inventory | WP0.1 | `DONE` | Codex final closure / D:\Minh\Code\judgedesk / 2026-09-21T20:13:16+07:00 | NO | `docs/verification/pure-rust-core/wp0.2-api-stream-contract.md`, `wp0.2-final-closure.md`, `LOG-0032` |
| WP0.3 | Corpus and expected-result manifest | WP0.2 | `VERIFYING` | Antigravity LOG-0046 remediation / D:\Minh\Code\judgedesk / 2026-09-23T20:30:00+07:00 | NO | `docs/verification/pure-rust-core/wp0.3-corpus-expected-results.md`, `LOG-0046` |
| WP0.4 | Executor architecture ADR | WP0.1 | `READY` | - | NO | - |
| WP0.5 | Rust gates, CI, expected-skip policy | WP0.1 | `READY` | - | NO | - |
| WP0.6 | Version/build identity/lockfile policy | WP0.1 | `READY` | - | NO | - |
| WP0.7 | Minimal Rust server decomposition | WP0.1, WP0.2 | `READY` | - | NO | - |
| G0 | Phase 0 exit gate | WP0.1-WP0.7 | `NOT_READY` | - | NO | `phase-0-gate.md` when run |
| WP1.1 | Explicit backend selection and supervised lifecycle | G0 | `NOT_READY` | - | NO | - |
| WP1.2 | HTTP origin/auth/input boundary | G0 | `NOT_READY` | - | NO | - |
| WP1.3 | Native folder selection/injection removal | G0 | `NOT_READY` | - | NO | - |
| WP1.4 | Custom checker through executor | WP0.4, WP1.6 | `NOT_READY` | - | NO | - |
| WP1.5 | Truthful capabilities/unavailable operations | G0 | `NOT_READY` | - | NO | - |
| WP1.6 | Owned workspace/hostile paths | WP0.4, WP0.7 | `NOT_READY` | - | NO | - |
| WP1.7 | Structured observability/redaction | WP0.6, WP0.7 | `NOT_READY` | - | NO | - |
| G1 | Phase 1 exit gate | WP1.1-WP1.7 | `NOT_READY` | - | NO | `phase-1-gate.md` when run |
| WP2.1 | Complete domain ownership | G1, WP0.7 | `NOT_READY` | - | CONDITIONAL | Skip only if WP0.7 already proves all required boundaries |
| WP2.2 | Persistent preferences/execution policy | G1 | `NOT_READY` | - | NO | - |
| WP2.3 | Package trust/manifest/receipt | G1 | `NOT_READY` | - | NO | - |
| WP2.4 | Bounded extraction/atomic install | WP1.6, WP2.3 | `NOT_READY` | - | NO | - |
| WP2.5 | Uninstall/dedup/crash recovery | WP2.3, WP2.4 | `NOT_READY` | - | NO | - |
| WP2.6 | Exact source resolver | WP2.2, WP2.3 | `NOT_READY` | - | NO | - |
| WP2.7 | macOS compiler driver/SDK correction | WP2.6 | `NOT_READY` | - | NO | - |
| G2 | Phase 2 exit gate | WP2.1-WP2.7 | `NOT_READY` | - | NO | `phase-2-gate.md` when run |
| WP3.1 | Compiler service contract | G2, WP0.4, WP1.6 | `NOT_READY` | - | NO | - |
| WP3.2 | Release language adapters | WP3.1, WP2.6, WP2.7 | `NOT_READY` | - | NO | - |
| WP3.3 | Session pinning/maintenance gate | WP3.1, WP2.2, WP2.6 | `NOT_READY` | - | NO | - |
| G3 | Phase 3 exit gate | WP3.1-WP3.3 | `NOT_READY` | - | NO | `phase-3-gate.md` when run |
| WP4.1 | Normalized problem configuration | G3 | `NOT_READY` | - | NO | - |
| WP4.2 | Admission/job identity/registry | G3 | `NOT_READY` | - | NO | - |
| WP4.3 | Cancellation/disconnect/native drain | WP4.2, WP0.4, WP1.1 | `NOT_READY` | - | NO | - |
| WP4.4 | Event writer/stream contract | WP4.2, WP4.3, WP1.2 | `NOT_READY` | - | NO | - |
| WP4.5 | Run metadata/export compatibility | WP4.1, WP4.4 | `NOT_READY` | - | NO | - |
| G4 | Phase 4 exit gate | WP4.1-WP4.5 | `NOT_READY` | - | NO | `phase-4-gate.md` when run |
| WP5.1 | Exact rational model | G4 | `NOT_READY` | - | NO | - |
| WP5.2 | Standard checker parity | G4 | `NOT_READY` | - | NO | - |
| WP5.3 | Custom checker parity | WP1.4, WP5.1 | `NOT_READY` | - | NO | - |
| WP5.4 | Interactive runner | WP3.2, WP4.3, WP5.1 | `NOT_READY` | - | NO | - |
| G5 | Phase 5 exit gate | WP5.1-WP5.4 | `NOT_READY` | - | NO | `phase-5-gate.md` when run |
| WP6.1a | OSD parser/durable state | G5 | `NOT_READY` | - | NO | - |
| WP6.1b | OSD watcher/debounce/queue | WP6.1a, WP4.2, WP4.3 | `NOT_READY` | - | NO | - |
| WP6.1c | OSD status stream/lifecycle | WP6.1b, WP4.4 | `NOT_READY` | - | NO | - |
| WP6.2 | Workspace/problem/config routes | G5, WP1.6 | `NOT_READY` | - | NO | - |
| WP6.3 | Archive/export/update/lifecycle ownership | G5 | `NOT_READY` | - | NO | - |
| G6 | Phase 6 exit gate | WP6.1a-WP6.3 | `NOT_READY` | - | NO | `phase-6-gate.md` when run |
| WP7.1 | Baseline performance benchmark | G6 | `NOT_READY` | - | NO | - |
| WP7.2 | PCH cache identity/atomic generation | WP7.1, WP3.1 | `NOT_READY` | - | NO | - |
| WP7.3 | PCH safe consumption/fallback | WP7.2 | `NOT_READY` | - | NO | - |
| WP7.4 | Background prewarm | WP7.2, WP7.3 | `NOT_READY` | - | NO | - |
| G7 | Phase 7 performance gate | WP7.1-WP7.4 | `NOT_READY` | - | NO | `phase-7-gate.md` when run |
| WP8.1 | Isolated sequential parity harness | G6, WP0.2, WP0.3 | `NOT_READY` | - | NO | - |
| WP8.2 | Parity comparison dimensions | WP8.1 | `NOT_READY` | - | NO | - |
| WP8.3 | Mismatch artifact/failing exit | WP8.2 | `NOT_READY` | - | NO | - |
| G8 | Phase 8 parity gate | WP8.1-WP8.3, G7 | `NOT_READY` | - | NO | `phase-8-gate.md` when run |
| V9.1 | Windows Computer Use protocol/run | G8 | `NOT_READY` | - | NO | `phase-9-windows-ui.md` when run |
| V9.2 | Complete Windows desktop matrix | V9.1 | `NOT_READY` | - | NO | `phase-9-windows-matrix.md` when run |
| V9.3 | macOS automated SSH/platform/package matrix | G8 | `NOT_READY` | - | NO | `phase-9-macos-ssh.md` when run |
| V9.4 | Human macOS GUI checklist/evidence | V9.3 | `NOT_READY` | - | NO | `macos-gui-checklist.md` when run |
| G9 | Phase 9 desktop/platform gate | V9.2, V9.3, V9.4 | `NOT_READY` | - | NO | `phase-9-gate.md` when run |
| WP10.1 | Cutover readiness review | G0-G9 | `NOT_READY` | - | NO | - |
| WP10.2 | Default backend switch | WP10.1 | `NOT_READY` | - | NO | - |
| WP10.3 | Atomic eight-file bump to v1.6.0 | WP10.2 | `NOT_READY` | - | NO | - |
| WP10.4 | Release-candidate gates | WP10.3 | `NOT_READY` | - | NO | - |
| WP10.5 | Stabilization window | WP10.4 | `NOT_READY` | - | NO | - |
| WP10.6 | Node decommission milestone | WP10.5 approval | `NOT_READY` | - | NO | - |
| G10 | Final decommissioned architecture gate | WP10.6 | `NOT_READY` | - | NO | `phase-10-final-gate.md` when run |

## Handoff block

The current owner replaces this block whenever work is handed off. Preserve prior history in WORKLOG.

```yaml
work_package: WP0.3
owner: Antigravity remediation owner
tool: Antigravity
workspace: D:\Minh\Code\judgedesk
branch_or_head: d80f997cdafaf85883e7602de26c32dd355795a1-plus-preserved-dirty-tree
status: IN_PROGRESS
last_command: Codex direct Scratch source-to-runner probe; generator check three times; independent inventory; focused corpus; 17 tamper probes; check:fast; Rust core and Native Executor fmt/clippy/test; test:server; check:full; release:check-version; detailed before/after host snapshots
last_result: LOG-0045 IN_PROGRESS. Full gates and host-state comparison pass. All three Scratch fixtures still select the same generated echo AST rather than their declared source bytes; exact rational overflow boundary is absent and the static validator accepts a rounded unsafe integer.
report: docs/verification/pure-rust-core/wp0.3-corpus-expected-results.md
artifacts:
  - docs/verification/pure-rust-core/artifacts/wp0.3/independent-review-log0045-codex-20260923/before/
  - docs/verification/pure-rust-core/artifacts/wp0.3/independent-review-log0045-codex-20260923/after/
  - docs/verification/pure-rust-core/artifacts/wp0.3/independent-review-log0045-codex-20260923/scratch-source-probe.json
  - docs/verification/pure-rust-core/artifacts/wp0.3/independent-review-log0045-codex-20260923/host-comparison.json
findings:
  - LOG-0045-F1 HIGH: Scratch runner still selects source-independent echo AST for all three declared Scratch fixtures.
  - LOG-0045-F2 MEDIUM: unsafe rational integer rounds silently in static validation and no overflow-boundary workload exists.
blocker: none; findings are actionable in repository
next_action: Antigravity remediates only LOG-0045-F1 and F2, verifies actual Scratch source execution and exact rational boundaries, then resubmits VERIFYING
updated_at: 2026-09-23T13:55:00+07:00
```

