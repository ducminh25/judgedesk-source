# D15 toolchain certification checkpoint

Date: 2026-07-30

Branch: `judgedesk/d15-toolchain-certification`

Implementation commit: `432f3aea19f22cfe68f83b1d4a1d8218f4fb719b`

Exact verification commit: `3ce2c902c1be0500aade0c67e9ace104e152e096`

This checkpoint completes the first certificate/snapshot/preflight slice of
D15. It makes explicitly selected local GNU C++ installations certifiable on
Windows x64. It does not enable another submission language and does not claim
that every local compiler/runtime is safe to use.

## Delivered contract

### Manifest v2 boundary

- Manifest v2 has a strict signed envelope and an Ed25519 signature over a
  deterministic canonical payload. Unknown/missing fields, duplicate package
  IDs, untrusted keys, malformed signatures, tampering, path traversal and
  invalid component/license metadata are rejected.
- A v2 package records its components, entrypoint component, compressed and
  installed sizes, SHA-256 digests, health-probe ID, upstream URL and license
  metadata. The signing key is deliberately separate from the Tauri updater
  key.
- The v1 reader remains for the currently published catalog. The production v2
  keyring is intentionally empty until a separate release key and signing
  procedure are provisioned. Therefore this checkpoint implements and tests
  the v2 verification boundary but does not claim that production downloads
  are already protected by a v2 signature.

### Certified local GNU C++ on Windows

- Certification is an explicit user action. Passive first-run discovery still
  only reports candidates and never copies or executes an arbitrary discovered
  compiler through the full certification pipeline.
- The current local policy accepts exactly MSYS2-compatible GNU C++ `14.2.0`
  or `16.1.0` targeting `x86_64-w64-mingw32`. It does not use an open-ended
  minimum-version comparison.
- The compiler root is inspected with bounded file/byte limits and link
  rejection, then copied into a content-addressed executor cache. Pre-copy and
  post-copy metadata/tree checks reject source drift during the operation.
  The original installation is not modified or removed.
- A strict certificate pins the original executable identity and SHA-256,
  parsed family/version/build/target, host OS build and architecture, C++
  profile/version, submission and checker roles, support-root/tree digest,
  compile recipe, native-executor version, sandbox-policy version, probe-suite
  version and probe evidence.
- Certification runs compiler identity probes, snapshot integrity checks,
  executor security-health checks, and real compile/run probes for both
  submission and C++ checker roles. A failed operation removes a newly staged
  orphan snapshot and does not publish a certificate.
- The certificate store is bounded, schema-checked, content-addressed by
  `certificateId`, revision-checked and replaced atomically. Corrupt/future
  state enters recovery instead of silently trusting or overwriting it.

### Resolver, preflight and batch pin

- The UI keeps showing the user-selected local path, while compilation uses the
  certified snapshot path inside the executor cache.
- Windows local C++ becomes ready only while the certificate still matches the
  host, recipe, probe suite, executor security policy, original compiler hash,
  snapshot marker and snapshot compiler hash. Missing or drifted evidence fails
  closed.
- Before producing contestant results, a judge session scans the selected
  contestant/problem scope, determines whether it needs C++/Python submission
  and C++/Python checker roles, and blocks the batch if a required toolchain is
  not ready.
- One resolved C++/Python pair is frozen for the judge session. Certification
  holds a maintenance lease, so it cannot overlap a batch and a batch cannot
  start during certification. Other mutation endpoints reject an active batch;
  asynchronous install also rechecks immediately before its atomic commit and
  cannot apply a stale preference.
- The first use of a certified-local C++ snapshot in an app session performs a
  real compile-then-sandbox probe. Its successful promise is cached by exact
  certificate ID and snapshot digest for later batches in that same app
  process.
- C++ custom checkers compile through the same pinned C++ toolchain. Managed
  Python checker behavior remains unchanged; local/system Python is not
  promoted without its own certificate and sandbox policy.

### UI and audit trail

- A Windows local C++ row exposes `Certify for JudgeDesk` only for an applicable
  selected local source. Planning first reports the canonical path, file count
  and estimated disk size; the confirmation states that JudgeDesk creates its
  own snapshot and leaves the original installation unchanged.
- The registry returns certificate ID, candidate fingerprint, snapshot digest,
  provenance and per-role readiness. The Manager shows the certificate ID
  without changing the four approved source radios or the three readiness
  labels.
- Run metadata and the exported workbook pin C++ source/version, submission and
  checker readiness, provenance, certificate ID, candidate fingerprint and
  snapshot digest.

## Verification evidence

### Windows 11 x64

Host: Windows 11 Pro `10.0.26200`, AMD64, Node `22.23.1`, Rust `1.97.0`.

On exact commit `3ce2c90`:

- TypeScript lint: pass.
- Full server/frontend regression: 252 tests, 247 pass, 5 platform skips,
  0 fail.
- Security integration: 16 tests, 15 pass, 1 macOS-only skip, 0 fail. This
  includes 20-run wall-time and memory boundaries, private-file/network/process
  checker boundaries, output/workspace/thread/process bombs and cancel drain.
- Targeted certificate/store/readiness/snapshot/certification/preflight/routes/
  metadata/UI suites are included in the full regression above.
