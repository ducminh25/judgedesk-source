# FR1 — Light proposals

Prototype: `artifacts/FR1/light-options.html`. Standalone HTML, no dependency,
no backend and no file writes. Buttons for A/B, 5/20 columns and config sections
are interactive; judging/save are not implemented in the prototype. Score display
is illustrative, not a replacement for shared rational formatters. Source data
must remain canonical in production. No production frontend files changed.

## Source diagnosis

`src/features/scoreboard/Scoreboard.tsx`: minimumProblemColumnWidth = 72; fontSize
falls to 9 below effective width 88; checkbox + name + menu share this width;
name uses overflow-wrap:anywhere. This explains the installed observation but
must still be reproduced in current dev build before a production fix.

`src/components/ProblemConfigModal.tsx`: BasicProblemSettings outside the scroll
body; compile/test/group panels inside. Each section repeats border/padding.
CompileProblemSettings owns validity notification, so tab changes must not reset
or accidentally bypass invalid compile parameters. Editor state already lives in
useProblemConfigEditor: reuse it rather than rewrite config serialization.

`src/index.css`: existing surface/text tokens, Tailwind v4; accent/verdict colors
also hardcoded in components. Audit callers before centralizing semantic tokens.
Keep current icons and offline typography. No runtime/version/dependency changes.

## Comparable alternatives

| | A — Dense desktop | B — Reading emphasis |
|---|---|---|
| Score rows | 34px, same count as existing | 40px, fewer rows visible |
| Text | 13px UI and score, no density-based shrinking | Same readable size |
| Problem minimum | 144px, one-line truncation/full-name affordance | 164px, fewer columns visible |
| Total | Neutral surface, tabular figures | Same |
| Primary action | Restrained green | Charcoal |
| Config navigation | 3 horizontal sections | 190px left section list |
| Config tradeoff | Full content width; tabs constrain future labels | More room for section names; less width for tests |
| Workflow | Basic → Tests/groups → Compile, shared editor | Same steps and data |

Recommendation: A as starting point, retaining current density and improving
readability. 144px/13px are proposals, not frozen quality thresholds. Header
full-name access, control hit targets and selected column behavior need native
validation. Primary green is separate from verdict success via shape/text role;
if that distinction is unclear during testing, use neutral primary instead.

Both proposals keep main table central, intentional horizontal scroll, sticky
name/total, explicit verdict labels and an active cell outline. The static 5/20
column mockup uses the same selected stress rows. It is not the thihay data model.
No added sidebar in main app, no decorative cards, gradients or new fonts.

## Design QA status

2026-10-03: browser preview of local file was rejected by URL security policy
(file scheme unsupported). No alternate browser/server workaround attempted.
Opened source via open_in_codex. Render, interaction, narrow layout and screenshot
verification are NOT_RUN; prototype must not be represented as visually approved.
Final design preference remains pending; production rollout starts after direction
selection and actual native testing. EN/keyboard/contrast/parity remain required.

JavaScript syntax check passed via node:vm.Script (no browser execution). Skill
quick_validate.py could not run: host Python lacks yaml/PyYAML. No package installed;
frontmatter/name/relative repository paths reviewed manually. These checks do not
establish visual or behavioral correctness.

Project skill `.agents/skills/judgedesk-frontend/SKILL.md` is independently written.
Reference evondevKit commit 91337028ceeaf828c4d420b2f75fd1515bcf2b85 was read via
raw GitHub; no scripts/templates copied. Adapted concepts are reuse, audit,
comparable alternatives and states; rejected hidden-focus and light-only defaults.
AGENTS dispatch now points to the project contract; supporting skill files intact.
