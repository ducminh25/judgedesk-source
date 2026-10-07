# Problem Config Modal — Phương án A / Implementation contract

Updated 2026-10-07. Direction A accepted by user, with review findings incorporated.
Reference: [prototype](verification/frontend-redesign/artifacts/FR1/light-options.html),
[review](verification/frontend-redesign/problem-config-plan-review.md), AGENTS.md,
CONSTRAINTS.md and .agents/skills/judgedesk-frontend/SKILL.md.

## Isolation and scope

Implement in managed worktree C:\Users\mon\.codex\worktrees\judgedesk-frontend\judgedesk,
branch codex/frontend-redesign, base 23290be80111dd9ddf2e58f15006e0f076258eff (v1.5.3).
Original D:\Minh\Code\judgedesk stays on main with old frontend for backend hotfixes.
Do not carry its dirty backend/vi.json changes into this UI branch. No merge/release
in this task. Sync later backend fixes deliberately. Keep all eight version files.

Change modal layout/navigation and chrome, locale keys, focused tests and a small
frontend helper if needed. Reuse BasicProblemSettings, TestConfigurationTable,
GroupPolicyTable, CompileProblemSettings, useProblemConfigEditor and existing
rational functions. No backend/API/payload changes, new dependencies or validation
policy changes. Child visual polish is a later batch; keep form text selectable,
controls/tab labels unselectable, and preserve copying code/diagnostics.

## Navigation and mounted state

Three horizontal tabs: Cơ bản / Testcases & nhóm / Biên dịch (VI/EN).
Keep ALL three panels and CompileProblemSettings mounted; only CSS hidden/display:none
changes. Invalid custom draft, profile, selection and showContent survive navigation.
Do not reset compileConfigValid on tab change. Async config load may still trigger
existing synchronization effects; do not claim mounted state prevents all resets.

Use tablist/tab/tabpanel roles, aria-selected, stable unique ids and controls/labels.
Roving tabIndex: selected tab 0, others -1; Left/Right wrap and Home/End move focus
and activate immediately (panels preloaded). Tab exits to visible panel controls.
Add visible focus on tabs, close, cancel/save and validation recovery link.
Modal has dialog role/title/modal semantics, initial focus, trapped Tab/Shift+Tab
and restores previous focus. Preserve Escape order confirmation → popover → close.
Nested dialogs own their focus; do not steal focus from them. Close popover when
leaving Testcases, preserving committed edits and editor state.

## Layout and states

Header, tabs, footer shrink-0. Body min-h-0 flex-1 overflow-y-auto; NO fixed 380px
minimum. Bound modal to viewport height, keep max-w-6xl until native evidence
justifies narrowing. Scroll table/log only when necessary; do not clip popover or
focus ring. Test normal, narrow and short window, VI/EN, long names/content/groups.

LoadError and busy/read-only warnings remain visible outside hidden panels.
Footer keeps SaveError and compile blocked message on all tabs. Add action to
Compilation and focus invalid field when compile draft blocks Save. Save remains
blocked regardless of visible panel. Keep hasScoredResults confirmation and current
save payload/error behavior; no deletion/scoring changes.

## Summary

Reuse current save presence rule: totalScore is present when non-null/undefined
and its String value is not trim-empty; numeric 0 must remain 0. Otherwise use
editor.totalPoints. No parseFloat; rational string stays exact.
Summary modes: standard input/output, file input/output, stdin + file output,
file input + stdout, interactive. Map each to VI/EN. Loading/error text must not
pretend 0 tests means a completed fetch. Add count pluralization for EN and use
mono tabular figures for score metadata.

## Palette

Light primary #285f54 (hover #204d44), white text. Dark primary emerald-800
#065f46 (hover emerald-700 #047857), white text: both exceed 4.5:1.
Active dark tab emerald-400, light tab #285f54, underline + selected semantics.
Error text rose-700 light / rose-300 dark; focus #246a5d light / emerald-400 dark.
Check actual foreground/background and hover contrast; border/focus >=3:1 where
applicable, normal text >=4.5:1. Existing surface tokens stay; no blur/gradient/glow,
no pill controls, use crisp border and restrained neutral shadow. Use accent-color
for native checkbox styling rather than assuming text color changes ticks.

## Tests and verification

Before implementation: focused RED for summary 0/fraction/empty/mixed/interactive
and tab navigation. Existing project has SSR/helper tests but no DOM harness; do
not add dependencies without authorization. Use native desktop interaction evidence
for draft persistence, validation and focus, plus automated helpers/SSR where useful.
Do not represent SSR/source regex as proof of local state persistence.

Native acceptance: Custom invalid flags → change Basic/Tests → Save disabled and no
confirmation; return Compile → original draft/error remains; repair → Save available.
Check selected tests/showContent/groups/profile persist, popover closes, Escape
priority, busy/load/save errors, hasScoredResults confirmation and save exact config
on copied fixture. Do not modify real contests. Include Light/Dark × VI/EN, short
viewport footer, keyboard wrap/focus/return and before/after screenshots.

Run focused tests, npm run check:fast, npm run test:server and npm run test:desktop.
Restart desktop per batch (--no-watch / DISABLE_HMR=true). Run check:full before
commit/push. Preserve failures as evidence; no skipped/deleted tests or weakened
gates. Document missing platform checks, do not call them PASS. Keep STATUS/WORKLOG
and build identity current. No commit/merge required for this task.

## Execution record — 2026-10-07

This modal tab batch is implemented in the isolated worktree and verified on Windows.
See verification/frontend-redesign/problem-config-modal-implementation.md for gates,
native evidence and explicit coverage limits; STATUS.md/WORKLOG.md record resume state.
Original main frontend remains unchanged. Wider redesign and child polish remain.