- The application-code commit built the local Windows MSI successfully at
  `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/msi/JudgeDesk_1.2.7_x64_en-US.msi`.
  Commit `3ce2c90` changes only one cross-platform test assertion for canonical
  macOS temporary paths.

Real local certification used:

- Selected compiler:
  `C:\msys64\ucrt64\bin\g++.exe`
- Identity:
  `g++.exe (Rev5, Built by MSYS2 project) 16.1.0`
- Target:
  `x86_64-w64-mingw32`
- Certificate:
  `cert_8e0ecd1c41effcfa9e65eb8e1687e4adc2d404134584e7316c63dcffec62b259`
- Snapshot:
  `2cd00569db46800a6f939cad8d47df2073ab6156124dfe119b8910e506b90b42`
- Snapshot size:
  33,188 files, 966,821,868 bytes (about 922 MiB)
- Observed first full certification/import:
  about 4 minutes 36 seconds on this host

The exact-commit live gate resolved the original selection to the immutable
snapshot, ran the per-session compile/sandbox probe in 5.22 seconds, judged a
real C++ submission as `OK`, and compiled a native C++ checker successfully.
An earlier run of the same session probe took about 2.5 seconds; these two
observations are evidence, not yet a formal performance distribution.

The legacy Themis GCC 9.2 installation was deliberately not accepted. It is
outside the exact supported allowlist and also failed the current secure
executor compatibility path on this machine; JudgeDesk did not weaken the
sandbox or silently fall back to host execution.

### macOS Apple Silicon

Host: real Apple M1 with 8 GB RAM, macOS `26.5.2`, ARM64, Node `22.23.1`,
Rust `1.97.1`, Apple Clang `17.0.0`.

The clean detached gate worktree at
`~/Code/judgedesk-gate-432f3ae` was on exact commit `3ce2c90`:

- TypeScript lint: pass.
- Full server/frontend regression: 252 tests, 249 pass, 3 Windows-only skips,
  0 fail.
- Security integration: 16 tests, 15 pass, 1 Windows-only skip, 0 fail,
  including Seatbelt roles, repeated TLE/MLE boundaries, process bomb,
  checker isolation and cancel drain.
- `npm run build:macos:local:headless`: pass. The ARM64 app and ad-hoc DMG pass
  architecture, deep code-sign validation, JIT entitlement, authenticated
  sidecar startup/parent EOF, discovery routes and secure-runner self-test.
- DMG:
  `src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/JudgeDesk_1.2.7_aarch64.dmg`
- DMG SHA-256:
  `7f362fafd13ff41fbe21abc521f0e6df87c94de1fce117a63b6402a48522c8f6`
- Packaged process-supervisor gate: pass. Twenty concurrent secondary launches
  did not replace or duplicate the GUI/backend/executor generation; crash
  recovery drained the old submission process group and final shutdown left no
  runtime process.
- Packaged checker gate: pass. C++ submission, C++ `testlib.h` checker, managed
  Python checker, active-batch mutation rejection, cancellation and uninstall
  all passed.
- Final inventory: 0 JudgeDesk runtime process, 0 executor workspace and
  0 Seatbelt profile.

The selected Xcode developer root exposes an explicit macOS SDK `26.2`, and the
packaged C++ gates compiled and ran successfully. This branch does not add a
persisted Apple-Clang/SDK platform certificate; it leaves that existing macOS
path unchanged. The user's working checkout at `~/Code/judgedesk` was not
modified.

## Performance and resource impact

- Fast auto-detection remains a one-time passive scan. Full certification is
  never run merely because the app opened.
- The approximately 922 MiB copy and multi-minute full certification are paid
  only when the user explicitly certifies that installation, or when policy/
  identity drift requires recertification.
- Each app process pays one lightweight end-to-end probe for an exact certified
  snapshot before its first applicable batch. Later batches reuse the resolved
  promise. Normal contestant/checker compilation reads the snapshot directly.
- No per-testcase certificate scan or snapshot copy was added. A formal
  low-spec performance gate for certification and large-contest throughput is
  still required before calling this slice release-ready.

## Deliberate remaining limits

- No new language profile is enabled. C, Pascal, Go, Java, Rust, Node.js and C#
  remain later branches with their own policies and cross-platform corpora.
- Local certification currently supports Windows GNU C++ only. Local/system
  Python remains unavailable, and this slice does not create a new persisted
  platform certificate for Apple Clang.
- The production manifest-v2 public key, offline signing procedure, key
  rotation/revocation policy and signed catalog publication are not provisioned
  in this branch. Existing v1 catalog compatibility remains visible and must
  not be confused with v2 signature enforcement.
- Snapshot/certificate integrity protects the judge pipeline and detects the
  pinned executable/marker/policy drift. It is not a security boundary against
  an administrator or the signed-in host owner deliberately rewriting
  JudgeDesk's private application data.
- The latest UI behavior has automated component/DOM/API coverage. A human
  keyboard/focus/pixel review of the certification confirmation and installed
  DMG is still required before a public release candidate.
- This is a local ad-hoc DMG. CodeMagic, notarization, production updater
  signing and public release publication were intentionally not run.

## Recommended next checkpoint

Review and merge this D15 slice before enabling another language. Then split
the remaining work into two independently gated tracks:

1. provision and test the production manifest-v2 signing workflow; and
2. generalize `PreparedProgram`/compiler adapters and start the first C-language
   spike without changing C++/Python verdict semantics.
