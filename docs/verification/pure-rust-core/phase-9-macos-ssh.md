# Phase 9 (`V9.3`) — macOS Automated SSH, Platform & Packaged Bundle Verification Matrix

- **Work Package:** `V9.3` (batched in Macro-Milestone `M4`: `V9.1` $\rightarrow$ `G10`)
- **Candidate:** `m4-candidate01`
- **Remediation Round:** `antigravity-m4-remediator-20261019T054300Z`
- **Target Host:** `judgedesk-mac` (`macOS arm64`, Apple Silicon, `/private/tmp/jd-rust-core-mac-dev`)
- **Canonical Milestone Gate Report:** [`m4-desktop-release-and-cutover-gate.md`](m4-desktop-release-and-cutover-gate.md)
- **Artifact & Digest Binding:** Exclusively bound in [`artifacts/m4/antigravity-m4-remediator-20261019T054300Z/evidence-final-manifest.json`](artifacts/m4/antigravity-m4-remediator-20261019T054300Z/evidence-final-manifest.json) under the JSON-Only Hash Binding rule.

---

## 1. Synchronized Source & Packaged Bundle Verification on `judgedesk-mac`

1. **Source & Lockstep Synchronization:**
   - All `M4` source files (`crates/judgedesk-core`, `src-tauri`, `native-executor`, `scripts/`, and the 8-file + core crate `1.6.0` version lockstep) were synchronized to `/private/tmp/jd-rust-core-mac-dev` on `judgedesk-mac`.
   - `step9_10_cutover_and_release_test` (`EXPECTED_RED` $\rightarrow$ `GREEN`) passed on `judgedesk-mac` (`logs/mac-tdd-red-m4.log`, `logs/mac-tdd-green-m4.log`), verifying:
     - `v1.6.0` 8-file + core crate version lockstep (`verify_release_version_lockstep`).
     - Default embedded Pure Rust Native Core startup (`backend = "rust"`, `appVersion = "1.6.0"`), `judgedesk-executor` child PID registration (`Some(pid)`), and clean shutdown drain.
     - Explicit `JUDGEDESK_PURE_RUST_CORE=0|false` rollback policy and fail-closed rejection of invalid `JUDGEDESK_PURE_RUST_CORE` values.
2. **Bundled Resource & Header Resolution (`WP2.7` / `V9.3`):**
   - `crates/judgedesk-core/src/toolchains/pch.rs::find_bundled_compat_stdcxx_header` resolves `<exe_dir>/../Resources/compiler-compat/include/bits/stdc++.h` inside `JudgeDesk.app` (as well as `THEMIS_RESOURCE_DIR`) with an embedded `include_bytes!` fallback in `compiler.rs`.
   - `crates/judgedesk-core/src/engine/compiler.rs::compile_checker_with_executor` resolves `testlib.h` from the problem directory, `THEMIS_RESOURCE_DIR/judgers/testlib.h`, or an embedded `include_bytes!` fallback so packaged `JudgeDesk.app` custom checker compilation succeeds regardless of process working directory.

---

## 2. macOS Automated Platform & Package Gate Matrix (`V9.3`)

| Gate / Check | Command / Script | Evidence Log | Result |
| :--- | :--- | :--- | :--- |
| **TDD `RED` $\rightarrow$ `GREEN` (`step9_10_cutover_and_release_test`)** | `cargo test --locked --manifest-path crates/judgedesk-core/Cargo.toml --test step9_10_cutover_and_release_test` | `logs/mac-tdd-red-m4.log`, `logs/mac-tdd-green-m4.log` | **PASS** |
| **Rust Format & Clippy Gate** | `cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings` | `logs/mac-clippy.log` | **PASS** |
| **Fast Type & Quality Gate** | `npm run check:fast` | `logs/mac-check-fast.log` | **PASS** |
| **8-File Version Lockstep (`1.6.0`)** | `npm run release:check-version` | `logs/mac-release-check-version.log` | **PASS** |
| **Pure-Rust Core & Native Executor Suite** | `npm run test:rust && cargo test --locked --manifest-path native-executor/Cargo.toml` | `logs/mac-test-rust.log` | **PASS** |
| **macOS Seatbelt Sandbox Security Gate** | `npm run test:security` | `logs/mac-test-security.log` | **PASS** |
| **HTTP/SSE Contract Parity (`30/30` Rust & Node)** | `npx tsx scripts/check-contract-parity.ts --adapter=rust` & `--adapter=node` | `logs/mac-contract-parity-rust.log`, `logs/mac-contract-parity-node.log` | **PASS** |
| **macOS Packaged Bundle & Supervisor Verification** | `npm run verify:macos:local`, `scripts/macos-process-supervisor-gate.sh`, `scripts/macos-packaged-checker-gate.mjs` | `logs/mac-verify-bundle.log`, `logs/mac-process-supervisor-gate.log`, `logs/mac-packaged-checker-gate.log` | **PASS** |
| **Complete Server & Quality Gate** | `npm run check:full` | `logs/mac-check-full.log` | **PASS** |
| **Immediate & 10s Delayed Process Drains** | `python run_mac_cmd.py --drains` | `logs/mac-process-drain-immediate.json`, `logs/mac-process-drain-delayed-10s.json` | **PASS (`0` orphans)** |
| **Protected-Root Preservation (`before` vs `after`)** | `python audit_protected_state.py after && python audit_protected_state.py compare` | `mac-protected-roots-before.json`, `mac-protected-roots-after.json`, `protected-after-comparison.json` | **PASS (`100%`)** |
