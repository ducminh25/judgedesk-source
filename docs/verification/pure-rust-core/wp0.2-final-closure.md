# WP0.2 Final Closure Review

> **Timestamp:** 2026-09-21T20:13:16+07:00  
> **Workspace:** `D:\Minh\Code\judgedesk`  
> **HEAD:** `d80f997cdafaf85883e7602de26c32dd355795a1` plus the preserved shared dirty tree  
> **Scope:** WP0.2 only; no WP0.3 implementation  
> **Verdict:** `DONE`

## Review provenance

The first phase of this run was an independent review of the Antigravity Round 8 submission. It reproduced the submitted evidence and found additional actionable defects. The user then explicitly authorized remediation in the same saved checkout followed by a complete rerun. Therefore, the pre-remediation findings below are independent evidence; the final post-remediation result is owner verification plus a fresh-context, same-model adversarial review, not a claim that the remediation owner independently approved its own edits.

WP0.2's exit criterion is an executable contract matrix in which every frontend-used endpoint has a row and an automated assertion. It does not require the later Rust implementation phases to have achieved endpoint parity. Accordingly, Rust strict parity at 9/30 and exit 1 is recorded as a real expected mismatch signal, never as a passing command. The report-only command exits 0 and preserves all 21 documented gaps for later work packages.

## Findings remediated in this run

1. **Production Node executor honored a test-only root.** `ExecutorClient.getEnvironment()` redirected standard AppData variables when `JUDGEDESK_EXECUTOR_TEST_ROOT` was present, even in production mode. A RED production-mode regression reproduced directory creation and redirection. The production client now forwards only its explicit/current environment; the test-only override is absent from production Node and Native sources and the rebuilt staged binary.
2. **Native and Node test isolation was not structural.** Native unit initialization now creates its own marked `jd_test_executor_*` root under `#[cfg(test)]`, ignores caller-controlled test-root overrides, and performs fail-closed cleanup. The test runner requires the exact ownership marker and no longer exports a production-consumed executor override.
3. **Workspace stale-quarantine cleanup failed open.** Sweep read/removal failures and residual paths now reject. A RED regression first proved the swallowed failure, then passed after the minimal fix.
4. **Rust route inventory was formatting-sensitive.** `cargo fmt` exposed that the line-based scanner lost 11 multiline Axum declarations. `scanRustRoutes` now parses balanced `.route(...)` calls independent of formatting. Two final inventory runs are byte-identical.
5. **Rust quality gates were not clean.** The pinned toolchain lacked clippy; the standard component was installed. Behavior-preserving iterator, parameter-struct, handle-struct, and boxed-response refactors removed all 13 clippy errors without suppression. Both Rust packages are `fmt --check` and `clippy -D warnings` clean.
6. **The standalone security suite wrote real Executor AppData.** A content snapshot caught a new executor artifact and replacement startup probe after the first security run. The suite now provisions a marked owned Windows root through standard `LOCALAPPDATA`/`APPDATA`/`TEMP` variables, copies the managed Python package into that root so hostile AppContainer coverage remains active, removes the root fail-closed, and directly compares the real Executor tree before/after. The focused Python/cancellation rerun and full 17-test security rerun passed without host mutation.
7. **macOS security static test followed an obsolete source location.** The assertions were retained unchanged but now inspect `native-executor/src/security_probe.rs`, where the probe was decomposed. No security assertion was removed or weakened.
8. **Production-safe cleanup and response representation.** Native `before_create` failures now propagate; process-spawn handles were grouped to satisfy clippy; the large interactive response payload is boxed with unchanged serde wire output; test cleanup failures are no longer ignored.
9. **Rust core integration tests still reached real Executor AppData.** The final evidence-ordering rerun caught `crates/judgedesk-core` integration binaries constructing Native `Platform`/`AppState` as a normal dependency, where Native `#[cfg(test)]` isolation does not apply. A RED confinement regression was added first. The core integration harness now owns a uniquely named, exactly marked root, temporarily redirects only the standard AppData/TEMP variables while the platform is constructed, restores the host environment immediately, serializes the environment boundary, and removes the owned root fail-closed. API-contract, server, diagnostic, and engine integration tests all use this boundary. Production code and binaries have no new test override.

## Verification matrix

