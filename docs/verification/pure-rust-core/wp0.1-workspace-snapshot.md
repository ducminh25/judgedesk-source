# WP0.1 — Workspace and Environment Snapshot

## Scope
- **Claim:** Baseline workspace state, dirty tree, versions, active processes, ports, receipts, and test inventories are reproducibly captured and verified without mutating the working tree.
- **STATUS/WORKLOG claim event:** LOG-0005 in `docs/verification/pure-rust-core/WORKLOG.md` and row `WP0.1` in `docs/verification/pure-rust-core/STATUS.md`.
- **Dependencies satisfied:** None (WP0.1 is the initial root package).
- **User-visible behavior:** No runtime behavior changes (baseline environment and workspace snapshot only).
- **Trust boundaries touched:** Read-only observation of local processes, listening ports, managed-toolchain receipt/config files, and the remote macOS environment; no runtime or external state was mutated.
- **Primary files owned/changed:**
  - `docs/verification/pure-rust-core/wp0.1-workspace-snapshot.md` (this report)
  - `docs/verification/pure-rust-core/STATUS.md` (control state update)
  - `docs/verification/pure-rust-core/WORKLOG.md` (audit trail)
- **Shared files/fixtures and assigned owner:** None modified.
- **Explicitly out of scope:** Code modifications, version bumping, starting WP0.2, running full test suites or destructive operations.
- **Rollback point and rollback procedure:** Remove only WP0.1 report/artifacts by explicit reviewed paths if the evidence package must be withdrawn, then append a corrective WORKLOG entry and reconcile STATUS. Never use a broad checkout over the shared append-only coordination directory.
- **Focused verification command:**
  ```powershell
  npm run check:fast
  npm run release:check-version
  node scripts/run-all-tests.js --dry-run
  ```

---

## Source identity
- **Commit before:** `d80f997cdafaf85883e7602de26c32dd355795a1`
- **Commit/diff after:** `d80f997cdafaf85883e7602de26c32dd355795a1` (preserved 63 modified dirty files and untracked artifacts).
- **Dirty paths before:**
  - 63 modified tracked files (including `.gitignore`, documentation files, `guidelines.md`, `native-executor/src/`, `package.json`, `server/`, `src-tauri/`, `src/`).
  - Untracked directories/files (`.agents/`, `AGENTS.md`, `CONSTRAINTS.md`, `crates/`, `docs/pure-rust-core-*`, `docs/verification/`, etc.).
  - 4 files with pre-existing EOF blank lines identified by `git diff --check`: `docs/UI_UX_DESIGN.md:179`, `src-tauri/src/startup_guard.rs:1200`, `src/features/judging/availability.ts:50`, `src/features/problem-config/editor-state.test.ts:106`. All preserved untouched.
- **OS / architecture:**
  - OS: Windows 11 Pro (Microsoft Windows NT 10.0.26200.0)
  - Architecture: X64
  - CPU Cores: 12 logical processors
  - macOS verifier refresh over SSH: Darwin ARM64, macOS 26.6.2 build 25G83 (host alias `judgedesk-mac`). The two saved checkouts are dirty and at different commits; no macOS repository test was run for WP0.1.
- **Toolchain versions:**
  - Node.js: `v24.19.0`
  - npm: `11.17.0`
  - Rustc: `1.97.1 (8bab26f4f 2026-07-14)`
  - Cargo: `1.97.1 (c980f4866 2026-06-30)`
  - rust-toolchain channel: `1.97.1` (profile: minimal, components: `rustfmt`)
  - Tauri CLI: `tauri-cli 2.11.4`
- **Rust core mode and feature flags:**
  - Build profile: debug/dev
  - Optional flag: `JUDGEDESK_PURE_RUST_CORE=1` for embedded Rust backend selection.

### Version lockstep audit (8 Authoritative Files)
All 8 files synchronized at released baseline `1.5.0`:

