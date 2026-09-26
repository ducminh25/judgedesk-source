# Antigravity Handoff Guide — JudgeDesk Pure Rust Core v1.6.0

> **Historical released baseline:** `v1.5.0`; current source lockstep `1.5.1` (STATUS/LOG-0050)
> **Development target:** `v1.6.0`
> **Model:** Gemini 3.8 Flash High
> **Primary plan:** `docs/pure-rust-core-detailed-implementation-plan.md`

Use this guide to start and steer Antigravity sessions. The detailed plan remains authoritative for scope, dependencies, tests, and evidence.

For day-to-day navigation, begin with `docs/pure-rust-core-start-here.md`. Current ownership and completion state live in `docs/verification/pure-rust-core/STATUS.md`; chronological handoffs live in `WORKLOG.md`. Chat history is not the status source of truth.

## 1. Version rule that every agent must repeat back

- `v1.5.0` is already released. It is the compatibility and upgrade baseline.
- Current implementation work targets `v1.6.0`.
- During implementation, preserve the current verified eight-file source lockstep (`1.5.1` now); do not revert it to the historical 1.5.0 prose baseline.
- Do not change any version early.
- Only WP10.3 may change all eight files together to `1.6.0`, immediately before release-candidate verification.
- A partial bump, an early bump, or a ninth version file added without an approved policy change is a failure.

## 2. Recommended operating model

Use one bounded claim per work package. An accurate implementation conversation may continue to the next authorized READY WP only after independent DONE and a separate compact claim, within the same phase/trust boundary. Fresh context remains required for independent verification, ownership transfer, new phase/trust boundary, material drift or lost scope. Do not ask one default-agent turn to implement the entire migration. Follow `docs/pure-rust-core-efficient-execution.md` for scheduling/evidence reuse.

Recommended sequence:

1. Read current STATUS and accepted reports; WP0.1–WP0.3 are DONE as of LOG-0051. Refresh source/environment identity without replaying those packages.
2. Respect canonical contract/corpus ownership and reuse their accepted immutable fixtures; changed references invalidate affected evidence.
3. Run WP0.4, WP0.5, and WP0.6 as separate work packages. They may be researched in parallel only when agents do not edit shared files.
4. Run WP0.7 before broad edits to the Rust route surface.
5. Follow the dependency graph in Section 3.5 of the detailed plan.
6. Never start a dependent package while its prerequisite report says `NOT READY`, `FAIL`, `BLOCKED`, or `INCONCLUSIVE` on a required item.

For each package, give one agent ownership of shared route/session/registry/golden-fixture files. Other agents may perform read-only exploration, adversarial review, or isolated-platform verification.

## 3. Antigravity modes

### Default agent

Use for one bounded work package with a clear RED/GREEN loop. This is the fastest normal mode.

### `/boost`

Use selectively for difficult concurrency, security-boundary, root-cause, or multi-file refactoring work. Good candidates are WP0.4, WP1.1, WP1.2, WP1.6, WP4.3, WP5.4, and unresolved race/platform failures. Boost performs multi-agent reasoning and independent verification, so it normally costs more time and tokens than the default agent.

Example:

```text
/boost Execute WP1.1 only, using the handoff prompt below. Reproduce and close backend readiness, late-failure, drain, and orphan-process races. Do not start WP1.2.
```

### `/teamwork-preview`

Use only when you want Antigravity to coordinate a multi-day campaign. Its workers use isolated project directories and structured handoffs. Before approving it, make sure the exact current source state is available in that workspace; uncommitted changes in the current checkout must not be assumed to appear automatically.

The preferred Teamwork milestone is one plan phase or a set of non-overlapping work packages, not all phases in one opaque milestone. Require exclusive file ownership and the package reports defined by this repository.

## 4. CLI invocation and flags

First verify the locally installed names:

```powershell
agy --version
agy models
agy --help
```

Recommended headless invocation for a long work package:

```powershell
$prompt = Get-Content -Raw .\antigravity-wp-prompt.txt
agy -p $prompt `
  --model gemini-3.8-flash-high `
  --output-format stream-json `
  --print-timeout 90m `
  | Tee-Object -FilePath .\artifacts\antigravity-wp0.1.ndjson
```

Flag guidance:

