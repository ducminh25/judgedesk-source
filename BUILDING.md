# Building JudgeDesk

## Required toolchains

- Node.js `22.x` (enforced by `.nvmrc` and `scripts/check-node.js`).
- Rust stable with `rustfmt`.
- Windows: Visual Studio Build Tools with **Desktop development with C++** and WebView2.
- macOS: Xcode Command Line Tools (`xcode-select --install`).

The Tauri CLI is installed by `npm ci`; do not install a separate global copy.

## Clean verification

```bash
npm ci
npm run release:check-version
npm run lint
npm run test:server
npm run build:frontend
npm run build:server
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

## Windows resource envelope

JudgeDesk permits only one active judge batch. On Windows, compiler and
submission jobs are each capped at 512 MiB so the packaged app, WebView,
backend, executor and active child can stay below the 1,024 MiB combined peak
release gate. Each active compiler/submission/checker job is also assigned to
one logical processor and started below normal priority so judging cannot take
over an older teacher PC. The macOS per-problem memory behavior is unchanged.

Before release, measure the complete packaged-app process tree during both a
compile workload and an MLE workload. A per-test executor peak by itself is not
sufficient evidence. Also verify that a second concurrent batch request gets
`JUDGE_BUSY` instead of starting more compiler/submission processes.

For an already packaged app, the repeatable local gate is:

```powershell
npm run test:windows-resources -- `
  -AppExecutable '<extracted-or-installed-path>\themis-v2.exe'
```

This local gate is valid resource evidence, but it is not the Windows security
release gate: an unsigned local build can have different Defender/SmartScreen
reputation from the public, Authenticode-signed release candidate.

## Test the desktop UI locally

The closest development-mode test to the installed application is:

```powershell
npm run test:desktop
```

This rebuilds the SEA sidecar, starts Vite with hot reload, and opens a real
Tauri/WebView2 JudgeDesk window. After the first run, frontend-only changes can
be tested faster with `npx tauri dev`; rebuild the sidecar when files under
`server/`, `shared/`, or `scripts/build-server*` change.

For browser-only debugging, run:

```bash
npm run dev
```

and open `http://127.0.0.1:3000`. Native dialogs, updater, checker preview,
window maximize behavior, and sidecar lifecycle must still be verified through
the Tauri window.

## Local desktop packages

Windows x64 local test installer (unsigned, updater signing disabled):

```powershell
npm run build:windows:local
```

The local unsigned installer is written to:

`src-tauri/target/x86_64-pc-windows-msvc/release/bundle/msi/JudgeDesk_<version>_x64_en-US.msi`

The release workflow uses `tauri.windows.conf.json` instead and requires the
private updater signing key. For a faster executable-only smoke test, run
`npm run build:server` and then `npx tauri build --no-bundle --target
x86_64-pc-windows-msvc`; the executable is created in the target release
directory.

The supported macOS release is Apple Silicon (`aarch64-apple-darwin`). It is
built and smoke-tested on a macOS runner by GitHub Actions and Codemagic. The
workflow verifies the app and sidecar architectures, code signatures,
entitlements, DMG contents, updater bundle, and a real sidecar HTTP startup.
Use the existing `workflow_dispatch` action on a branch to produce test
artifacts without publishing a release. A local M-series Mac can use
`bash scripts/build-macos-arm64-sidecar.sh` followed by the Tauri build command
from `.github/workflows/release.yml`.

`src-tauri/tauri.macos.conf.json` is the updater-capable distribution
configuration. The current CodeMagic workflow requires the existing Tauri
updater private key, produces the DMG plus signed updater tarball, and validates
architectures, code-signing structure, entitlements, sidecar startup, compiler,
executor and Managed Python behavior. It does not require or claim Developer ID
or Apple notarization by default; public/free DMG users may need to approve the
app manually in Gatekeeper after verifying its checksum and source.

Set `JUDGEDESK_REQUIRE_NOTARIZATION=1` only in a separately configured
Developer ID/notarization pipeline. Keep the source/native checks before the
Tauri build so a compiler, executor, TypeScript, version, or fixture failure
does not consume a packaging attempt.

## Managed compiler packages

The app downloads `toolchains-manifest.json` from the `toolchains-v1` GitHub Release. Every package is accepted only when its catalog metadata matches and its SHA-256 digest is valid.

The MSI and DMG contain the judger itself, not the large compiler archives. On first launch, the setup wizard offers Judger only, C/C++, Python, or the full package; selected managed toolchains are then downloaded into the user's application-data directory. This keeps one deterministic installer per operating system while preserving the requested installation choices.

Installed packages are stored in:

- Windows: `%LOCALAPPDATA%/ThemisV2/toolchains/`
- macOS: `~/Library/Application Support/ThemisV2/toolchains/`

The legacy `ThemisV2` data directory and application identifier are retained
for this rename so existing managed toolchains, preferences, and updater
identity continue to work.

Set `THEMIS_TOOLCHAIN_MANIFEST_URL` only when testing a private or pre-release manifest.
