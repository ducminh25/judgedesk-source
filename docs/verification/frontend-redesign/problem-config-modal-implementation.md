# FR4 — ProblemConfigModal tab batch

Completed 2026-10-07. Branch codex/frontend-redesign, base 23290be, v1.5.3.
Scope: modal layout/navigation/chrome, VI/EN keys, focused tests and keyboard owner
fixes. Existing child editors, backend/API and save payload reused. No new packages,
version change, commit, merge or release. Original main remains the hotfix checkout.

## Delivered behavior

- Three mounted horizontal panels: Basic, Testcases & groups, Compilation. CSS
  hidden switches visibility; compile validation and invalid local draft remain.
- Summary preserves zero and rational strings, distinguishes all five I/O modes
  and loading/error labels. Helper tests cover those boundaries.
- Footer keeps save errors and compile blocker/recovery visible across tabs.
- Roving tab focus, Left/Right wrap, Home/End, modal focus trap, nested Escape order
  and focus return. Help opened above config retains keyboard ownership.
- Restrained green primary, dark emerald, crisp borders, no backdrop blur. Parent
  viewport bound and scroll body keep footer usable at client 960x600.

## Automated evidence

| Check | Result |
|---|---|
| RED navigation/summary before implementation | Missing module failed before implementation |
| Focused modal/editor/compile batch | 21/21 PASS |
| Focused modal/navigation/confirmation/shortcuts batch | 34/34 PASS |
| Final npm run check:fast | PASS, unchanged architecture/quality gate |
| Final npm run test:server | 780 tests, 770 pass, 0 fail, 10 existing conditional skips; exit 0 |
| npm run test:server -- --filter=api-contracts | 48/48 PASS; exit 0 |
| npm run release:check-version | PASS, all versions 1.5.3 |
| git diff --check | PASS |
| check:full | NOT_RUN; required before future commit/push |

Final server log: `server-modal-accepted-20261007.log` (435884 ms).
Earlier full recheck hit a 5s toolchain-diagnose transport timeout during concurrent
desktop Rust compilation. No timeout or test was weakened. A direct-node diagnostic
rerun then lacked npm_package_version and normalized development version to 1.5.0,
causing unrelated golden version mismatch. Official npm filtered/full commands
passed with desktop compilation idle. Both failed logs retained for diagnosis:
server-modal-final-20261007.log and api-contracts-recheck-20261007.log.
SSR establishes markup/mount structure, not draft persistence or native focus.

## Native Computer Use evidence

Restarted `npm run test:desktop` after code batches (DISABLE_HMR / no-watch).
Final small launch adds only local generated config via:
`npm run test:desktop -- --config docs/verification/frontend-redesign/artifacts/FR4-modal/desktop-small.json`.
No tracked Tauri window configuration changed. Final build identity:
v1.5.3 / 23290be80111 / local, builtAt 2026-10-07T06:03:21.404Z.
Executable: worktree src-tauri/target/debug/themis-v2.exe; backend ready 2060 ms.

| Interaction | Observed result |
|---|---|
| Custom C++ `-O2 -o submission.exe` then Basic/Tests | Save blocked; footer recovery present outside Compilation |
| Recovery action then Compilation | Original draft/error retained; invalid field focused; repair `-O2` re-enabled Save |
| Select testcase / show content / groups then change tabs | Selection and controls retained on return |
| Arrow wrap / End / Tab | Correct activation/focus; Tab enters visible panel |
| Popup Escape | Popup only closes; config retained; testcase Points regains focus |
| Help over popup, Tab then Escape | Focus stays in Help; Help only closes, then popup only closes |
| Scored-result Save request | Existing warning appears; Cancel focus/wrap work; Save-and-clear not executed |
| Help over confirmation, successive Escape | Help only closes, then confirmation only closes; Save regains focus |
| Main Shift+Tab at first control | Wrap to Save; hidden panels excluded |
| Main close | Scoreboard A_plus_B trigger regains focus (menu opener unmounted) |
| Total score `100/3` save on zero-result fixture copy | Config.cfg stores `100/3`, testcase scores `20/3`; checker/groups/I/O kept; copy restored from backup |
| Light/Dark × VI/EN | Basic parity at normal and 960x600; representative Tests/Compilation/focus captures |
| 960x600 Tests + groups / Compilation | Body scroll works and footer stays visible |

Fixtures: copied stress tests and synthetic contestants only. Final preview loads
stress-baseline.judgedesk, 9 contestants / 20 problems, scored results retained.
Separate local modal-qa-20261007.judgedesk archive saved for zero-result QA.
No writes to C:\Users\mon\Downloads\thihay-l2 or D:\Minh\Code\stress_test_judge.

Screenshots in artifacts/FR4-modal/manifest.json have status/build/viewport/hash.
The API supplies JPEG; renamed files to .jpg without changing image bytes.
Initial popup Escape and return-focus screenshots are RED, retained.
final-light-vi-short-basic.jpg is REJECTED: unchanged normal window with snap
overlay. Genuine small captures come from the separate 960x600 desktop launch.

## Review and limits

Independent reviewer checked mounted state, keyboard priority, Help layering and
focus return; findings fixed, final review found no remaining concrete issue.
User explicitly chose to skip additional cross-model review.

Five-axis check: functionality covered by focused/server/native evidence above;
readability improves through tab helper and a single keyboard owner; existing
frontend child/hook boundaries reused; no security/sandbox or backend change;
mounted child count matches the previous stacked modal, no new data fetch path.

Primary/hover white-text contrast: light 7.36/9.52:1; dark 7.68/5.48:1.
Light focus #246a5d on white 6.37:1. Full app/token/child-editor contrast and polish
remain later batches; this is not FR7 acceptance of the whole redesign.

Not runtime verified: injected load/save failures, save-in-flight/busy races,
screen reader announcements, macOS native focus, unusually long problem name.
Busy markup SSR checked; error footer source reviewed. No failure injection added
to production. Existing child layout/colors remain in later scope. Mounted panels
still respond to existing async synchronization effects; external reload draft
preservation is not claimed.

Generated src-tauri/toolchains is untracked runtime content. Artifacts/logs are
ignored; preserve evidence before archiving. No dependency/lock changes.

Recovery docs, logs and all 33 hashed screenshots also copied to original checkout
docs directory. Original full diff whitespace check reports pre-existing CRLF
whitespace in its dirty src/locales/vi.json; that file was not changed by this batch.
UI worktree diff check and original recovery-document diff check pass independently.
