# N0 continuation and protected-state recovery — 2026-10-02

Planning clarification requested by Mon after the [CLI conversation export](C:/Users/mon/Downloads/JudgeDesk-N0-conversation-2026-10-02.md). The export contains a retained summary rather than every earlier assistant message; missing messages are not reconstructed. This chat inspected local text/source/evidence only. Runtime, SSH, builds, tests and recovery operations are **NOT_RUN**. This clarification gives no acceptance verdict and changes no package dependency, owner or quality floor.

## Findings and current state

The direct N0 dispatch and limited N0 → WP0.6 ordering adoption are already recorded in [STATUS](STATUS.md) and [WORKLOG](WORKLOG.md). No repeated N0 scope approval is needed. N0 remains IN_PROGRESS; WP0.6 remains IN_PROGRESS with source edits suspended; WP5.4 remains NOT_READY. Other roadmap changes remain proposed.

| Item | Evidence and disposition |
|---|---|
| Functional blocker | The [N0 report](n0-native-interactive-baseline.md) records strict pair admission implemented, but Mac still refuses valid interactive execution. Single-run file-backed launcher/controller/guardian support does not implement dual participants, owned pipes, independent accounting or paired terminal drain. This is authorized N0 remediation work. |
| Host acceptance blocker | The first Mac RED changed the real protected executor root. Later private-TMPDIR windows show no additional delta against that mutated state; they do not close the original incident. |
| Plan ambiguity: failure handling | Protected damage prevents VERIFYING. It need not prevent bounded source work or safely isolated focused tests after harness/root preconditions are proved. The plan lacked a concrete recovery path; the procedure below supplies one without waiving preservation. |
| Plan ambiguity: protocol scope | Public framed IPC is fixed. Necessary coordinated private native launch/control/stdio changes are within the named N0 launcher/controller/guardian scope, subject to the boundary below. The export does not explicitly report a protocol dispute; this clarification prevents that possible interpretation. |
| Coordination drift | STATUS's handoff still said audits/tests had not run and the report was pending. Synchronize those fields to the existing report; do not promote the package. |

## Public and private boundary

Keep the accepted Node/core → executor framed-v1 request/response contract, public `RunSpec`/`InteractiveRunSpec`, canonical verdict/exact award carriers and sandbox authority unchanged. Do not introduce public caller-supplied descriptors, new grants, compiler/backend fallbacks or new dependencies.

N0 may evolve the **private** native launcher/controller/guardian representation and transport needed for paired launch and trusted pipe ownership. The existing guardian `/2` framing and single-run launcher model are distinct from public framed-v1 IPC. Any private change requires a reviewed design, coordinated matching executor/helpers, explicit compatibility/mismatch refusal, authenticated run/generation/OS-parent ownership, bounded parsing and correct descriptor lifetime. Preserve the existing single-run path. Do not silently reinterpret old helper messages or accept unauthenticated/stale peers. If the concrete design needs wider public policy, trust authority or dependency changes, prepare that proposal and stop at its actual boundary.

## Harness guard before further stateful work

1. Resolve and pin the original protected asset set **before changing environment variables**. Include ThemisV2 and the original host executor root, their canonical paths, content/type/link/semantic inventory and host process/listener state. Do not assume an App Support executor path is correct: Mac initialization currently uses `std::env::temp_dir()/JudgeDeskExecutor`.
2. Put build outputs, test initialization and executor state in unique verified round-owned roots. Set private `TMPDIR` **before startup** of Node, executor, helpers and inherited children; verify source-selected executor root resolution before launching. Windows equivalents also need audited private roots. A health probe is stateful: initialization/self-test can reset generated directories and copy `security-probe`, so it cannot be the first guard.
3. The existing Mac audit tool supports `JUDGEDESK_AUDIT_EXECUTOR_ROOT`. Pin it to the **original absolute protected root**, independently of private runtime `TMPDIR`; validate every audit includes that same original path. This is an audit-script setting, not a new production configuration knob. A snapshot that follows private TMPDIR alone would stop observing the damaged root.
4. Prove private/protected roots are disjoint, marked and owned, with no linked ancestors or unsafe staging. Inspect the actual harness/environment propagation and use harmless refusal probes only after static/root guards. Serialize shared host state; retain ownership until descendants are drained, even on harness failures. Preserve any new delta immediately.

Once these guards are established, continue authorized N0 source work and bounded isolated RED/GREEN. Keep the original incident open separately. Neither fresh baseline equality nor passing focused tests permits VERIFYING; final acceptance requires the recovery and full successful union below.

## Exact incident evidence

All original artifacts remain immutable in [the remediator round](artifacts/n0/codex-remediator-20261002T061545Z/). The incorrectly guessed initial root snapshot remains historical; recovery uses [the corrected original snapshot](artifacts/n0/codex-remediator-20261002T061545Z/macos-before-corrected.json), captured before the first RED mutation.

- Protected executor root: `/private/var/folders/c4/hbcqsl5x7rsgp_v65_kj4twm0000gn/T/JudgeDeskExecutor`.
- Corrected original: 1,648 files, 156 directories, 9 links; digest `aa865c8fc207ea5c164dca50a57507b4dee9c53bad3bae6df7e3992efa52076e`.
- First RED after-state: 1,650 files; digest `092f8b0f35a6ee8a959bbff29516b40bdd78996d53f51dedfd762414fe5972de`.

