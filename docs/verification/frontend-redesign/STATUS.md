# Frontend redesign — Trạng thái tiếp tục

## Scoped update — 2026-10-24 — Admin announcements

Help–bell–Donate, unread badge, anchored notification panel and article modal are implemented with VI/EN, light/dark, keyboard focus, inert background and narrow viewport handling. Actual Windows WebView2 and Linux WebKitGTK QA each pass eight layout/language/theme combinations using a fixture feed and native binary/PNG IPC. These results do not certify production Pages or macOS/installed-package acceptance. Evidence and current gate status: [announcements STATUS](../admin-announcements/STATUS.md), [self-review](../admin-announcements/REVIEW.md). The broader redesign remains separate.

## Scoped update — 2026-10-22 — Export recovery

Linux export now distinguishes saved workbook files from viewer launch failure,
with a persistent VI/EN message, wrapped saved path and copy-path action.
Packaged AppImage native QA verified English/Vietnamese × light/dark at restored
desktop width, plus maximized English/light; copying/pasting yielded the saved
Book.xlsx location. WSLg is not physical desktop/LibreOffice certification.
Full Windows gates and all nine Linux Rust steps pass; Fedora AppImage portable
stress is 137/137. See FR-LOG-0010 and the Linux incident report for scope,
fault-injection details and remaining baseline prerequisites. This does not close
the broader redesign work.

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

## CE/JE hardening checkpoint — 2026-10-12

PAUSED at the user's request (quota); resume only on explicit instruction. This
is a new scoped batch, not a change to historical acceptance above. Production
CE/JE propagation through shared/compiler/session/scoring, scoreboard, details,
log and workbook is implemented; this batch is NOT accepted yet.

Native normal light/dark × VI/EN observed. Narrow 960x600 client: dark EN/light EN
observed; light VI/dark VI pending. Enter/Escape observed, Tab confinement not
proven. CE/JE before baseline missing. Native macOS NOT_RUN. Evidence directory:
artifacts/ce-je-20261012/ relative to this directory.

Latest full gate failed a stale JE corpus aggregate assertion. The last harness
fix is written and focused scoring passes 14/14; full rerun after that fix is
pending. No skips, deleted tests or weakened thresholds were introduced.
Desktop session 36261 closed normally (exit0, sidecar code0); no JudgeDesk app,
server sidecar or native executor process remains. Preferences left light/EN.
See ../../reports/judgedesk-hardening-progress-2026-10-12.md for resume order,
review findings, runtime uncertainty and preserved fixture paths.

## Resumed hardening — 2026-10-12

Resumed on explicit instruction. Step2 full gate PASS (Rust9/9, server854/864
PASS with10 pre-existing conditional skips, parity67 fixtures, version1.5.5).
Frozen executable and30 source inputs matched again after gate completion.
Light/dark × VI/EN × normal/narrow scoreboard matrix now observed; narrow VI
runtime screenshots added. Preferences restored dark/VI; desktop closed normally.
Tab in details reaches the background checkbox: existing focus-confinement debt,
not accessibility PASS. No comparable CE/JE before baseline or macOS runtime proof.

Step3A in progress: strict-only local C/C++/Python admission, migration/recovery
notice, Themis import without isolation mutation, automatic manager/host refresh.
Focused backend/UI tests PASS; queued-host-refresh failure received a behavioral
RED/GREEN regression test. Native acceptance and full gate for step3 remain pending.
- Final checks on main PASS: check:fast and release:check-version (1.5.5).
# Checkpoint local policy 3A — 2026-10-12

check:fast và check:full PASS (882 tests, 872 pass, 0 fail, 10 waivers cũ;
Rust9/9; parity67; version1.5.5). Host refresh regression4/4 và policy10/10.
Native3A chưa quan sát: Computer Use bị người dùng dừng bằng Escape trước khi
chọn window; không dùng ảnh CE/JE trước đó làm bằng chứng cho notice mới.
3B đang thiết kế, chưa implement. Không tuyên bố xong cả bước3 hoặc roadmap.

## Latest hardening checkpoint — 2026-10-13

Supersedes the native3A NOT_OBSERVED checkpoint, preserving its historical stop.
With renewed Computer Use, notice/auto-refresh observed in all8 light/dark ×
VI/EN × normal/narrow combinations. Both dev apps closed normally; display
preferences restored dark/VI. Manifest: local-policy-3a-native-20261012.md.
Narrow toolbar/table overflow and modal focus limits remain explicit; no full
accessibility/macOS/before-baseline claim. No real contest or compiler settings
changed. 3B logic/focused tests implemented; real in-place toolchains still fail
closed. New full gate running after a standby-related Rust timeout; not yet PASS.

## Final 3B code gate — 2026-10-13

Supersedes only the pending full-gate status above: sequential final check:full
exit0, Rust9/9, server902/912 PASS /0 fail /10 existing skips, corpus25,
parity67 at four tiers, version1.5.5; post-gate30 inputs and executor hash/size
matched. This backend gate does not add a positive native local-compiler UX claim.
Corrected controlled-copy pipeline4/4, original-path pipeline0/4; step3 product
acceptance remains open. See ../../reports/local-probe-windows-read-access-2026-10-13.md.

## Backend/API startup UX checkpoint — 2026-10-14

Step5 backend/session hardening is implemented but not yet accepted. Startup IPC
failure now renders a localized, keyboard-focusable alert with an explicit retry
instead of leaving a blank window; retry never uses a fixed port, missing token or
experimental-backend fallback. Static VI/EN render tests, production frontend
build and check:fast pass. Native light/dark observation and CSP/session runtime
verification require a fresh `test:desktop` session and user-approved Computer
Use; no native screenshot or UX PASS is claimed yet. See WORKLOG FR-LOG-0009 and
../../reports/judgedesk-hardening-progress-2026-10-12.md.

The final sequential repository gate is now PASS: Rust 9/9, server 930 total /
920 pass / 0 fail / 10 registered conditional skips, parity 67/67 at all four
tiers, version 1.5.5. The frozen executor still matches its 964096-byte receipt
and SHA-256. This closes the code gate only; native light/dark VI/EN and actual
CSP/session observation remain NOT_OBSERVED pending explicit Computer Use consent.

## Packaged Ubuntu acceptance — 2026-10-20

Separate acceptance of installed Linux 1.6.0 via Computer Use/WSLg; does not close
the earlier Windows/frontend batch. Result: NOT ACCEPTED for the full requested
release scope. Core judging, interactive, OSD, archive roundtrip and xlsx ordering
observed; Scratch missing, compiler metadata inconsistent, Help stale and narrow/
dark contrast issues recorded. Windows checkout fast/version PASS; server and full
gates FAIL. Both owned Linux sessions ended, final app/executor/bwrap count zero.
Report: ../../reports/judgedesk-ubuntu-uat-1.6.0-2026-10-20.md.
