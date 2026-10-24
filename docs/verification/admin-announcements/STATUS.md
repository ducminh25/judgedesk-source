# Admin announcements — Implementation status

Updated: 2026-10-24. Reference: [Implementation Plan](../../admin-announcements-implementation-plan.md).

## Current update — owner public key and manual signing approval

Owner-supplied `announcements-v1` is now pinned in `shared/announcements-trust.json`; raw public-key SHA-256 `77b1610dfaef5f7a5d09c9e698cdc329b28708cf1880360669ea838381dce195`. Canonical 32-byte base64 and Node Ed25519 public import/round-trip pass; production trust rejects the golden test signer even under the production key ID. **Full gate for this trust-bearing source PASS, exit 0** (`artifacts/check-full-production-trust.log`): 9/9 Rust, server 1,196 tests / 1,186 passed / zero failed / ten existing skips, four checker tiers and version lock 1.6.0. Eleven focused trust/signature tests, TypeScript/quality and executor receipt preflight also pass. Older complete passes below certify their earlier trust configuration.

Owner chose manual approval before each signing job. Created/read back `announcements-signing` in the public distribution repository: reviewer `ducminh25`, only branch `main`, public key-ID variable set. Owner may approve a run they initiated, preserving explicit manual approval. No private key was read/uploaded by the agent; the environment currently has no signing secret. No workflow/content/Pages deployment or main branch protection was changed. Owner selected keeping the source local and personally committing/pushing it; no publisher branch, commit, push or PR is to be created by the agent. Pinning waits for the owner's actual pushed full 40-hex source SHA.

Earlier unconfigured-service runtime evidence below is historical. Linux all-targets Clippy/49 announcement tests pass. **Both Windows WebView2 and Linux WebKitGTK pass configured-key native initialization plus eight UI combinations** on new isolated data/browser profiles; explicit reports are in `native-webview-results.json`. The QA harness initially expected revision zero; the existing store starts at one, and the corrected strict assertion passes. Fixture rendering does not prove live production feed delivery.

Current integrated source: native service/IPC, bounded authenticated storage/media cache, bell/popover/article UI, publisher and staged Pages workflow are implemented. **Integrated `check:full` PASS, exit 0:** 9/9 Rust; server 1,194 tests / 1,184 passed / zero failed / ten existing conditional skips; 67 static checker fixtures across Node/Rust/C++/packaged Windows; version lock 1.6.0. This was one complete normal invocation on frozen production source. No production key or remote deployment has been provisioned. No compiler fallback, isolation change, quality relaxation or version bump was made.

Final native app inspection exposed an empty-panel focus defect. A regression test failed before the fix; focus now skips disabled header actions and temporarily rests on the panel if all actions are disabled during initial loading. The strengthened regression and both native engines pass. **The final complete gate after that fix also passed, exit 0** (`artifacts/check-full-announcements-focus-final.log`): 9/9 Rust, 1,184/1,194 server tests with zero failures and ten existing skips, all checker tiers and version lock 1.6.0.

## Current slice

- P0: approved dependency/API spikes complete; native IPC/TLS/decoder evidence recorded. HTTP 404 does not establish feed readiness. Key custody/public key and manual signing choice are resolved; production bootstrap, resource acceptance and macOS evidence remain open.
- P1: contracts, strict Node/Rust validation, signature vectors, shared metadata corpus, DOM sanitizer, publisher/native image fixtures implemented and tested.
- P2: store/history/crash recovery/process lease, typed cache failures, pinned cache GC and bounded media LRU implemented. Windows and Linux native suites pass. Physical disk-full and packaged filesystem acceptance remain separate.
- P3: native service and IPC connected. Production trust now pins the owner-approved public key, without any test-key fallback.
- P4–P5: Help–bell–Donate, badge, panel/actions/menu, article modal, read persistence, expiry, focus/keyboard, VI/EN and light/dark implemented. Eight Windows WebView2 and eight Linux WebKitGTK layout/language/theme combinations pass. The first Linux rerun timed out because its local static server had stopped during idle; the prerequisite was restored and a separate explicit successful report was obtained.
- P6: deterministic HTML/media publisher, permanent UID catalog, baseline/revision guard, isolated signer, pinned staged workflow and [Admin guide](../../admin-announcements-publishing.md) implemented; focused tests pass. No active remote workflow is claimed.
- P7: integrated Windows gate passed. Focused Node 194/194 and Windows native 50/50 pass; Linux native 49/49 and all-targets Clippy pass. macOS WKWebView and all ten installed-package cells remain pending; see [platform acceptance](PLATFORM-ACCEPTANCE.md).
- P8: owner retains private key; public key received/pinned; manual-approval signing environment created/read back. Private-key secret, reviewed source pin, remaining branch/Pages policy and real bootstrap/smoke remain pending. No remote content was published.

