# D15 language-profile registry checkpoint

Date: 2026-07-29

Branch: `judgedesk/d15-language-profile-registry`

Implementation and packaged-gate commit: `a26beb518a80a5edea4294607266d68b04204ad4`

This checkpoint completes the registry/storage/API/UI slice of D15 for the two
existing profiles only. It does not claim that D15 certification or the wider
multi-language foundation is complete, and it does not enable a new language.

## Delivered contract

- The internal registry exposes stable, versioned C++ and CPython profiles in a
  deterministic UI order. Adapter and policy identifiers remain declarative;
  a registry entry cannot inject a shell command.
- Preferences v2 stores one fixed source intent per profile:
  `none | managed | local_path | local_auto`. The reader migrates legacy
  C++/Python fields once, preserves dormant paths and unknown profile IDs, and
  fails closed without overwriting corrupt or future documents.
- Preference writes use canonical JSON, exact-byte SHA-256 revision checks,
  same-directory temporary files, `fsync`, atomic replacement and bounded CAS
  retry. A completed asynchronous download cannot overwrite a newer radio
  selection.
- First-run discovery is passive, asynchronous and persisted. It checks PATH
  plus bounded standard locations, canonicalizes candidates, rejects Windows
  network/device paths before I/O, never recursively scans a drive, and runs
  automatically only when no discovery snapshot exists. Rescan is explicit.
- macOS resolves Apple Clang through `xcrun --find clang++`, representing the
  currently selected Developer root rather than treating `/usr/bin` driver
  stubs and inactive Xcode/Command Line Tools roots as competing compilers.
  Distinct Homebrew/local compilers still produce an ambiguity that requires an
  explicit path choice.
- The API returns registry/profile/readiness/discovery state immediately while
  the remote managed-package manifest loads in the background. It never
  silently falls back to a different selected source.
- The same registry-driven table is used for first-run setup and later
  management. Every row has exactly four source radios, the three approved
  readiness labels, detected candidates, local browse/verify, managed
  download/apply, cancel and managed-only uninstall actions in English and
  Vietnamese.
- Preferences, rescan, install commit and uninstall fail with HTTP 409 while a
  judge session is active. The UI locks the corresponding controls. An install
  that finishes after the radio changed may remain installed but is not
  applied; uninstall keeps Managed intent and therefore becomes Not available
  instead of falling back.

## Verification evidence

Evidence is split deliberately: `779c81e` is the main registry/UI
implementation, `22f9343` is the macOS discovery-only identity correction, and
`a26beb5` changes only the packaged test harness before rebuilding the exact
bundle. Gates below state which boundary they exercise rather than implying
that an unrelated test was rerun after a test-only commit.

### Windows x64

- TypeScript lint: pass.
- Full server/frontend regression: 228 tests, 224 pass, 4 platform skips.
- Production frontend/native-executor/backend build on the main D15
  implementation: pass. The exact final application code was then rebuilt as
  part of the macOS packaged bundle.
- Native executor: 37 library + 3 binary tests pass; Rust format and strict
  Clippy pass.
- Security integration on the main D15 implementation: 16 tests, 15 pass, 1
  macOS-only skip. The 20-run
  wall-time and memory matrices, output/workspace/thread/process bombs,
  checker boundaries and cancel-drain all pass.
- Targeted registry/storage/discovery/resolver/routes/UI suite: 51 tests, 49
  pass, 2 Windows symlink skips.

The final macOS discovery adjustment has no Windows execution branch; the full
Windows server regression and lint were nevertheless rerun after that change
and retained 224 pass / 4 platform skips.

### macOS Apple Silicon

- Machine: real Apple Silicon (`arm64`), macOS 26.5.2, reached through the
  existing Tailscale/SSH test channel.
- TypeScript lint: pass.
- Full server/frontend regression on the main D15 implementation: 228 tests, 226
  pass, 2 Windows-only skips.
- Security integration on the main D15 implementation: 16 tests, 15 pass, 1
  Windows-only skip, including the
  20-run TLE/MLE boundaries, Seatbelt checker roles, process bomb and
  cancel-drain.
- Exact-commit local build: ARM64 `.app` and ad-hoc signed DMG pass deep
  codesign, JIT entitlement, authenticated sidecar startup/parent EOF, Apple
  Clang 17 detection and native secure-runner self-test.
- DMG:
  `/Users/mac/Code/judgedesk-gate-112fd48/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/JudgeDesk_1.2.7_aarch64.dmg`
- DMG SHA-256:
  `0f89c84575eeb6d76f19010365c095b27773992c27fc228eaab3ce2b70400584`
- Packaged gate: registry shape and four source modes pass; C++ submission and
  `testlib.h` checker pass; managed Python checker pass; active-batch mutation
  returns 409; cancellation drains before acknowledgement; uninstall pass.
- Final independent inventory: 0 JudgeDesk runtime process, 0 executor
  workspace, 0 Seatbelt profile and 0 packaged-gate fixture.

The user's working checkout at `~/Code/judgedesk` remained on `687bc22` with
its pre-existing changes untouched. All commands above ran from the detached
gate worktree.

## Deliberate remaining limits

- C++ and Python are the only live registry profiles. C, Pascal, Go, Java,
  Rust, Node.js and C# are not enabled by this checkpoint.
- Managed C++ on Windows, managed Python on both hosts and selected Apple Clang
  on macOS retain their previously proven readiness. Windows local C++ and
  local/system Python remain Not available until the certificate/snapshot
  pipeline exists; detection or a version string alone never makes them
  submission-ready or checker-ready.
- Manifest v2, immutable local snapshots, certificate persistence/fingerprint
  revalidation, full per-role certification, batch certificate leases,
  generic adapters/`PreparedProgram`, and language-specific conformance corpora
  remain later D15/Phase 1 work.
- The UI has production-build and server-rendered regression coverage for
  profile order, labels, exactly four radios, actions and locked state. A final
  human keyboard/focus/pixel review should still be performed before a public
  release candidate.
- This is a local ad-hoc DMG. CodeMagic, notarization, production updater
  signing and public release packaging were intentionally not run.
