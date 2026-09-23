# JudgeDesk — Engineering Constraints & Quality Bar

> **Status:** Active & Enforced  
> **Last reviewed:** 2026-09-18  
> **Applicability:** All developers and AI coding agents (Antigravity, Cursor, Claude Code, Codex, GitHub Copilot, Windsurf, Cline).

---

## 1. Floor Invariants (Always Enforced, Never Weakened)

These five floor rules are strictly enforced by `scripts/check-quality-gate.js` and must never be bypassed to achieve a passing build:

1. **Zero Suppression Comments:** No `@ts-ignore` or `@ts-nocheck`. Fix type errors at the root.
2. **Zero Unimplemented Stubs:** No `throw new Error("Not implemented")` and no silent empty `catch {}` blocks.
3. **Zero Skipped/Deleted Tests Without Written Reason:** Do not delete or disable existing test assertions to make a branch pass.
4. **Rational Scoring Invariant:** Never use IEEE-754 floating-point math for points or rankings. Always use rational fraction reductions (`server/judge/scoring.ts`, `shared/rational.ts`).
5. **Anti-AI-Slop Styling Guard:** Utilitarian desktop precision only:
   - No `backdrop-blur-*` (frosted glass) — causes WebKit compositing stutter on macOS.
   - No diffuse colored glows (`shadow-*-500/*`). Use crisp neutral structural shadows.
   - No bouncy animations (`animate-bounce`).
   - Dynamic figures must use `font-mono tabular-nums`.

---

## 2. Enforced Quality Dimensions

| Dimension | Rule | Checked by | Runs at | Budget |
| :--- | :--- | :--- | :--- | :--- |
| **Types** | Zero TypeScript compiler errors | `tsc --noEmit` | every edit, pre-build | < 5s |
| **Architecture & Invariants** | Floor rules, ESM extensions, Anti-slop, Rational math | `node scripts/check-quality-gate.js` | every edit, pre-build | < 2s |
| **8-File Version Lockstep** | Synchronized versions across all 8 project files | `node scripts/check-release-version.js` | every edit, pre-build | < 1s |
| **Core Test Suite** | 100% of discovered unit/server suites must pass (>520 tests) | `node scripts/run-all-tests.js` | task completion, CI | < 90s |
| **Native Sandbox Security** | Zero-network low-integrity OS isolation | `npm run test:security` | sandbox changes, CI | < 30s |
| **Native Executor Clippy** | No compiler warnings in Rust executor runtime | `cargo clippy -- -D warnings` | executor changes, CI | < 60s |

---

## 3. Standard Gate Commands

```powershell
# Fast local edit gate (< 5 seconds)
npm run check:fast

# Full local test suite (> 520 tests, zero omissions)
npm run test:server

# Complete pre-commit / release verification gate
npm run check:full
```

Any attempt by an automated agent to weaken thresholds or remove checks from this file or from `scripts/check-quality-gate.js` is considered an engineering contract violation.