## Latest evidence (integrated source)

| Evidence | Result / scope |
| --- | --- |
| `artifacts/focused-final-integrated.log` | 194 Node tests passed; zero failed/skipped |
| `artifacts/304-corrupt-green.log` | 50 Windows announcement tests passed; zero ignored; 24 unrelated filtered; Clippy clean |
| `artifacts/linux-final-integrated.log` | Linux all-targets Clippy clean; 49 announcement tests passed; zero ignored; 22 unrelated filtered. Subsequent GUI timeout is a failed QA attempt, irrespective of wrapper exit status. |
| `artifacts/windows-webview-qa-eight-states.log` | Actual WebView2: normal/narrow × VI/EN × light/dark; binary IPC, PNG blob, focus/inert/Escape, panel bounds. Fixture feed, not production end-to-end. |
| `artifacts/linux-webview-qa.log` | Earlier actual WebKitGTK four language/theme combinations passed; not the latest eight-state acceptance |
| `artifacts/linux-webview-qa-eight-states.log` | Actual WebKitGTK explicit `passed: true`, eight combinations, binary IPC/native PNG, menu keys/Escape, focus/inert and viewport bounds; fixture feed |
| `artifacts/linux-https-probe.log` | Native production HTTPS transport/TLS passed; endpoint 404; feed readiness false |
| `artifacts/windows-https-probe-manifest.log` | Windows native production HTTPS transport/TLS passed after linking the QA example with its Common Controls manifest; endpoint 404; feed readiness false |
| `artifacts/windows-media-release-provenance.log` | Canonical local provenance and packager prerequisites passed; release-profile decoder test passed. No installer/release created. |
| `artifacts/windows-media-memory-release.json` | Sampled test-process peak working set 136,683,520 bytes; 12MP reference corpus. Decoder `max_alloc` is best effort, not an OS-enforced 64MiB RSS quota. |
| `artifacts/check-full-announcements-integrated.log` | PASS, exit 0: 9/9 Rust; server 1,194 / 1,184 pass / zero fail / ten existing skips; checker parity and version passed |
| `artifacts/check-full-announcements-focus-final.log` | Final source after native inspection/focus fix: one complete normal invocation PASS with the same counts; TypeScript/quality, all Rust stages, server, checker parity and version included |
| `artifacts/check-fast-integrated-final.log` | PASS: TypeScript and quality invariants |
| `native-webview-results.json` | Parsed explicit native reports; checked eight required combinations for each host |
| `artifacts/{windows,linux}-webview-qa-focus-fresh-profile.log` | Final UI: both native engines pass eight combinations plus empty-panel enabled-action focus; separate QA profiles avoid persisted WebView HTML cache |
| `artifacts/windows-desktop-focus-final.log`, `artifacts/native-app-empty-focus-final.png` | Canonical dev app restarted with isolated QA browser profile. Bell respects sibling changelog dialog; after closing it, Enter activates panel Reload (loading state observed), unconfigured error stays local, Escape closes panel and app remains Ready. No production feed claimed. |