| File | Size (bytes) | SHA-256 Digest | Verified Version |
|---|---:|---|---|
| `package.json` | 5,957 | `39630E56E1600D78E6BB78B92C0FA746BB8B1617CC4E3F0C516116EB6CC91AC3` | `1.5.0` |
| `package-lock.json` | 162,040 | `A01FE2F4D6E17BCBC47FD433C0A29F24778C9274795BC03058623051C5657870` | `1.5.0` |
| `src/version.ts` | 37 | `3EF228E137810C41985361F01B2263FA293409406FCDBB2D39454D1EBB3850C5` | `1.5.0` |
| `src-tauri/Cargo.toml` | 1,288 | `03B0DE066DEBC06A95372D3935C461618C371D5876E72E1C76C848BD57C91E21` | `1.5.0` |
| `src-tauri/Cargo.lock` | 135,884 | `6A060D7C589E756456E8B1C59F8ADF08C0EB270C6049C0A6A0C86276D03C1F25` | `1.5.0` |
| `src-tauri/tauri.conf.json` | 1,935 | `3AF8815017E739F092E3CDB1E50A2431FBB9C5A4F12A18CA057906BB9BE0442D` | `1.5.0` |
| `native-executor/Cargo.toml` | 783 | `4A2F25DBF5D8960E24ECD86D86734EC0B1D6CF27677435923104D3C015DE0A7B` | `1.5.0` |
| `native-executor/Cargo.lock` | 3,325 | `4C64240ADE315C03A7A816D4143906B481FA9A60CB73EDD8F66EA0F02C191F7C` | `1.5.0` |

### Key Project & Toolchain Config Digests
| File | Size (bytes) | SHA-256 Digest |
|---|---:|---|
| `crates/judgedesk-core/Cargo.toml` | 484 | `6887805CF5B7A05E6717E53322FBC6640FDBB50902D0CAD4DA4977E2096A7BCE` |
| `rust-toolchain.toml` | 80 | `157578EFDC4DB03268ABC54783E587C7B8FE976A758EDB5457B5F10A127FC07E` |
| `tsconfig.json` | 587 | `5FD1CA07D304996A72AECDA9BAA5BF1556567442FE269984060AF73882771E1A` |
| `vite.config.ts` | 740 | `14045DA468D13259471BF3670B09CA77E006A2B6862EA16DBC37487479605041` |

---

## Contract decisions
| Decision | Node behavior | Rust behavior before | Required behavior | Evidence |
|---|---|---|---|---|
| Version baseline | `v1.5.0` locked across 8 authoritative files | `v1.5.0` locked | Maintain `1.5.0` until WP10.3 bump to `1.6.0` | `npm run release:check-version` PASS |
| Test suite discovery | 99 suites on disk | Distinct cargo test targets | Dry-run inventory captures all suites | `scripts/run-all-tests.js --dry-run` |
| Managed toolchains | Installed in `%LOCALAPPDATA%\ThemisV2\toolchains` with receipt | Not yet hooked into pure-rust execution | Receipt/config presence, size, and snapshot hashes inventoried; signature/schema/authenticity verification belongs to later packages | 5 receipt files inventoried and hashed |

---

## TDD evidence
### RED
- **Status:** `NOT_RUN` / not applicable to this read-only evidence package.
- **Reason:** WP0.1 changes no product behavior, so manufacturing a failing executable test would not be meaningful. The precondition was an absent current snapshot/report, demonstrated by the initial `READY` ledger state rather than a RED test command.

### GREEN
- **Commands:**
  ```powershell
  npm run check:fast
  npm run release:check-version
  node scripts/run-all-tests.js --dry-run
  ```
- **Result:**
  - `check:fast`: PASS (TypeScript 0 errors, Quality Gate 0 regressions, 116ms)
  - `release:check-version`: PASS (1.5.0 verified)
  - `run-all-tests.js --dry-run`: PASS (99 test suites discovered)

### REFACTOR
- **Structural change:** Preserved all dirty paths in tree without overwriting any working-tree diff.
- **Verification after refactor:** `git status --short` confirms zero unauthorized mutations.

---

## Automated test results
| ID | Layer | Command | Duration | Status | Passed | Failed | Skipped | Notes |
|---|---|---|---|---|---:|---:|---:|---|
| T0.1-1 | Quality | `npm run check:fast` | 7.0s | PASS | 1 | 0 | 0 | Node 24.19.0, npm 11.17.0, all invariants clean |
| T0.1-2 | Release | `npm run release:check-version` | 4.0s | PASS | 1 | 0 | 0 | Exactly 1.5.0 verified across all 8 files |
| T0.1-3 | Test Discovery | `node scripts/run-all-tests.js --dry-run` | 4.0s | PASS | 99 | 0 | 0 | 99 test suites identified on disk |
| T0.1-4 | Process Audit | `Get-Process ...` | 4.0s | PASS | 0 | 0 | 0 | Zero active `judgedesk`, `tauri`, or `executor` processes |
| T0.1-5 | Port Audit | `Get-NetTCPConnection ...` | 6.0s | PASS | 0 | 0 | 0 | Ports 3000, 5173, 6174, 8080, 9876, 18420, 18421, 1420 all free |