| Flag | Recommendation | Reason |
|---|---|---|
| `--model gemini-3.8-flash-high` | Always pin it for automated runs | Unknown model names fail instead of silently falling back. |
| `--effort high` | Optional when the installed CLI exposes effort separately | The selected model slug already names the High variant. Check `agy models`/`agy --help`; do not add conflicting effort values. |
| `--output-format stream-json` | Use for long implementation/test runs | Preserves progress, tool events, usage, and terminal status as NDJSON. |
| `--output-format json` | Use for short read-only review jobs | Produces one final machine-readable envelope. |
| `--print-timeout 60m` or `90m` | Set explicitly | The documented default is five minutes, too short for Rust builds and desktop gates. An outer CI timeout must still terminate descendants and preserve logs. |
| `--continue` | Same WP, or next separately authorized/claimed READY WP after independent DONE within the same phase/trust boundary | Refresh mutable STATUS, actual source identity and changed authorities; start fresh on material drift or role/phase changes. |
| `--conversation <id>` | Use to resume a specifically recorded interrupted package | Safer than accidentally continuing the most recent unrelated session. |
| `--sandbox` | Use for read-only review or packages whose commands fit the terminal sandbox | Some JudgeDesk OS-sandbox, desktop, packaging, and SSH tests may require capabilities it blocks. Record when it is intentionally omitted. |
| `--dangerously-skip-permissions` | Do not use in the current dirty checkout | It approves every tool call. Prefer scoped permission rules. Consider it only in a disposable isolated worktree with a fully trusted prompt and no release credentials. |
| `--agent <name>` | Use only for a tested custom agent with a narrow role | It selects an agent; it is not a speed or quality switch by itself. |

For headless mode, configure scoped command permissions in Antigravity settings so expected `git status/diff`, `rg`, `npm`, `cargo`, and test commands do not stall. Do not broadly allow destructive Git/filesystem commands, release publication, signing-key operations, or arbitrary SSH commands.

Official references:

- [Antigravity headless mode and flag reference](https://www.antigravity.google/docs/cli/headless/)
- [Antigravity models](https://www.antigravity.google/docs/models/)
- [Boost deep reasoning](https://www.antigravity.google/docs/boost/)
- [Teamwork agent teams](https://www.antigravity.google/docs/teamwork/)

## 5. Paste-ready work-package prompt

Replace `<WP_ID>` and `<WP_TITLE>` only. Keep the rest unless the package report explicitly changes a dependency.

```text
You are implementing exactly <WP_ID> — <WP_TITLE> for JudgeDesk. Complete this work package end to end, including tests and its verification report. Do not start any later work package.

Repository and version context:
- Workspace: D:\Minh\Code\judgedesk
- v1.5.0 is already released and is the compatibility/upgrade baseline.
- Current work targets v1.6.0.
- Keep the verified eight-file source lockstep (currently 1.5.1) throughout implementation; do not revert to historical 1.5.0.
- Do not bump any version. Only WP10.3 may bump all eight files together to 1.6.0 immediately before release-candidate verification.
- The working tree may contain user changes. Preserve them. Never reset, checkout over, clean, reformat, or normalize unrelated paths.

Mandatory first reads, in this order:
1. AGENTS.md
2. docs/pure-rust-core-start-here.md
3. docs/verification/pure-rust-core/STATUS.md
4. docs/verification/pure-rust-core/WORKLOG.md (latest entries only unless history is needed)
5. guidelines.md
6. CONSTRAINTS.md
7. docs/pure-rust-core-antigravity-handoff.md
8. docs/pure-rust-core-detailed-implementation-plan.md, especially <WP_ID>, Sections 2-4, dependency graph, gate ladder, and failure triage
   Read docs/pure-rust-core-efficient-execution.md for deduplicated completion commands and evidence references.
9. docs/pure-rust-core-next-steps-audit.md only when its baseline/gap evidence is relevant
10. The project skills required by AGENTS.md for this package
11. Current implementation and tests named by the package; do not rely only on prose

Before editing:
- Confirm <WP_ID> is READY and unclaimed. Claim it in STATUS.md and append the claim to WORKLOG.md. If another owner already holds it, do not edit overlapping files.
- Capture git rev-parse HEAD, git status --short, relevant tool versions, processes/ports/roots, and prerequisite report verdicts.
- State one falsifiable package claim, its trust boundaries, primary files, shared files, rollback point, and focused test command.
- Confirm dependencies are DONE. If a required dependency is not DONE, do not start dependent implementation; record the prerequisite and continue only authorized work that is truly independent.
- Reconcile documentation with current frontend consumers, Node reference behavior, shared contracts, and tests. Record conflicts; do not silently choose.

Implementation rules:
- Follow RED -> GREEN -> REFACTOR. Preserve the failing RED output and rerun the same focused test for GREEN.
- Make the smallest reviewable change for <WP_ID>. Do not combine adjacent work packages.
- No fake success, placeholder metrics, hidden fallback, weakened sandbox, floating-point scoring, @ts-ignore, skipped/deleted tests, or suppressed warnings.
- Untrusted submission/checker/interactor/compiler paths must follow the executor architecture selected by WP0.4 and fail closed.
- Use atomic persistence and owned disposable roots. Prove process-tree drain and cleanup for cancellation/timeouts.
- Run shared executor/cache/AppData/desktop tests sequentially.
- Do not commit, push, tag, publish, sign, deploy, or modify release credentials.

Verification and output:
- Run focused RED/GREEN and mandatory edit/pre-build floor checks, then one successful final completion command union per frozen candidate. check:full already runs its listed child checks; do not repeat identical successful final children. Required Rust/security/platform/package checks remain mandatory. Failed, interrupted or invalidated runs require rerun with original logs preserved.
- Treat missing release-supported runtimes, new skips, orphan processes, locked roots, backend ambiguity, or unverified GUI behavior as blocking evidence, not PASS.
- For Windows GUI checks, use the required Computer Use protocol and capture stable screenshots/logs.
- The Mac is reachable as judgedesk-mac over SSH. Use an isolated exact source commit/archive and verify SHA-256 on both ends. SSH results cannot count as macOS GUI PASS.
- Write one canonical docs/verification/pure-rust-core/<work-package-id>-<short-name>.md retaining every Section 4 field, with compact tables and immutable artifact links rather than copied logs. Independent verdict attribution remains explicit.
- Produce machine-readable JSON when Section 4.2 requires it.
- Perform a fresh-context adversarial review of the final diff and resolve or record every finding.
- Set the package to VERIFYING in STATUS.md and append a handoff entry to WORKLOG.md. Do not self-start the next WP.

Final response must be concise and contain:
1. Package claim and READY/NOT READY verdict.
2. Files changed and why.
3. Test table with exact commands, counts, skips, duration, and artifact paths.
4. Security/process/port/root cleanup result.
5. Remaining failures or blockers with evidence.
6. Exact next permitted work package.

Do not claim completion from code inspection, a green aggregate with hidden skips, or Windows evidence substituted for macOS GUI evidence.
```

## 6. First prompt to send

Read current STATUS rather than reusing the historical WP0.1 startup prompt. Refresh actual source/environment identity and the authorized current package:

```text
Read AGENTS.md, guidelines.md, CONSTRAINTS.md, start-here, efficient-execution and STATUS/latest relevant WORKLOG. Work only on the authorized current <WP_ID>, confirming its owner and DONE dependencies. Preserve the saved dirty checkout and source version 1.5.1. Use focused RED/GREEN plus edit checks, freeze the candidate and execute one successful completion union plus required Rust/security/platform checks. Write one report with linked logs, set VERIFYING, append handoff and stop for fresh independent review. Do not replay accepted WP0.1–WP0.3 or start another package while VERIFYING.
```

After each independent DONE, use the generic compact next-package handoff. Continue accurate implementation context only under the lifecycle rules above. Use `/boost` only when concurrency/security complexity justifies its cost. WP0.3's same-session acceptance exception is bounded to that package.

## 7. Steering prompts

If the agent expands scope:

```text
Stop expanding scope. Return to <WP_ID> only. Revert only your out-of-scope edits without touching pre-existing user changes, then complete the focused RED/GREEN evidence and report.
```

If it reports green without sufficient evidence:

```text
The package is not READY. List every skipped/unattempted profile, process/port/root cleanup result, backend identity, and exact command output. Rerun the smallest missing gate. Do not infer PASS from inspection or another OS/backend.
```

If it loops or repeatedly rereads files:

```text
Use the package claim and current evidence already collected. Do not reread unchanged files. State the single remaining uncertainty, run the one command that resolves it, then either finish the report or mark the exact item BLOCKED.
```

If a test fails:

```text
Apply the debugging-and-error-recovery skill. Stop later implementation, preserve the failure artifact, form ranked hypotheses across frontend/API/core/executor/toolchain/OS/harness, isolate the root cause, add or retain a focused regression test, and rerun the affected gate. Do not weaken the test or quality floor.
```