Historical entries below preserve the original scope and failures at the time they occurred; their implementation descriptions are superseded by the current slice above.

## Implemented

- `shared/announcements.ts`: wire DTOs, format/domain constants and resource limits. No Node/native runtime imports.
- `shared/announcements.schema.json`: strict shape, closed objects, safe integer bounds, required VI, optional EN, JPG/PNG metadata and bounded collections.
- `scripts/announcements/validate-payload.ts`: non-mutating Ajv validation using the existing dependency, real UTC instants, well-formed Unicode/UTF-8 byte caps, UID/image/link uniqueness, thumbnail roles and exact link scope.
- `scripts/announcements/signatures.ts`: opaque byte signing/verification through node:crypto, fixed domain/key binding, canonical base64 and explicit trusted public-key map. This is not a raw JSON parser, schema validator or HTML sanitizer.
- `shared/test-fixtures/announcements/signed-feed.json`: one committed public test vector. The ephemeral private key was never saved. Nothing in production configuration trusts this test key.
- 16 focused tests including mutations, Unicode, collection/byte boundaries, independent verification of the fixture, wrong keys/domains and tampering.
- `src-tauri/src/announcements/{mod,verify,verify_tests}.rs`: bounded raw-envelope parsing and ring Ed25519 verification. Rejects duplicates (including escaped field aliases), positional arrays, unknown fields, malformed UTF-8/BOM, noncanonical base64, wrong keys/domains and changed bytes. Returns opaque bytes requiring separate payload validation/sanitization. Exported from the Tauri library; no command/startup path invokes it yet.
- Nine Rust tests pass against the same source files in an isolated Linux harness using the app's locked crate versions; Clippy passes with `-D warnings`. The Node golden signature and SHA-256 match. This is module evidence, not a complete Tauri build or packaged-app test. See [reproduction and review](NATIVE-VERIFIER.md).
- After the user installed Build Tools 2022, the normal Tauri Windows test build succeeded and all nine announcement tests passed (24 unrelated library tests filtered by the focused command). Full-gate results are tracked separately below.
- Rust gate diagnostics now print bounded stdout/stderr separately for every failed stage and retain both in failed JSON records. The old combined 25-line tail hid Rust assertions behind later Cargo stderr. Three regression tests cover assertion visibility, bounded evidence/nonzero exits and compact success output; existing gate-policy tests remain unchanged.
- `src-tauri/src/announcements/{de,limits,model,model_tests}.rs`: bounded metadata parsing/validation, typed wire DTOs and object-only nested deserialization. Shared corpus covers 154 common cases and compares accepted values with Node, plus native raw duplicate-key tests. Test-discovered numeric divergence was fixed by enabling existing serde_json `float_roundtrip`; no crate version changed. See [metadata boundary review](METADATA-VALIDATION.md).
- `src-tauri/src/announcements/{store,store_state,store_io,store_tests}.rs`: process lease, bounded private state schema/history, authenticated immutable cache and atomic commit boundary. Sixteen store tests cover history, failure, concurrency, size and restart. See [persistence review](PERSISTENCE.md).
- Six explicitly approved direct packages installed with a reviewed minimal graph. `dependency_tests.rs` adds three native API probes; an ignored strict TS/runtime DOM probe and frontend build passed. These do not replace live native transport/decoder/IPC/WebView acceptance; see [dependency evidence](REMAINING-DEPENDENCIES.md).

## Verification