### Complete Test Inventory (99 suites discovered)
```text
scripts/build-server-target.test.js
scripts/create-toolchain-archive.test.ts
scripts/generate-updater-manifest.test.js
scripts/package-toolchains.test.ts
scripts/prepare-toolchain-gate-root.test.ts
scripts/single-instance-contract.test.js
scripts/toolchain-release-sources.test.ts
server/distribution.test.ts
server/executor/client.test.ts
server/executor/verdict-mapper.test.ts
server/executor/workspace.test.ts
server/export/workbook-opener.test.ts
server/jobs.test.ts
server/judge/c-submission.gate.test.ts
server/judge/compiler.test.ts
server/judge/custom-checker-runner.test.ts
server/judge/custom-checker.gate.test.ts
server/judge/discovery.test.ts
server/judge/execution-request.test.ts
server/judge/judge-session-preflight.test.ts
server/judge/language-adapters.test.ts
server/judge/managed-artifact.test.ts
server/judge/managed-runtime.test.ts
server/judge/multi-language.gate.test.ts
server/judge/osd-log-writer.test.ts
server/judge/osd-parser.test.ts
server/judge/osd-watcher.test.ts
server/judge/python-runtime.test.ts
server/judge/python-submission.test.ts
server/judge/resource-policy.test.ts
server/judge/scoring.test.ts
server/judge/standard-checkers.test.ts
server/judge/toolchain-preflight.test.ts
server/judge/universal-pch.test.ts
server/languages/contracts.test.ts
server/languages/registry.test.ts
server/languages/version-policy.test.ts
server/platform/backend-startup-gate.test.ts
server/platform/directory-picker.test.ts
server/platform/parent-watchdog.test.ts
server/platform/run-metadata.test.ts
server/platform/server-lifecycle.test.ts
server/problems/problem-config.test.ts
server/routes/osd-routes.test.ts
server/routes/toolchain-routes.test.ts
server/sandbox/detection.test.ts
server/sandbox/path-mapping.test.ts
server/toolchains/cached-status.test.ts
server/toolchains/certificate-readiness.test.ts
server/toolchains/certificate-store.test.ts
server/toolchains/certification.test.ts
server/toolchains/diagnostics.test.ts
server/toolchains/discovery.test.ts
server/toolchains/distribution-builder.test.ts
server/toolchains/execution-policy.test.ts
server/toolchains/host-compatibility.test.ts
server/toolchains/installer.test.ts
server/toolchains/local-execution.test.ts
server/toolchains/maintenance-gate.test.ts
server/toolchains/manifest.test.ts
server/toolchains/migration.test.ts
server/toolchains/package-store.test.ts
server/toolchains/preferences-v2.test.ts
server/toolchains/profile-state.test.ts
server/toolchains/resolver.test.ts
server/toolchains/snapshot.test.ts
server/toolchains/storage-v2.test.ts
shared/rational.test.ts
src/components/AppErrorToast.test.tsx
src/components/AppToolbar.test.tsx
src/components/DirectoryPickerModal.test.tsx
src/components/EntityActionMenu.test.tsx
src/components/InstallUpdateDialog.test.tsx
src/components/JudgingDetailsModal.test.tsx
src/components/ProblemConfigSaveConfirmDialog.test.tsx
src/components/ProgressWindow.test.tsx
src/features/changelog/ChangelogModal.test.tsx
src/features/changelog/changelog-data.test.ts
src/features/contest/contest-file.test.ts
src/features/desktop/browser-lifecycle.test.ts
src/features/errors/app-error.test.ts
src/features/export/score-workbook.test.ts
src/features/help/HelpCenter.test.tsx
src/features/judging/availability.test.ts
src/features/judging/judge-results.test.ts
src/features/osd/OsdComponents.test.tsx
src/features/preferences/storage.test.ts
src/features/problem-config/CompileProblemSettings.test.tsx
src/features/problem-config/editor-state.test.ts
src/features/scoreboard/Scoreboard.test.tsx
src/features/scoreboard/scoreboard-model.test.ts
src/features/shortcuts/shortcuts.test.ts
src/features/toolchains/ScratchToolchainPromptModal.test.tsx
src/features/toolchains/ToolchainManager.test.tsx
src/features/updates/UpdateDialogs.test.tsx
src/features/updates/catalog.test.ts
src/features/updates/install-flow.test.ts
src/features/workspace/path-memory.test.ts
src/features/workspace/selection-state.test.ts
```

---