The [recorded three-entry delta](artifacts/n0/codex-remediator-20261002T061545Z/macos-after-red-1-executor-delta.json) is:

| Relative path in that protected root | Original → first RED |
|---|---|
| `artifacts/a6b953a87399ebd077f5342ca3bc441455e29f8d710669bc857a7da12b93509b` | Absent → regular file, 37,952 bytes, mode `0500`, SHA256 equal to basename |
| `artifacts/c4fe1cd58ec5a292c863d0cce257a53c714832f482857e1192f14f4361036149` | Absent → regular file, 34,560 bytes, mode `0500`, SHA256 equal to basename |
| `artifacts/security-probe` | 1,467,152 bytes, mode `0500`; SHA256 `abc45f0aa969be2b42e1a4c5f69b1bdc3a23944636f6423594f16cd2a67bd1c0` → `05675e4b38c4646e0185a7ae0ff2b568d10397e203d143612b4dabcf4e37f6e4` |

These are recorded historical facts, not a freshly verified recovery manifest or authorization to write those paths. Re-read the actual current host state before proposing any operation; additional/ambient deltas must be preserved and attributed, not silently reverted.

## Recovery without erasing the failure

1. Preserve original FAIL logs, corrected baseline, all subsequent snapshots and the current incident bytes in verified owned evidence storage outside protected roots. Record their hashes; never overwrite old raw evidence or relabel the failed window PASS.
2. Prepare a **read-only concrete recovery manifest**: exact absolute paths; current and original hashes/types/modes/link and semantic state; attribution; proposed operation per path; trusted restoration input/provenance; no active owner/process/open handle; and no-follow, atomic restoration/rollback design. Check the entire original inventory, not only the three reported paths.
3. Locate trusted original `security-probe` bytes matching the exact original SHA256. A verified pre-incident backup/artifact is sufficient. A reproduction is acceptable only with captured pre-incident source, build recipe/tools and resulting exact hash; the current candidate or an arbitrary rebuild is insufficient. A hash alone cannot recover missing bytes. Do not delete the added artifacts while restoration inputs remain unavailable.
4. **Before protected-path writes**, present the complete manifest and obtain direct human authorization for those exact operations. Ordinary N0 disposable-root cleanup permission and this planning request do not grant protected-root deletion/restoration authority. Continue safe in-scope source work while this decision is pending; do not ask again for the already authorized N0 repair.
5. Execute only the authorized verified transaction, retaining rollback bytes/journal outside protected roots and rechecking ownership/no-link/current-state assumptions immediately before mutation. Do not recursively wipe the protected root, change preferences/toolchains/receipts, or touch unattributed paths. Stop and preserve evidence if assumptions drift.
6. Fully compare restored content/types/links/semantic inventory with the **corrected original pre-RED baseline** and record actual operation results and host cleanup. Incident closure requires verified restoration of attributable damage and explicit disposition of every other delta. Never use the 1,650-file post-mutation baseline to claim original preservation. Original FAIL remains FAIL with a linked recovery closure record.
7. After closure, start a fresh role-owned audit window linked to the incident and recovery. Run the complete required frozen-candidate union and cleanup; the reviewer independently verifies closure and performs its own before/after audit and execution. Restoration is not code acceptance. Unknown ownership, missing original bytes/provenance or unresolved preservation prevents VERIFYING; report the exact unavailable input/decision. A different clean host does not close damage on the original host.

## Ordered next implementation slices

Use the [continuation prompt](prompts/n0-continuation-20261002.md), the existing [remediator contract](prompts/n0-remediator-20261002.md) and [independent reviewer contract](prompts/n0-reviewer-20261002.md). Start with harness guards and the recovery manifest; do not rerun the already preserved AC → JE merely to rediscover the known gap.

1. Inventory current participants/callers and certified role/source pairs; preserve current strict-admission tests. Review a private stdio/pipe plan using trusted native-created handles, bounded handoff and close-on-exec/unused-end closure. Tests precede changed behavior.
2. Implement paired launch/registration and partial-second-start rollback. Both roles enter independently strict zero-network containment and independent limits before admission; outer/participant identities, generation and guardians retain ownership through joint drain. Preserve single-run and Windows behavior.
3. Implement independent time/memory/verdict accounting, piped-byte output limits, backpressure/EOF/pipe failure and cancellation/guardian loss. File-size limits alone cannot account for traffic on pipes. Prove both trees drain on every terminal path and harness failure.
4. Prove harmless denial and partial-start cleanup **through the new production caller** before hostile fixtures; then complete all supported strict pair/refusal and lifecycle/security/verdict/exact-award rows. Run full Windows/Mac and distinct required platform/security checks only on the final frozen candidate with the incident closed, following existing contracts.

An intermediate RED is expected while implementing its authorized behavior. Diagnose and fix within scope; it is not a blanket request for new scope permission. Missing required rows, active descendants, protected damage or an incomplete implementation still prevents VERIFYING. Independent N0 DONE must precede separately dispatched WP0.6 revalidation; no later task starts automatically.

Documentation-only intake, [bounded fresh-context text review](artifacts/plan-conflict-audit-20261002/review.md) and validation are retained in [this planning round](artifacts/plan-conflict-audit-20261002/). They cannot discharge N0 runtime checks.
