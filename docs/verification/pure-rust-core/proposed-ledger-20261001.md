# Proposed mapped ledger — 2026-10-01

**PROPOSED_NOT_ADOPTED. No live state transition or implementation permission.** This table preserves all 66 historical IDs: 51 implementation WPs, four validation tasks, eleven phase gates. N0 and N1 are two new proposed native packages. The [live ledger](STATUS.md) remains byte-unchanged by this planning task; its WP0.7 READY row does not authorize edits while current scope is stopped. Human adoption must explicitly reconcile dependency columns/ownership/readiness, retain real verdicts/reports and append the decision to WORKLOG.

Read the [complete contracts](../../pure-rust-core-detailed-implementation-plan.md) and [edge artifacts in JSON](proposed-roadmap-20261001.json). “Retained” keeps the required observable outcome; moved/split/consolidated changes scheduling or implementation ownership, never deletes acceptance. Accepted WP0.1–0.5 stay DONE. Every unfinished old row retains its exact live status. Stage numbers are proposed scheduling only, not a new verdict. Old dependencies below remain historical source; proposed dependencies have effect only after adoption.

| Old ID / unchanged required outcome | Live state | Old dependencies | Proposed treatment / stage | Proposed accepted prerequisites |
|---|---|---|---|---|
| WP0.1 — Workspace and environment snapshot | DONE | None | retained; stage 0 | none |
| WP0.2 — API and stream contract inventory | DONE | WP0.1 | retained; stage 0 | WP0.1 |
| WP0.3 — Corpus and expected-result manifest | DONE | WP0.2 | retained; stage 0 | WP0.2 |
| WP0.4 — Executor architecture ADR | DONE | WP0.1 | retained; stage 0 | WP0.1 |
| WP0.5 — Rust gates, CI, expected-skip policy | DONE | WP0.1 | retained; stage 0 | WP0.1 |
| WP0.6 — Version/build identity/lockfile policy | IN_PROGRESS | WP0.1 | retained; new N0 prerequisite; stage 0 | WP0.1, N0 |
| WP0.7 — Minimal Rust server decomposition | READY | WP0.1, WP0.2 | retained; serialized after WP0.6 to remove misleading READY scheduling; stage 0 | WP0.2, WP0.6 |
| G0 — Phase 0 exit gate | NOT_READY | WP0.1-WP0.7 | retained; gate scope/dependencies corrected; stage 0 | WP0.1, WP0.2, WP0.3, WP0.4, WP0.5, N0, WP0.6, WP0.7 |
| WP1.1 — Explicit backend selection and supervised lifecycle | NOT_READY | G0 | retained; stage 1 | G0 |
| WP1.2 — HTTP origin/auth/input boundary | NOT_READY | G0 | retained; stage 1 | G0, WP1.1 |
| WP1.3 — Native folder selection/injection removal | NOT_READY | G0 | retained; stage 1 | WP1.1, WP1.2 |
| WP1.4 — Custom checker through executor | NOT_READY | WP0.4, WP1.6 | moved from G1 after compiler/adapter prerequisites; stage 3 | WP1.6, WP3.1, WP3.2, WP3.3 |
| WP1.5 — Truthful capabilities/unavailable operations | NOT_READY | G0 | retained; stage 1 | WP1.1, WP1.2, WP1.6 |
| WP1.6 — Owned workspace/hostile paths | NOT_READY | WP0.4, WP0.7 | retained; stage 1 | G0 |
| WP1.7 — Structured observability/redaction | NOT_READY | WP0.6, WP0.7 | retained; stage 1 | WP0.6, WP0.7, WP1.1, WP1.2 |
| G1 — Phase 1 exit gate | NOT_READY | WP1.1-WP1.7 | retained; gate scope/dependencies corrected; stage 1 | WP1.1, WP1.2, WP1.3, WP1.5, WP1.6, WP1.7 |
| WP2.1 — Complete domain ownership | NOT_READY | G1, WP0.7 | consolidated implementation with WP0.7; retain distinct evidence closure; stage 2 | G1, WP0.7 |
| WP2.2 — Persistent preferences/execution policy | NOT_READY | G1 | retained; stage 2 | G1, WP2.1 |
| WP2.3 — Package trust/manifest/receipt | NOT_READY | G1 | retained; stage 2 | G1, WP2.1 |
| WP2.4 — Bounded extraction/atomic install | NOT_READY | WP1.6, WP2.3 | retained; stage 2 | WP1.6, WP2.2, WP2.3 |
| WP2.5 — Uninstall/dedup/crash recovery | NOT_READY | WP2.3, WP2.4 | retained; stage 2 | WP2.4 |
| WP2.6 — Exact source resolver | NOT_READY | WP2.2, WP2.3 | retained; stage 2 | WP2.2, WP2.3 |
| WP2.7 — macOS compiler driver/SDK correction | NOT_READY | WP2.6 | retained; stage 2 | WP2.6 |
| G2 — Phase 2 exit gate | NOT_READY | WP2.1-WP2.7 | retained; gate scope/dependencies corrected; stage 2 | WP2.1, WP2.2, WP2.3, WP2.4, WP2.5, WP2.6, WP2.7, WP4.1, WP5.1 |
| WP3.1 — Compiler service contract | NOT_READY | G2, WP0.4, WP1.6 | retained; stage 3 | G2, N1, WP1.6 |
| WP3.2 — Release language adapters | NOT_READY | WP3.1, WP2.6, WP2.7 | split native obligations to N1; G3 component acceptance; stage 3 | WP3.1, WP3.3, WP2.7 |
| WP3.3 — Session pinning/maintenance gate | NOT_READY | WP3.1, WP2.2, WP2.6 | retained; order before adapters/checker callers; stage 3 | WP3.1, WP2.2, WP2.6 |
| G3 — Phase 3 exit gate | NOT_READY | WP3.1-WP3.3 | retained; gate scope/dependencies corrected; stage 3 | N1, WP3.1, WP3.2, WP3.3, WP1.4, WP5.2 |
| WP4.1 — Normalized problem configuration | NOT_READY | G3 | moved before compiler/session; stage 2 | G1, WP5.1 |
| WP4.2 — Admission/job identity/registry | NOT_READY | G3 | retained; stage 4 | G3, WP4.1 |
| WP4.3 — Cancellation/disconnect/native drain | NOT_READY | WP4.2, WP0.4, WP1.1 | retained; stage 4 | WP4.2, WP0.4, WP1.1 |
| WP4.4 — Event writer/stream contract | NOT_READY | WP4.2, WP4.3, WP1.2 | retained; stage 4 | WP4.2, WP4.3, WP1.2 |
| WP4.5 — Run metadata/export compatibility | NOT_READY | WP4.1, WP4.4 | retained; stage 4 | WP4.1, WP4.4, WP3.3, WP5.1 |
| G4 — Phase 4 exit gate | NOT_READY | WP4.1-WP4.5 | retained; gate scope/dependencies corrected; stage 4 | WP4.2, WP4.3, WP4.4, WP4.5 |
| WP5.1 — Exact rational model | NOT_READY | G4 | moved before config/compiler/session; stage 1 | G0, WP0.3 |
| WP5.2 — Standard checker parity | NOT_READY | G4 | moved to early pure contracts; stage 1 | G0, WP5.1 |
| WP5.3 — Custom checker parity | NOT_READY | WP1.4, WP5.1 | retained; stage 5 | WP1.4, WP5.1, G4 |
| WP5.4 — Interactive runner | NOT_READY | WP3.2, WP4.3, WP5.1 | split native baseline to N0; retain complete integration here; stage 5 | N0, WP3.2, WP4.3, WP5.1, G4 |
| G5 — Phase 5 exit gate | NOT_READY | WP5.1-WP5.4 | retained; gate scope/dependencies corrected; stage 5 | WP5.1, WP5.2, WP5.3, WP5.4, G4 |
| WP6.1a — OSD parser/durable state | NOT_READY | G5 | retained; stage 6 | G5 |
| WP6.1b — OSD watcher/debounce/queue | NOT_READY | WP6.1a, WP4.2, WP4.3 | retained; stage 6 | WP6.1a, WP4.2, WP4.3 |
| WP6.1c — OSD status stream/lifecycle | NOT_READY | WP6.1b, WP4.4 | retained; stage 6 | WP6.1b, WP4.4, WP1.1 |
| WP6.2 — Workspace/problem/config routes | NOT_READY | G5, WP1.6 | retained; stage 6 | G5, WP1.6, WP4.1 |
| WP6.3 — Archive/export/update/lifecycle ownership | NOT_READY | G5 | retained; stage 6 | G5, WP4.5, WP1.1, WP1.6 |
| G6 — Phase 6 exit gate | NOT_READY | WP6.1a-WP6.3 | retained; gate scope/dependencies corrected; stage 6 | WP6.1a, WP6.1b, WP6.1c, WP6.2, WP6.3 |
| WP7.1 — Baseline performance benchmark | NOT_READY | G6 | retained; stage 7 | G6 |
| WP7.2 — PCH cache identity/atomic generation | NOT_READY | WP7.1, WP3.1 | retained; stage 7 | WP7.1, WP3.1, WP3.3 |
| WP7.3 — PCH safe consumption/fallback | NOT_READY | WP7.2 | retained; stage 7 | WP7.2 |
| WP7.4 — Background prewarm | NOT_READY | WP7.2, WP7.3 | retained; stage 7 | WP7.2, WP7.3, WP4.3 |
| G7 — Phase 7 performance gate | NOT_READY | WP7.1-WP7.4 | retained; gate scope/dependencies corrected; stage 7 | WP7.1, WP7.2, WP7.3, WP7.4 |
| WP8.1 — Isolated sequential parity harness | NOT_READY | G6, WP0.2, WP0.3 | moved early; completeness acceptance remains G8; stage 1 | G1, WP0.2, WP0.3 |
| WP8.2 — Parity comparison dimensions | NOT_READY | WP8.1 | moved early; stage 1 | WP8.1, WP5.1, WP5.2 |
| WP8.3 — Mismatch artifact/failing exit | NOT_READY | WP8.2 | moved early; live final strict gate at G8; stage 1 | WP8.2 |
| G8 — Phase 8 parity gate | NOT_READY | WP8.1-WP8.3, G7 | retained; gate scope/dependencies corrected; stage 8 | WP8.1, WP8.2, WP8.3, G6, G7 |
| V9.1 — Windows Computer Use protocol/run | NOT_READY | G8 | retained; stage 9 | G8 |
| V9.2 — Complete Windows desktop matrix | NOT_READY | V9.1 | retained; stage 9 | V9.1 |
| V9.3 — macOS automated SSH/platform/package matrix | NOT_READY | G8 | retained; stage 9 | G8 |
| V9.4 — Human macOS GUI checklist/evidence | NOT_READY | V9.3 | retained; stage 9 | V9.3 |
| G9 — Phase 9 desktop/platform gate | NOT_READY | V9.2, V9.3, V9.4 | retained; gate scope/dependencies corrected; stage 9 | V9.2, V9.3, V9.4 |
| WP10.1 — Cutover readiness review | NOT_READY | G0-G9 | retained; stage 10 | G0, G1, G2, G3, G4, G5, G6, G7, G8, G9 |
| WP10.2 — Default backend switch | NOT_READY | WP10.1 | retained; stage 10 | WP10.1 |
| WP10.3 — Atomic eight-file bump to v1.6.0 | NOT_READY | WP10.2 | retained; stage 10 | WP10.2 |
| WP10.4 — Release-candidate gates | NOT_READY | WP10.3 | retained; stage 10 | WP10.3 |
| WP10.5 — Stabilization window | NOT_READY | WP10.4 | retained; stage 10 | WP10.4 |
| WP10.6 — Node decommission milestone | NOT_READY | WP10.5 approval | retained; stage 10 | WP10.5 |
| G10 — Final decommissioned architecture gate | NOT_READY | WP10.6 | retained; gate scope/dependencies corrected; stage 10 | WP10.6 |

