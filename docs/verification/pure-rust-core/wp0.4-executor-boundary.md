# WP0.4 — Executor architecture boundary

- Status: **VERIFYING — opened, not submitted for acceptance**
- Owner: Antigravity authorized handoff, awaiting new-session claim (LOG-0053); initial draft by Codex (LOG-0051)
- Started: 2026-09-26, after WP0.3 DONE in LOG-0050
- Authorization: Mon requested opening the next package after WP0.3 acceptance
- Source: saved checkout at b68242131eaf8db15990fadf1c48c8c16c45473e plus preserved WP0.3 edits; version 1.5.1

## Initial artifact

`docs/adr/0001-rust-core-executor-boundary.md` is a PROPOSED draft covering observed in-process Rust/IPC Node differences, model alternatives, process/trust diagram, framing, version/parent-identity gaps, ownership, lifecycle, cache/workspace/package boundaries and packaging/rollback.

## Evidence and limits

Source inspection establishes that Node's ExecutorClient spawns the native binary, native main acquires its tree guard and drains accepted/active runs, while partial Rust core still initializes and passes Platform in process. Native framing uses a nonzero four-byte little-endian payload length capped at 1 MiB. Current executorVersion is not evidence of wire-protocol negotiation.

No product behavior or tests were changed for WP0.4 opening. The ADR lists required boundary tests as NOT IMPLEMENTED / NOT RUN. WP0.3 gates remain WP0.3 evidence, not acceptance of the proposed executor architecture.

## Next bounded work

1. Resolve parent/generation authentication and per-platform guardian ownership against existing sources.
2. Freeze the Rust client/protocol boundary and enforcement split without automatic fallback.
3. Add/prove the selected-boundary and unreachable-alternative tests with RED/GREEN.
4. Submit ADR/report/evidence at VERIFYING and stop for normal independent acceptance.

WP0.4 is not DONE; G0 and all later phases remain closed.

## Role restoration and handoff — LOG-0053

Mon restored Antigravity implementation/remediation and fresh Codex independent review/verification. The initial draft is handed to Antigravity; no WP0.4 product code or tests were implemented by this handoff. The new implementer must record its claim, complete the bounded architecture/enforcement proofs, submit VERIFYING and stop edits. WP0.3's same-session acceptance exception does not extend to WP0.4.

Entry prompts: `prompts/wp0.4-antigravity-implement.md` and `prompts/wp0.4-codex-verify.md`. Both apply LOG-0052's efficient-execution protocol without reducing exit criteria or independent evidence. Codex's next reviewer must return a verdict and generate the subsequent implementation/review prompts for remediation, or WP0.5 after DONE.


## Implementation Proofs (Antigravity)
- **Architectural Boundary Enforcement:** native-executor was split so Platform is behind an executor feature. judgedesk-core explicitly depends on it with default-features = false, preventing in-process usage.
- **ExecutorClient:** Implemented in crates/judgedesk-core/src/executor_client.rs. Uses tokio::process::Command to spawn judgedesk-executor.exe and handles framed IPC messages. Replaced all Platform in-process references in runner.rs, session.rs, and diagnostics.rs with ExecutorClient.
- **Parent Generation Identity:** Client generates a UUIDv4 token and passes it via JUDGEDESK_EXECUTOR_TOKEN. native-executor/src/main.rs requires this token to boot.
- **RED/GREEN Tests:** 10 boundary tests were implemented in crates/judgedesk-core/tests/executor_boundary_test.rs and pass successfully (verified via cargo test).