| Command | Result |
| --- | --- |
| `npm run check:fast` before edits | PASS |
| Focused announcement tests, RED | Expected missing implementation modules; 2 failing test files |
| Focused announcement tests, latest | PASS, 16 tests, 0 skipped |
| `npm run check:fast` after implementation | PASS, including final typed-schema cleanup |
| Strict TypeScript check scoped to the five new TS files | PASS (`--strict`; no project compiler settings weakened) |
| `npm run corpus:check` | PASS |
| `npm run release:check-version` | PASS, 1.6.0; no version bump |
| `npm run check:full` | FAIL in Rust gate: core lacks link.exe; Tauri lacks RC.EXE. Executor fmt/clippy/test and all three fmt steps passed. Server/parity stages were not reached. |
| `npm run test:server` | FAIL at build:executor because vswhere.exe is missing; did not run the server suite through this gate |
| `node scripts/run-all-tests.js` | FAIL: 145 files discovered; 1,013 tests, 1,001 passed, 2 failed, 10 existing skips. Both failures require building the Rust backend, which fails because link.exe is missing. Node reference golden parity passed 30/30. Not a substitute for build:executor or check:full. |
| Linux isolated verifier `cargo test --locked --offline` | PASS, 9 tests, zero ignored/filtered; Rust 1.97.1; same source and app-lock crate versions |
| Linux isolated verifier `cargo clippy --locked --offline --all-targets -- -D warnings` | PASS, no lint suppression |
| `npm run check:fast` and focused Node tests after native additions | PASS; 16 focused tests, zero skipped |
| `npm run check:full` after native additions | FAIL: Rust gate 5/9 steps passed; core and Tauri clippy/test stop because link.exe is missing. All fmt steps and executor clippy/test pass. |
| `npm run test:server` after native additions | FAIL before tests: vswhere.exe missing |
| Windows Tauri `cargo test --locked --manifest-path src-tauri/Cargo.toml announcements` after toolchain restoration | PASS, 9 announcement tests, zero failures/ignored, 24 unrelated library tests filtered; test-profile app compilation succeeded |
| `npm run check:full` after Windows toolchain restoration | FAIL: 8/9 Rust steps pass, including all fmt/Clippy and complete Tauri tests. Core test suite reports failure in step4_lifecycle_config_cancel_test; server/parity stages not reached. No missing-tool errors remain. |
| Core lifecycle diagnostic, complete six-test suite with `--test-threads=1 --nocapture` | PASS twice, 6/6 each, zero ignored/filtered; second run overlapped server verification. The initial aggregate failure has not been reproduced or explained; full gate is not labelled green. |
| `npm run test:server` after Windows toolchain restoration | PASS: executor release build and corpus preflight passed; 1,013 tests, 1,003 passed, zero failed, 10 existing conditional skips. Node and Rust API golden parity each passed 30/30. |
| `npm run test:themis-parity` after Windows toolchain restoration | PASS: 67 fixtures each on Node, compiled C++ and packaged Windows checkers; Rust checker suite passed; packaged source/binary SHA-256 checks passed. Static parity only, not the separate live Themis DLL oracle. |
| `npm run release:check-version` after Windows toolchain restoration | PASS, all version files remain at 1.6.0 |
| Focused Rust gate diagnostic and existing structural tests | PASS, 11 tests, zero skipped; existing timeout/overflow and policy mutation checks retained |
| New gate diagnostic regressions on Linux/WSL, Node 24.19.0 | PASS, 3 tests, zero skipped |
| Restore old 25-line logging in an ignored local mutant | Expected regression failure: stdout assertion is hidden again. Confirms the new test detects the actual diagnostic defect. |
| `npm run check:full` after gate diagnostic fix, latest | PASS, exit 0: 9/9 Rust steps; server 1,016 tests / 1,006 passed / 0 failed / 10 existing conditional skips; static checker parity passed; version 1.6.0 verified. This is one complete normal invocation, not a union of filtered reruns. |
| Metadata corpus RED | Acceptance/value comparison caught real default-parser divergence from Node at decimal safe-integer boundaries. |
| Focused Node announcement tests after metadata additions | PASS, 170 tests (154 corpus cases), zero skipped |
| Strict scoped TypeScript check including parity test | PASS, no compiler-setting changes |
| Windows Tauri metadata/verification tests and Clippy | PASS, 16 announcement tests, zero ignored; 24 unrelated library tests filtered; `-D warnings` clean |
| `npm run check:full` after metadata/float_roundtrip, latest | PASS, exit 0: 9/9 Rust steps; server 1,170 tests / 1,160 passed / 0 failed / 10 existing conditional skips; static checker parity passed on Node/Rust/C++/packaged Windows binaries; version 1.6.0 verified. |
| Additional core run with `--features serde_json/float_roundtrip` | PASS, 51 tests across library/API/discovery/rational/scoring/well-formed input targets; zero ignored/filtered. Verifies the feature used by core JSON readers inside the Tauri dependency graph. |
| P2 initial tests, RED | Store module absent before implementation |
| Missing nullable state fields, RED | Missing readAt was incorrectly treated as unread; required-nullable deserialization fixed the regression |
| Same-feed cache refetch, RED | Idempotent path skipped absent/corrupt blob checks; cache verification/restoration now runs even without a state change |
| P2 Windows focused tests/Clippy | PASS, 32 announcement tests (16 store), zero ignored, 24 unrelated library tests filtered; real process exits at three commit boundaries, cross-process lock, Windows junction/locked-file and exact 16 MiB growth refusal covered; `-D warnings` clean |
| `npm run check:full` after P2, before dependency installation | PASS, exit 0: 9/9 Rust; server 1,170 / 1,160 passed / 0 failed / 10 existing conditional skips; checker parity and version 1.6.0 passed |
| After approved dependency installation and baseline-edge preservation | PASS, 35 focused native tests / 0 ignored / 24 unrelated filtered; locked Clippy clean; strict DOM API probe and frontend build passed; no previously locked package version changed |
| Advisory checks after installation | npm audit: 0 reported vulnerabilities; OSV exact-version lookup: no advisory for six new Cargo versions. Not a full cargo-audit/RustSec scan. |
| Post-install `check:full`, before executor input revalidation | FAIL: 9/9 Rust pass; server 1,170 / 1,159 passed / 1 failed / 10 existing conditional skips. Sole failure is package.json raw hash against the old executor receipt; checker/version stages not reached. |
| Executor input/artifact revalidation | PASS: only package.json changed; 31 other raw inputs, binary SHA/size and native fingerprint unchanged; complete executor boundary suite 28/28 and original freeze tests 3/3 passed; fixed pins/inventory retained. |

