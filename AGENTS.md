# JudgeDesk — AI Coding Agent Protocol & Skill Dispatcher

> **Target Audience:** All AI Coding Agents (Antigravity, Cursor, Claude Code, Codex, GitHub Copilot, OpenCode, Windsurf, Cline, and other MCP/LLM tools) working on the **JudgeDesk** codebase.

---

## 1. Prime Directives & Source of Truth

1. **Authoritative Specification:** [`guidelines.md`](guidelines.md) and [`CONSTRAINTS.md`](CONSTRAINTS.md) are the primary, non-negotiable architectural blueprints and quality contracts for JudgeDesk. Every agent MUST respect the 4-tier architecture, platform security models, zero-tolerance floor rules, and project invariants defined in those documents.
2. **Critical Project Invariants:**
   - **8-File Version Lockstep:** Never bump version numbers in isolation. All 8 version files (`package.json`, `package-lock.json`, `src/version.ts`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json`, `native-executor/Cargo.toml`, `native-executor/Cargo.lock`) must stay synchronized and validated via `npm run release:check-version`.
   - **Fail-Closed Sandbox:** Untrusted student submissions run in zero-network OS sandboxes (Windows AppContainer + Low Integrity / macOS Seatbelt). Never bypass or weaken isolation boundaries.
   - **Rational Scoring Engine:** Never use floating-point math for points or ranking; always use rational fraction reductions (`server/judge/scoring.ts`) to avoid IEEE 754 drift.
   - **No Compiler Fallback:** Never automatically fallback to an unconfigured or incompatible compiler on failure. Fail cleanly with clear diagnostic errors.
   - **Zero-Tolerance Quality Floor:** Zero `@ts-ignore`, pure ESM import extensions (`.js`) in Node runtimes, no anti-AI-slop regressions (`backdrop-blur`, diffuse glows), and no deleted/skipped tests. Enforced by `node scripts/check-quality-gate.js`.
3. **Coding Standards:**
   - **C++:** `#include <bits/stdc++.h>`, fast I/O `ios_base::sync_with_stdio(false); cin.tie(0); cout.tie(0);`, 4 spaces, K&R braces, `camelCase` functions, `snake_case` variables, pre-increment `++i`. Modular logic in helper functions (`input()`, `solve()`).
   - **TypeScript / Node.js:** Pure ES Modules (`.js` extensions in imports), strict types (no `any`), atomic file writes via temporary files and rename.
   - **Rust:** No `unwrap()`/`expect()` in server/executor runtime paths, RAII for OS handles, clippy clean (`cargo clippy -- -D warnings`).

---

## 2. Autonomous Skill Dispatch Protocol

The project maintains production-grade engineering skills in [`.agents/skills/`](.agents/skills/). 
**Agents MUST proactively read and apply these skills based on the task intent WITHOUT waiting for the user to explicitly tag or invoke them:**

| When the task involves... | Relevant Skill File | Mandatory Autonomous Action |
| :--- | :--- | :--- |
| **New Features & Logic Changes** | [`.agents/skills/test-driven-development/SKILL.md`](.agents/skills/test-driven-development/SKILL.md)<br/>[`.agents/skills/doubt-driven-development/SKILL.md`](.agents/skills/doubt-driven-development/SKILL.md) | Apply the Red-Green-Refactor loop. Write tests before implementation. Actively identify edge cases, boundary limits (1024MB, TLE 1.001s), and failure modes before writing code. |
| **Bug Fixing & Test Failures** | [`.agents/skills/debugging-and-error-recovery/SKILL.md`](.agents/skills/debugging-and-error-recovery/SKILL.md) | Formulate explicit diagnostic hypotheses. Isolate root cause across the 4 tiers (React, Express, Tauri, Rust IPC) before proposing fixes. Never guess or apply blind trial-and-error edits. |
| **Sandbox, Win32 Pipes, IPC, Toolchains** | [`.agents/skills/security-and-hardening/SKILL.md`](.agents/skills/security-and-hardening/SKILL.md) | Model threats across trust boundaries (untrusted submissions, toolchain downloads). Validate against path traversal, privilege escalation, and resource leaks. |
| **Code Cleanup & Refactoring** | [`.agents/skills/code-simplification/SKILL.md`](.agents/skills/code-simplification/SKILL.md) | Prioritize clarity over cleverness. Remove dead code and unnecessary abstractions without altering runtime behavior. |
| **Performance, Universal PCH, Pre-warm** | [`.agents/skills/performance-optimization/SKILL.md`](.agents/skills/performance-optimization/SKILL.md) | Profile and benchmark before optimizing. Verify Universal PCH hit rates and IPC round-trip latency. |
| **Pre-Commit Review & Verification** | [`.agents/skills/code-review-and-quality/SKILL.md`](.agents/skills/code-review-and-quality/SKILL.md) | Conduct a multi-axis review (Functionality, Quality, Security, Performance, Maintainability) before declaring any task complete. |
| **Releasing, Versioning, Packaging** | [`.agents/skills/shipping-and-launch/SKILL.md`](.agents/skills/shipping-and-launch/SKILL.md) | Execute pre-flight verification checklist. Run `release:check-version` and ensure release artifacts meet integrity requirements. |
| **Linters, Gates, Thresholds** | [`.agents/skills/constraint-driven-development/SKILL.md`](.agents/skills/constraint-driven-development/SKILL.md) | NEVER lower quality standards: no `@ts-ignore`, no silenced linter checks, no deleted/skipped tests to achieve a green build. See [`CONSTRAINTS.md`](CONSTRAINTS.md). |
| **UI/UX Styling & Frontend Polish** | [`.agents/skills/redesign-existing-projects/SKILL.md`](.agents/skills/redesign-existing-projects/SKILL.md)<br/>[`.agents/skills/minimalist-ui/SKILL.md`](.agents/skills/minimalist-ui/SKILL.md) | Eradicate AI-slop (no gradients, no diffuse colored glows, no heavy backdrop blurs, no pill buttons). Enforce utilitarian desktop precision, crisp 1px borders, tabular numbers (`tabular-nums`), and high data density. |

---

## 3. Verification & Execution Gate

Before concluding any work, the agent MUST run and pass the relevant verification commands:

```powershell
# Fast check: Types & Quality Invariant Gate (~3s)
npm run check:fast

# Dynamic full server & judge test suite (98 suites, >530 tests)
npm run test:server

# Complete gate before commit / push / release
npm run check:full

# If Native Executor / Rust code was touched
cargo test --locked --manifest-path native-executor/Cargo.toml

# If versioning / release was touched
npm run release:check-version
```
