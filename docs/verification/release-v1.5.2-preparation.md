# v1.5.2 source preparation

Date: 2026-10-05 (Asia/Bangkok). This checkpoint prepares the private source repository; it does not authorize a release workflow, tag, publication, or visibility change.

## Scope

- Synchronize the eight authoritative application/native version files at 1.5.2. The independent judgedesk-core crate remains 1.5.1. Cargo updates only the local package identities in all three lockfiles.
- The v1.5.2 changelog has one item: an input/output pair with the same base name counts as one test. Both in-app languages carry the same item.
- Preserve existing source, test, configuration, and documentation changes. Local verification artifacts (build caches, copied runtimes/toolchains, archived evidence) remain on disk outside version control. TypeScript excludes the copied artifact sources.
- Repair release-dependent tests and the Rust executor handshake by deriving the expected executor version from the native crate. All version, sandbox capability, path, SHA-256, size, and lifecycle rejection assertions remain enabled. API parity retains its existing normalized historical version fixture and adds 1.5.2 to the recognized release versions.

## Native candidate identity

Built from the current native source with Node 24.19.0, npm 11.17.0, Rust 1.97.1, and the existing locked release build script for x86_64-pc-windows-msvc. The staged candidate and release output have matching SHA-256 and byte size:

- SHA-256: FA6265A51AA52E0440DB2E5B3126099FE2D4D358AF2A909D3491E71CC5A2DFA9
- Size: 950784 bytes
- This explicitly refreshes the per-candidate Windows frozen identity pin for 1.5.2. Historical acceptance reports and their earlier pins remain unchanged. This binary is a local verification candidate, not a published release artifact.

## CodeMagic

CODEMAGIC_API_TOKEN is present in the local process environment. Read-only requests to the applications API and the app detail API returned HTTP 200. Application 6a59050a8f1abc95b83e8570 retains the old themis-v2-source display name/URL, but its repository ID 1298509087 matches ducminh25/judgedesk-source; GitHub redirects the old repository name to the current private repository. No CodeMagic API credential is configured as a GitHub repository secret. No credential value is included in this checkpoint.

## Verification

- Focused version/changelog tests: 16 passed, no failures/skips.
- Executor boundary tests after rebuild/staging: 27 passed, no failures/skips.
- Final npm run check:full: PASS. check:fast clean; locked Rust format/Clippy/tests passed all 9 steps; server suite 726 tests (716 pass, 0 fail, 10 existing registered platform/opt-in skips); static parity passed all four tiers (67 fixtures per applicable tier); release:check-version verified 1.5.2.
- npm run test:security on Windows: PASS, 17 tests (16 pass, 0 fail, 1 existing macOS-only skip). The suite verified owned-root cleanup and unchanged host executor state.
- The test harness also required rebuilding the stale standalone debug executor with cargo build --locked --manifest-path native-executor/Cargo.toml. The debug binary is used only by explicit test overrides; packaged boundary tests still require the release candidate and its frozen hash.
- Read-only dependency audit: 1 high and 3 moderate vulnerability entries (brace-expansion, qs and dependent express/body-parser). The high brace-expansion finding must be triaged/remediated before the actual release; this source-preparation checkpoint does not claim production launch readiness. Dependency versions were not changed by this preparation.

## Publication controls

The preparation commit uses [skip ci]. Push only HEAD to refs/heads/main with push.followTags=false. Do not create/push v1.5.2 or invoke workflow_dispatch. Keep ducminh25/judgedesk-source private and leave the distribution repository/releases untouched.
