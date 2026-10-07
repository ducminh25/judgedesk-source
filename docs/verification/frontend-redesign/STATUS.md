# Frontend redesign — Trạng thái tiếp tục

Updated: 2026-10-07 (Asia/Bangkok). Plan: ../../frontend-redesign-plan.md.

## Current integration notice

User now requested merge into main and source version 1.5.5 (no release work).
Scoped UI/version candidate is present in main working files; Git refs have NOT
advanced and no commit created yet. Existing backend edits and all prior VI values
are preserved. Version/fast/checker-parity gates PASS; full gate blocked by core
test harness (frozen binary identity, stale executor and test-root assumptions).
UI/version-only server suite PASS (770 pass / 0 fail / 10 existing skips). Main's
dirty backend work causes five separate server failures. User explicitly authorized
a scoped check:full exception for two commits (UI/docs, then version), excluding
five backend files and preserving local VI edits. No push/tag/packaging.
Read merge-main-155.md for gate failures and preservation evidence.
The v1.5.3 isolation/verification details below describe the earlier completed batch.

| Package | Status | Evidence |
|---|---|---|
| Plan/recovery setup | DONE | Plan, STATUS, WORKLOG, BASELINE |
| FR0 baseline audit | DONE (representative) | 33 PNG; AUDIT and manifests; coverage debt tracked |
| FR1 design/skill | DONE (direction) | User selected A; existing behavior overrides mockup |
| FR2 tokens/primitives | TODO | |
| FR3 main light UI | TODO | |
| FR4 config/results light | PARTIAL | Config modal tab batch done; child polish/results remain |
| FR5 secondary light | TODO | |
| FR6 dark/parity | TODO (overall) | Config modal light/dark VI/EN checked in this batch |
| FR7 final acceptance | TODO | Wider redesign not complete |

## Active workspace

Production frontend edits live only in managed worktree:
C:\Users\mon\.codex\worktrees\judgedesk-frontend\judgedesk.
Branch codex/frontend-redesign, base 23290be80111dd9ddf2e58f15006e0f076258eff,
source v1.5.3. Original D:\Minh\Code\judgedesk remains main with old frontend and
pre-existing backend/vi.json changes for hotfixes. No commit, merge or release.
Plan/recovery documentation is also updated in original checkout.

Read worktree docs/problem-config-modal-plan.md, WORKLOG FR-LOG-0006 and
worktree docs/verification/frontend-redesign/problem-config-modal-implementation.md
before resuming. Historical v1.5.1 baseline identity remains in BASELINE.md;
it is not the current development build.

## Verification

- check:fast PASS; quality gate unchanged; git diff --check PASS.
- Final test:server: 780 tests, 770 pass, 0 fail, 10 existing conditional skips.
- Focused tests PASS; release:check-version PASS (1.5.3 unchanged).
- test:desktop rebuilt per code batch; final client viewport 960x600, Windows.
- Native invalid draft, nested Escape/focus, exact rational save, confirmation cancel,
  light/dark VI/EN and short viewport verified. Limits in package log: macOS and
  runtime fault/busy injection not covered, not called PASS.
- check:full required before future commit/push; not run in this task.

## Resume action

Review implemented modal visually, then choose next scoped FR4/FR2/FR3 batch.
Do not repeat baseline or merge prematurely. Carry later main hotfixes into UI branch
explicitly; never overwrite dirty backend work in original checkout.

Preview left open: worktree test:desktop, light/VI, Basic config A_plus_B,
9 synthetic contestants / 20 problems from stress-baseline.judgedesk. No pending
saved edits; scored results retained. Reacquire window via sky.list_windows, match
worktree src-tauri/target/debug executable, activate and reobserve. Never reuse old
handles or accessibility indexes.

Fixtures are copies under D:\Minh\Code\judgedesk-ui-audit\20261003; real contest
folders unchanged. Generated src-tauri/toolchains/ is untracked desktop runtime,
not source to stage. Logs and FR4-modal artifacts are local ignored evidence.
Preserve needed evidence separately before archiving worktree.
