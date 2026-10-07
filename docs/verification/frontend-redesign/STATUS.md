# Frontend redesign — Trạng thái tiếp tục

Updated: 2026-10-07 (Asia/Bangkok). Plan: ../../frontend-redesign-plan.md.

## Latest scoped batch — Tests and quick groups

Implemented directly on main in the current dirty checkout (uncommitted), with
user approval and self-review; no new branch/worktree/dependency/version change.
The Tests tab has same-row controls, draft-only range grouping/ungrouping and a
group membership/points editor. Well-formed validation is read-only in Node and
Rust, runs before Save/judging, and preview never writes Config.cfg. Atomic saves
and rational scoring are preserved. See WORKLOG FR-LOG-0008 for file scope and QA.

Current combined checkout gates PASS: check:fast; check:full (9/9 Rust steps,
test:server 815 tests / 805 pass / 0 fail / 10 existing conditional skips, four-tier
67-fixture checker parity, version lockstep1.5.5). No historical exception used.
Native test:desktop already verified draft persistence boundaries, exact group
points after Save/reopen, validation Save blocker, wheel/click/Escape/focus and
light EN/dark VI at normal restored width. Final acceptance PASS for all eight
light/dark × VI/EN × maximized/960x600 combinations on the freshly rebuilt desktop.
Narrow tables scroll deliberately, controls stay on one row and footer stays
reachable. Tab wraps inside Group Edit; background clicks retain input focus;
outside wheel scroll and nested Escape/return focus work. Empty-name ungrouping
of an already ungrouped test is a no-op without error; invalid ranges change
nothing. Preview is left running light/VI, maximized, Tests A_plus_B on the copy.
Native macOS and fault/busy injection remain NOT_RUN. Logs are in ignored artifacts/
tests-config-check-full.log and tests-config-desktop-final.log. The earlier
integration records below remain historical; broader FR4/redesign remains partial.

## Current integration

COMPLETE: main now contains ProblemConfigModal tab redesign and source version
1.5.5. Commit 1 66988969dd3db4d6d8064e02f219d659461a5f18 (UI/tests/docs); Commit 2 70b8411c1bf1149e448bf8d700204bca36f6a0ab
(version authority, derived lock, API goldens). Main fast-forwarded from 23290be.
User explicitly authorized the scoped check:full exception for this integration.
No push, tags, packaging or release activation. Detailed failures and preservation
record: merge-main-155.md. Final completion log edits are local/uncommitted after
these two commits; they are also mirrored to the worktree for recovery.

| Package | Status | Evidence |
|---|---|---|
| Plan/recovery setup | DONE | Plan, STATUS, WORKLOG, BASELINE |
| FR0 baseline audit | DONE (representative) | 33 PNG; AUDIT and manifests; coverage debt tracked |
| FR1 design/skill | DONE (direction) | User selected A; existing behavior overrides mockup |
| FR2 tokens/primitives | TODO | |
| FR3 main light UI | TODO | |
| FR4 config/results light | PARTIAL | Config modal tab batch integrated; child polish/results remain |
| FR5 secondary light | TODO | |
| FR6 dark/parity | TODO (overall) | Config modal light/dark VI/EN checked in this batch |
| FR7 final acceptance | TODO | Wider redesign not complete |

## Active workspace

Original D:\Minh\Code\judgedesk is main at 70b8411c1bf1149e448bf8d700204bca36f6a0ab, source v1.5.5,
with the new modal UI. Five preexisting backend files remain uncommitted and
verified byte-identical to before.json at merge time; prior local VI edits remain
uncommitted. A later independent storage.ts edit was observed and preserved; see
WORKLOG/merge-main-155.md for the exact three-line addition. Do not
include them in later UI commits without explicit scope authorization.

Managed worktree C:\Users\mon\.codex\worktrees\judgedesk-frontend\judgedesk,
branch codex/frontend-redesign, contains the same two commits. This worktree
excludes original backend/VI edits. Generated src-tauri/toolchains/ is untracked
desktop runtime, never source to stage. Final completion docs are mirrored here.

Read docs/problem-config-modal-plan.md, WORKLOG FR-LOG-0006/0007 and
problem-config-modal-implementation.md before resuming. Earlier v1.5.3 isolation
and QA records describe the completed implementation batch before integration;
historical v1.5.1 baseline identity remains in BASELINE.md.

## Verification

- check:fast PASS; quality policy unchanged. release:check-version PASS at 1.5.5.
- UI/version-only official test:server PASS: 780 tests, 770 pass, 0 fail,
  10 existing conditional skips. Combined main with untouched backend edits:
  783 tests, 768 pass, 5 fail, 10 existing skips (toolchain profile/resolver/storage).
- Checker parity PASS: Node/Rust/C++/packaged Windows corpus and manifest hashes.
- check:full on combined candidate FAILED core test harness; 8/9 Rust steps pass.
  Native executor/Tauri fmt, clippy, tests and core fmt/clippy pass. Frozen binary
  identity, stale executor and test-root issues recorded in merge-main-155.md.
  Scoped exception granted by user; no tests skipped/deleted or gate weakened.
- Native desktop QA performed on the earlier v1.5.3 UI batch: invalid compile draft,
  retained editor state, nested Escape/focus, rational save, Light/Dark VI/EN and
  short viewport 960x600. No UI behavior changed during version integration.
  macOS, fault/busy injection and long-name limits remain NOT_RUN.
- Commit scope and preservation checked: 5 backend hashes and all 609 prior VI
  leaf values retained; local VI edits excluded from commit trees.

## Resume action

Choose the next scoped FR4/FR2/FR3 batch after reviewing the integrated modal.
Main now uses the new modal; historical instructions to keep its old frontend
apply only to the earlier isolated implementation. Preserve local backend/VI edits.
The scoped exception ends with this integration; future work follows normal gates.

Earlier preview was left running light/VI Basic A_plus_B on stress-baseline.judgedesk
(9 synthetic contestants / 20 problems, scored results retained). It may still
show the earlier build identity; relaunch test:desktop to test current v1.5.5.
Reacquire and reobserve the native window; never reuse old handles/UI indexes.

Fixtures are copies under D:\Minh\Code\judgedesk-ui-audit\20261003; real contest
folders unchanged. Logs and FR4-modal artifacts are ignored local evidence.
Recovery snapshots: artifacts/merge-155/before.json, before/, merged-vi.json and
pre-fast-forward-candidate/. Preserve needed evidence before archiving worktree.

- Post-merge final observation: storage.ts received an independent local backend
  edit after the merge-time hash verification: getExecutorCacheToolchainsDir now
  honors THEMIS_APP_DATA_DIR before OS defaults (three added lines). This agent did
  not write/stage/restore it; newest contents remain uncommitted and excluded from
  both commits. Other four backend hashes still match before.json. Local evidence:
  artifacts/merge-155/post-merge-external-storage.ts; observed SHA256 c89e5f316d4bd2be424ba75eb9dd0c70a8e5453719fee12cd2c7345414ae63b9.
- Final checks on main PASS: check:fast and release:check-version (1.5.5).