| New proposed ID | State/authorization | Why separate / required outcome | Prerequisites |
|---|---|---|---|
| N0 — Mac native interactive baseline prerequisite | PROPOSED_NOT_AUTHORIZED; no owner or READY claim | Accepted preservation, unchanged AC oracle, framed IPC ownership, and gate discipline allow native repair without Rust orchestration prerequisites. | WP0.1, WP0.2, WP0.3, WP0.4, WP0.5 |
| N1 — Native strict runtime/role capability closure | PROPOSED_NOT_AUTHORIZED; no owner or READY claim | Verified source/runtime snapshots and install truth allow native OS capability gaps to be isolated before Rust adapters. | G2 |

## Concrete mapping decisions and preserved obligations

- **WP0.1–WP0.5 retained accepted:** historical reports and evidence directories remain untouched. New intake does not replay foundation work or extend its historical same-session acceptance authority.
- **WP0.6 retained identity:** adds accepted N0 as native regression prerequisite. Repaired LOG-0091 identity remains unaccepted; no DONE from the plan. N0 can consume the current dirty candidate without requiring WP0.6 acceptance or granting it.
- **WP0.7 retained decomposition:** placed after identity acceptance, addressing its misleading live READY scheduling. **WP2.1 implementation consolidated** into that extraction; its later distinct domain evidence/delta review is still required. If no additional code is needed, an independent evidence closure replaces repeated file moves, not an inferred SKIPPED state.
- **WP1.4 moved** after compiler/adapters/leases; G1 instead requires truthful denial/no reachable unsafe checker/compiler route. Containment component acceptance at G3 and full semantic acceptance at WP5.3/G5 remain distinct.
- **WP5.1 and WP5.2 moved early:** exact lexical carriers/checker goldens precede config/compiler/session score consumers. G5 retains fresh integrated exact award/group/rank and checker acceptance.
- **WP4.1 moved early:** real normalized config/compile profile precedes preparation/execution; no requirement to pass a future session.
- **WP3.2 split:** native strict runtime/role capability obligation becomes N1, core adapters remain WP3.2. All six languages and declared supported roles/sources/platforms remain required; ResourceOnly or a missing runtime cannot silently reduce release scope.
- **WP3.3 remains pinning** but executes before adapters/checker callers, then actual job integration is tested again at WP4.2/4.3/G4.
- **WP5.4 split:** existing Mac Node/native interactive baseline becomes N0; complete Rust orchestration/job-cancellation/event/exact-score integration remains WP5.4 with accepted N0 dependency. Single native AC or safety result grants no full WP5.4 credit.
- **WP8.1–WP8.3 moved early:** independently accept harness isolation/comparison/mismatch detection; observed unfinished Rust semantic differences remain FAIL. Full 100% supported Node/Rust product parity is G8 after G6/G7, with no temporary blanket allowlist.
- **G0–G10 all retained:** G1 is shell/HTTP/path safety with incomplete execution unavailable; G2 durable source/config semantics; G3 protected components; G4 real six-language batch/streams; G5 complete semantics; G6 every product service; G7 measured budgets; G8 complete parity; G9 actual desktop/Mac GUI; G10 decommissioned artifact/product architecture. Each keeps independent gate verdict and current-source integrated evidence.
- **V9.1–V9.4 and WP10.1–WP10.6 retained:** real Rust launch, Windows matrix, live Mac platform and actual Mac GUI, explicit cutover, coordinated versions, actual RC/signatures/install/update, stabilization and separately authorized decommission. No early publication or automatic rollout.

No ID/evidence is discarded or silently renumbered. Historical source/accepted result links stay in STATUS/canonical reports; the exact old ledger rows/owners/report text are preserved in [before-ledger.json](artifacts/plan-rewrite-20261001/before-ledger.json) and [before-STATUS](artifacts/plan-rewrite-20261001/before-STATUS.md). Full old planning documents have before-images in the same planning artifact directory.

Runtime/build/security/platform verification for this mapping is **NOT_RUN**. Graph/mapping/reference validation is recorded in the plan-audit report. Adoption/ordering/N0 implementation remains outstanding.
