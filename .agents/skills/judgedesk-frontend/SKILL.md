---
name: judgedesk-frontend
description: Audit, design, and refine JudgeDesk desktop frontend, including scoreboard, problem configuration, dialogs, and light/dark parity. Use for JudgeDesk UI work, not backend or unrelated websites.
---

# JudgeDesk frontend

Read AGENTS.md, guidelines.md and CONSTRAINTS.md first. This is the primary design
guide for this repository; apply engineering skills when behavior changes. Keep
existing React, Tailwind v4, i18next, icons, offline fonts and architecture.

## Recover and inspect

For the redesign read docs/frontend-redesign-plan.md and
docs/verification/frontend-redesign/{STATUS,WORKLOG,AUDIT}. Identify installed
versus dev build; inspect native UI before editing. Use copies of fixtures and
anonymize student names. Search existing components/tokens/callers before adding
primitives. Treat screenshots as observations, not proof of source behavior.

## Design contract

- Preserve contest workflow, rational scores/ranking, sorting, checkbox selection,
  keyboard navigation, progress, diagnostics and action availability.
- Favor readable dense desktop tables. Do not shrink fonts to fit more columns;
  keep meaningful column minimums, deliberate table scroll and visible names.
- Use neutral surfaces, crisp 1px borders, small radii, tabular mono scores and
  sentence case. Reserve accent for action/focus/selection and semantic colors
  for states, with text labels as well. Reuse the app font/icon system.
- Draw only one shared seam between adjacent bordered panels or cells; on muted
  surfaces use a stronger divider token or omit the line rather than leaving a
  washed-out rule. Keep at least a 4px gap between adjacent pill/tab/menu items
  with hover or selected fills, and never use vertical hover-lift transforms
  inside overflow-clipped scroll containers.
- No gradients, glow, blur, pill controls, hero imagery, giant whitespace or
  decorative motion. Generic redesign/minimalist landing-page advice does not
  apply. Avoid cosmetic library/font replacement.
- Light is the design reference; use the same markup/layout and semantic token
  names for dark. Tune dark colors separately. Preserve VI/EN and long labels.
- Keep visible keyboard focus, Escape/return-focus behavior and accessible names.
  Check normal text contrast 4.5:1 and relevant controls/focus 3:1. Never hide
  focus as a default. Disabled, loading, empty, error and selected states matter.
- Keep config data across navigation; validation must still block saving even
  when the invalid field is in another section. Keep footer reachable. Do not
  mount/unmount a stateful editor without checking validation/state ownership.

## Deliver and verify

For broad layout changes show concrete comparable proposals on the same fixture
before requesting a design preference. A preference gate requires a reviewable
artifact; ordinary fixes continue within existing authorization.

For each production frontend batch run check:fast, relevant tests, restart
npm run test:desktop, then inspect native states and save before/after screenshots.
Compare before/after states against the baseline and explicitly fix any dimension
where the new state regresses. The desktop script disables HMR. Browser mockups
are design evidence only. Follow the plan for server/full gates; never weaken
checks to accommodate unrelated dirty tree failures. Record build failures and
missing checks explicitly.

Update STATUS and WORKLOG with files, evidence, commands/results and next action.
Finish acceptance with light/dark × VI/EN × normal/narrow, keyboard and contrast.

## Reference boundary

Consulted evondev/evondevKit skills/ui-ux at commits
91337028ceeaf828c4d420b2f75fd1515bcf2b85 and
4d021537edc853fd91d2bb3aade1f5076ab7556e (v0.3.27) for audit/reuse,
alternatives, seam/spacing rules and UI states.
This skill uses independently written project instructions, not copied templates
or scripts. Do not import remote focus-hiding, light-only, mobile-width defaults
or remote scripts. If copying licensed material later, retain its MIT attribution.