| Command / probe | Root | Result | Exit |
|---|---|---:|---:|
| Production-mode `ExecutorClient` override regression (RED) | verifier-owned temp root | 12/13; reproduced AppData redirection | 1 |
| Production-mode override regression (GREEN) | verifier-owned temp root | 13/13 | 0 |
| `node scripts/run-all-tests.js --filter=api-contracts.test.ts` | runner-owned marked AppData | 48/48, 0 skipped | 0 |
| `node scripts/check-api-contracts.js` twice | repository | 29 manifest / 33 callers / 29 Node / 29 Rust, stable | 0 / 0 |
| `node --import tsx scripts/check-contract-parity.ts --adapter=node` | isolated contract root | 30/30, 0 mismatches | 0 |
| `node --import tsx scripts/check-contract-parity.ts --adapter=rust` | isolated contract root | 9/30, 21 documented later-phase gaps | 1 (expected strict failure) |
| `node --import tsx scripts/check-contract-parity.ts --adapter=rust --report-only` | isolated contract root | 9/30 report emitted | 0 |
| `cargo test --locked --manifest-path crates/judgedesk-core/Cargo.toml -- --test-threads=1` | test-owned roots | 39 core unit/integration tests passed; doc tests clean | 0 |
| `cargo test --locked --manifest-path native-executor/Cargo.toml` (two final runs) | internally owned marked roots | 56 library + 3 binary tests per run | 0 / 0 |
| Rust core and Native `cargo fmt -- --check` | repository | clean | 0 / 0 |
| Rust core `cargo clippy --locked --tests -- -D warnings` and Native `cargo clippy --locked -- -D warnings` | repository | clean, no suppression | 0 / 0 |
| `npm run test:security` after isolation fix | owned marked Windows root | 16 pass, 0 fail, 1 macOS-only skip | 0 |
| `npm run check:fast` | repository | TypeScript and quality gate clean | 0 |
| `npm run test:server` | runner-owned marked AppData | 583 pass, 0 fail, 10 pre-existing environment/privilege skips | 0 |
| `npm run check:full` | runner-owned marked AppData | fast + server + version gates passed | 0 |
| `npm run release:check-version` | repository | all eight files at 1.5.0 | 0 |
| `npm run build:executor` | repository | release binary staged | 0 |

The focused contract run deliberately printed malformed-JSON and oversized-payload error stacks as exercised negative paths; stderr was not hidden and all assertions passed.

## Deterministic inventory

- Manifest routes: **29**
- Frontend callers: **33**
- Node routes: **29**
- Rust routes: **29**
- Inventory SHA-256, run 1 and run 2: `F76EE7266FCBDE85CCD452127B888BAF247516BFE5EB72611CC85BC78508806C`
- Matrix SHA-256: `96B7786278759568A3E88F5972169A1EE3291BFE920711C9CEDE8DE51E7EA026`

## Host-state evidence

### Initial review boundary and discovered mutation

The first trustworthy snapshot comparison showed `ThemisV2` unchanged but proved that the standalone security suite had written real Executor AppData:

- `ThemisV2`: 18,556 entries, aggregate `9467EF13BB9F66851EBAFF0DA00CB605F8E077D9DB4E26B173EC5A17BA206ADC` before and after.
- `JudgeDeskExecutor`: 8,429 entries / aggregate `D29D3ED4E51D4839239E5CA56FC2D0BE33C58747ACCD2E0EB9A6B0C5AA5DEE70` before; 8,430 entries / aggregate `A2B2FEE22EC79123B14F065C2BE183AB85D4E9A70C63C0286624687177625FD8` after.
- Exact delta: new `artifacts/efb273cd...c016.exe`, updated `workspaces/startup_self_test/probe.exe`, and updated `probe.stderr`.

No content was fabricated or rewritten to force the historical hashes to match. The code path was remediated and a new post-remediation baseline was taken.

### Post-isolation-fix preservation proof

After the focused and complete isolated security runs plus final checks:

- `ThemisV2`: 17,730 files / 826 directories / 18,556 entries; aggregate before = after = `9467EF13BB9F66851EBAFF0DA00CB605F8E077D9DB4E26B173EC5A17BA206ADC`; entry diff 0.
- `JudgeDeskExecutor`: 7,734 files / 696 directories / 8,430 entries; aggregate before = after = `A2B2FEE22EC79123B14F065C2BE183AB85D4E9A70C63C0286624687177625FD8`; entry diff 0.
- Semantic-state hashes before/after: Themis `DB044A945F3BB520C265A70BB38E542E8B91EE11A830AE1987DC4B8DB3E1FC38`; Executor `7D00859A79D21213AD8481238E55F67547F56B6C329DFAB7D76F1DBBFA189A76`.
- `toolchain-discovery-v2.json`: raw SHA-256 `5C0AA69EA06E3C08D4529D6EFA8E584DF04310EF610B2C08AAB3418BEB6459F1`; canonical semantic SHA-256 `2F569CFCE9F0086074DFB529434CD833F6DAD16269288DB1B3A85D44E6F0FBC5`; unchanged.