Raw logs are local ignored artifacts under `artifacts/`. The earlier missing-tool errors above are historical. The user has now installed Build Tools 2022 17.14.42 with MSVC 14.44.35207 and Windows SDK 10.0.26100.0. Discovery found cl.exe, link.exe and rc.exe; the focused Windows Tauri test build passed inside the standard x64 developer environment. Cache was preserved and no gate was disabled.

## Next steps

1. Finish complete-gate verification of P2, then add the service/HTTP/IPC spikes before wiring this store to app startup. Preserve feature-local errors and use the canonical app-data root. Review [persistence guarantees and limits](PERSISTENCE.md).
2. Preserve the green normal gate and historical unexplained core failure. All 154 common metadata cases now compare acceptance and accepted values; keep those regressions and the gate diagnostic tests.
3. Keep the applied [dependency graph review](REMAINING-DEPENDENCIES.md) and baseline-edge preservation evidence; all six declarations are now approved/installed. Do not broaden provider/formats or upgrade unrelated dependencies in subsequent work.
4. Run actual native spikes for binary IPC, bounded HTTP/TLS and image decoder limits before starting persistence/UI integration.

Windows Node tests are evidence for this slice only. No macOS/Linux native QA or 10-package matrix is claimed.

## 2026-10-24 — dependency baseline gate complete

Normal `check:full` passed in one invocation after executor input revalidation: 9/9 Rust steps, server 1,170 / 1,160 passed / zero failed / ten existing conditional skips; all checker parity tiers and version 1.6.0 passed. Log: `artifacts/check-full-remaining-revalidated.log`. P3 starts after this baseline; this is not final acceptance of later code.