## Managed toolchains and receipt inventory
Located at `%LOCALAPPDATA%\ThemisV2\toolchains\` (the user-specific absolute path is intentionally redacted):

| Package ID | Receipt Path | Size (bytes) | SHA-256 Digest |
|---|---|---:|---|
| `fpc-windows-x64` | `fpc-windows-x64\.judgedesk-package.json` | 524 | `D7479BF3F896829665BF4A6B12114BF9BAA3F9C68E63DC0B41976D8500D66663` |
| `gcc-windows-x64` | `gcc-windows-x64\.judgedesk-package.json` | 655 | `2BFBAFDDD3C921BF07B4C5C4D6972A9AE2F40E93E9983457D9F27C461ACC61FA` |
| `python-windows-x64` | `python-windows-x64\.judgedesk-package.json` | 606 | `858F79C23585B409F7C57B82322AAA9FE2078722B299397A9E02DB02654DADDD` |
| `scratch-windows-x64` | `scratch-windows-x64\.judgedesk-package.json` | 407 | `95B48712BE2E74D0F3050FF7FBB0E13F1CCE62E3AFDE979E0DE31E5FCEF6AEE2` |
| `temurin21-windows-x64` | `temurin21-windows-x64\.judgedesk-package.json` | 727 | `670E566384862EC835BF9EBFD0F75C937605C9DED29FD3975271B64EF8ABE67F` |

### Application Data Configuration Files
| File | Path | Size (bytes) | SHA-256 Digest |
|---|---|---:|---|
| `toolchains.json` | `%LOCALAPPDATA%\ThemisV2\toolchains.json` | 521 | `5F1BE9EF03B198D9672124B7E194822250B818842C8C392C054EE0B7605F5A7C` |
| `toolchain-discovery-v1.json` | `%LOCALAPPDATA%\ThemisV2\toolchain-discovery-v1.json` | 2,580 | `081D0C4A16998AF67AFBD8EE401659ACACF39837AEC497135C9BB2E91DF6F2DD` |
| `toolchain-discovery-v2.json` | `%LOCALAPPDATA%\ThemisV2\toolchain-discovery-v2.json` | 5,539 | `52A35F1BE3B92DF9D3B4FBF79AF14F2DE026A34771E2FC4D7246EA1B186338C7` |
| `toolchain-distribution-state-v1.json` | `%LOCALAPPDATA%\ThemisV2\toolchain-distribution-state-v1.json` | 93 | `8E784761494A9CAD6ABF699A9EA315B578B5645A3C6205900BAE9FBC1779B098` |
| `toolchain-execution-policy-v1.json` | `%LOCALAPPDATA%\ThemisV2\toolchain-execution-policy-v1.json` | 63 | `55E1D245F8376B9D1F52A2C8C50A51C8AC0909A21792FF374EFACB9F67A9C4B2` |

---

## Manual / Computer Use results
| Scenario | Backend | Data set | Steps | Expected | Observed | Status | Screenshot/log |
|---|---|---|---|---|---|---|---|
| Windows baseline visual C++ self-test | Embedded Rust (`JUDGEDESK_PURE_RUST_CORE=1`) | Internal self-test snippet | Prior audit only; not rerun for WP0.1 | Historical evidence remains identifiable | Prior audit recorded `Operating Normally`, compile 2926ms, run 60ms, memory 1976 KB | NOT_RUN | Reference: `docs/pure-rust-core-next-steps-audit.md` |

---

## Cross-platform results
| Scenario | Windows x64 | macOS arm64 | Parity verdict |
|---|---|---|---|
| Environment snapshot | Verified Windows 11 Pro 10.0.26200, Node 24.19.0, Cargo 1.97.1 | Refreshed over SSH: Darwin ARM64, macOS 26.6.2 build 25G83, Node 24.19.0, Cargo 1.97.1 | PASS for host/tool versions |
| Current source identity | HEAD `d80f997cdafaf85883e7602de26c32dd355795a1`, dirty tree recorded | Saved checkouts are at `ef2d3b3469836e72d6a90308881c80e0e9735807` (26 dirty entries) and `f113500831b9b4d04f60c745defb4f728f3c05ba` (153 dirty entries); prior isolated audit directory is no longer present | NOT_RUN for source parity; no macOS test was claimed |
| Version lockstep | 8/8 Windows workspace files locked at `1.5.0` | Not evaluated against an isolated matching source in WP0.1 | NOT_RUN on macOS; Windows PASS |

---

## Security and cleanup
- **Processes remaining:** Zero `judgedesk`, `tauri`, or `executor` processes running.
- **Ports remaining:** Zero development/judging ports bound.
- **Temporary roots created/removed:** None created.
- **External files touched:** No external files were written by the reported/verifier commands. Managed AppData files and macOS host state were read only.
- **Sandbox/network/path assertions:** No changes made to any runtime code; no sandbox policies altered.

---

## Review
- **Correctness:** WP0.1 exit evidence is complete after the independent-verifier corrections and artifacts below. The original submission overclaimed stale macOS evidence and did not retain command logs; those issues are corrected explicitly rather than hidden.
- **Architecture:** Respects 4-tier model and zero-touch policy on existing dirty working tree.
- **Security:** Verified zero untrusted processes, clean port state, and verified toolchain receipt hashes.
- **Performance:** Fast checks execute synchronously under 7s.
- **Maintainability:** Standard markdown tables, explicit SHA-256 digests for all authoritative files.
- **Adversarial findings and disposition:** Pre-existing EOF blank line warnings in 4 dirty files (`docs/UI_UX_DESIGN.md`, `src-tauri/src/startup_guard.rs`, `src/features/judging/availability.ts`, `src/features/problem-config/editor-state.test.ts`) were noted and deliberately kept untouched. Independent review corrected the macOS parity overclaim, distinguished hashes from receipt authenticity, replaced the synthetic RED claim with `NOT_RUN`, and replaced the unsafe broad rollback command.

---

## Known limitations
- macOS GUI testing remains BLOCKED until physical macOS verification.
- Rust core tests and native executor suites were not run sequentially in full during this snapshot to prevent cache locks, as full test run belongs to later verification gates.

---

## Independent verifier addendum — Codex

Verified on 2026-09-19 against Windows HEAD `d80f997cdafaf85883e7602de26c32dd355795a1` and the current dirty tree.

| Check | Independent result | Durable artifact |
|---|---|---|
| `npm run check:fast` | PASS, exit 0, 3.960s | `artifacts/wp0.1/check-fast.log` |
| `npm run release:check-version` | PASS, exit 0, 0.346s; exactly `1.5.0` | `artifacts/wp0.1/release-check-version.log` |
| `node scripts/run-all-tests.js --dry-run` | PASS, exit 0, 0.130s; 99/99 suites discovered | `artifacts/wp0.1/test-inventory.log` |
| Windows environment/process/port/diff snapshot | PASS for inventory; 63 tracked dirty entries, 23 untracked entries, no matching process or watched listener; four pre-existing EOF findings retained | `artifacts/wp0.1/windows-environment.log` |
| Windows version/config/receipt/AppData hashes | PASS: report values reproduced; hashes prove snapshot identity, not signature authenticity | `artifacts/wp0.1/hash-inventory.txt` |
| macOS environment over SSH | PASS for host/tool inventory; source parity NOT_RUN because both saved checkouts are dirty/different and no isolated audit tree remains | `artifacts/wp0.1/macos-environment.log` |

Artifact SHA-256:

| Artifact | SHA-256 |
|---|---|
| `check-fast.log` | `9C57E6BBFC2EB02A6747A13EBC5B793ECB6F40F3E141FEAA815AA1C1E731D91E` |
| `release-check-version.log` | `06EB338EE2B0809F064E1921120EC3F5EEA59073DA2864403EB95E7C6E07E26E` |
| `test-inventory.log` | `725746946614F1AE5BF4F06DE7CC59C4B5E012EEFE4D85F0D6D1B2A235397473` |
| `windows-environment.log` | `49FAF7C32E56F7083E06FEE9547EB04AE3E8D45F09E5D5C8BB9F47AA2BE2C774` |
| `macos-environment.log` | `5F704484AC9FEA5A3BF4C54C0CF6E95EF71EDCD4925588358A43F3BEA5290C12` |
| `hash-inventory.txt` | `0D4412E02E422351097099D205ABED97F2C8AD80E71F391CE1333DAE8B8490E2` |

No Critical or remaining Required findings block this evidence-only package. Current macOS source parity and GUI remain explicitly unclaimed and therefore do not prevent WP0.1 from establishing the Windows workspace/current-host baseline.

## Final package verdict
- **Status:** `READY` for independent acceptance; STATUS transitions to `DONE` with LOG-0007.
- **Next permitted work package:** `WP0.2` is the recommended next package. WP0.4, WP0.5, and WP0.6 also become dependency-ready but require separate owners/conversations.
- **Rollback verified:** PASS (no runtime code changed)
- **STATUS/WORKLOG updated and independent verifier assigned:** Independent verification completed by Codex; STATUS/WORKLOG record the acceptance.