## Cleanup and Defender audit

After a 10-second delayed-output window: 0 verifier-owned temp roots, 0 relevant child processes, 0 listening test ports, and 0 Excel processes. The previously orphaned submitter focused-test process tree and five stale temp roots were identified, recorded, and removed before final verification.

Microsoft Defender had four existing `Trojan:Win32/Bearfoos.A!ml` heuristic detections involving unsigned executor/probe binaries before the final build boundary. Defender still reported four afterward: **0 new detections** during the final builds and isolated suites. The staged binary is unsigned, 920,576 bytes, SHA-256 `EFB273CD2AEB300699BF43ECCE4FC74E92BD2694F9A0B4031B906DD8CE86C016`, and does not contain `JUDGEDESK_EXECUTOR_TEST_ROOT`. No exclusion was created or changed during this review. This evidence supports a heuristic/unsigned-binary risk, but does not independently prove the file is a false positive.

## Residual risks and scope limits

- Rust endpoint parity remains 9/30 by design at this Phase 0 contract-inventory boundary. The 21 mismatches remain visible and must be implemented in later work packages.
- The current verification is Windows-specific. macOS-only runtime execution was not performed in this checkout; static macOS security contracts and cross-platform Rust compilation/tests remained green where runnable.
- Defender reputation/signing remains a release-hardening concern outside the WP0.2 contract-inventory exit criterion.
- The shared tree remains intentionally dirty with work from multiple packages. No unrelated work was reset, stashed, reverted, or overwritten.

## State transition

- `WP0.2`: `VERIFYING` -> `DONE`
- `WP0.3`: `NOT_READY` -> `READY`
- No WP0.3 implementation was started.

All raw logs, before/after snapshots, Defender records, cleanup audit, inventory copies, and process evidence are under `docs/verification/pure-rust-core/artifacts/wp0.2/independent-post-round8/`.

## Definitive current-checkout closure boundary

The first attempted final boundary was intentionally rejected after it exposed additional host mutation. During that attempt the real Executor tree lost `artifacts/efb273cd...c016.exe` and regenerated the three `workspaces/startup_self_test/probe.*` files. A narrower Rust-core proof then exposed the remaining API-contract integration path. No historical bytes were recreated to force a match. The integration harness was remediated, the new confinement regression went RED then GREEN, and every relevant gate was rerun from a new baseline.

The definitive post-fix boundary is `final-closure-before/` versus `final-closure-after/`:

- `ThemisV2`: 17,730 files / 826 directories / 18,556 entries; aggregate before = after = `9467EF13BB9F66851EBAFF0DA00CB605F8E077D9DB4E26B173EC5A17BA206ADC`; entry diff 0; semantic snapshot SHA-256 before = after = `DB044A945F3BB520C265A70BB38E542E8B91EE11A830AE1987DC4B8DB3E1FC38`.
- `JudgeDeskExecutor`: 7,733 files / 696 directories / 8,429 entries; aggregate before = after = `91A0B977D8F4A4B48D1CD2E5BF21C61B154DC58A417EBB8A205D8AF3B88C71F3`; entry diff 0; semantic snapshot SHA-256 before = after = `7D00859A79D21213AD8481238E55F67547F56B6C329DFAB7D76F1DBBFA189A76`.
- `toolchain-discovery-v2.json`: raw SHA-256 `5C0AA69EA06E3C08D4529D6EFA8E584DF04310EF610B2C08AAB3418BEB6459F1`, unchanged; its canonical semantic hash remains `2F569CFCE9F0086074DFB529434CD833F6DAD16269288DB1B3A85D44E6F0FBC5`.
- After a 10-second observation: 0 verifier-owned temp roots, 0 relevant processes, 0 relevant listening ports, and 0 Excel processes. Six unmarked `jd_test_core_executor_*` directories timestamped 08:43 or 14:57 predate the final boundary and were not treated as owned or deleted.
- Defender reported the same four existing heuristic detections before and after the final boundary; no new detection appeared.

Final gates on the exact source state were: stable inventory `29/33/29/29`; focused contracts `48/48`; Node parity `30/30`; Rust strict parity `9/30`, exit 1; Rust report-only exit 0; Rust core 39 tests; Native `56 + 3` twice; security `16` pass, `0` fail, `1` macOS-only skip; `check:fast` exit 0; `check:full` exit 0 with server `583/0/10`; and version lockstep `1.5.0`.
