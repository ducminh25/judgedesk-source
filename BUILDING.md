# Building JudgeDesk

## Required toolchains

- Node.js `24.19.0` LTS with npm `11.17.0` (enforced by `.nvmrc`,
  `package.json` and `scripts/check-node.js`). The exact Node binary becomes the
  packaged SEA backend, so release builds intentionally use a reproducible
  version rather than a floating `latest` alias.
- Rust `1.97.1` with `rustfmt` (pinned by `rust-toolchain.toml`).
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

JudgeDesk permits only one active judge batch. On Windows, compiler jobs and
default submission jobs are capped to ensure the packaged app, WebView,
backend, executor and active child stay comfortably below the 1,024 MiB combined
peak release gate. Submissions support configurable memory limits up to 1,024 MiB
(default 256 MiB). Each active compiler/submission/checker job is also assigned to
one logical processor and started below normal priority so judging cannot take
over an older teacher PC. The macOS per-problem memory behavior is unchanged.

Before release, measure the complete packaged-app process tree during both a
compile workload and an MLE workload. A per-test executor peak by itself is not
sufficient evidence. Also verify that a second concurrent batch request gets
`JUDGE_BUSY` instead of starting more compiler/submission processes.

For an installed app under `Program Files`, the repeatable local gate is:

```powershell
npm run test:windows-resources -- `
  -AppExecutable 'C:\Program Files\JudgeDesk\themis-v2.exe' `
  -StressRoot 'D:\path\to\stress_test_judge'
```

To test without installing, use an MSI administrative extraction under
`build/`, then reproduce the read/execute access that `Program Files` grants to
Windows AppContainers before starting JudgeDesk:

```powershell
msiexec.exe /a '<full-msi-path>' /qn `
  TARGETDIR="$PWD\build\msi-resource-gate"
./scripts/prepare-windows-toolchain-gate-acl.ps1 `
  -GateRoot 'build\msi-resource-gate\PFiles\JudgeDesk'
npm run test:windows-resources -- `
  -AppExecutable "$PWD\build\msi-resource-gate\PFiles\JudgeDesk\themis-v2.exe" `
  -StressRoot 'D:\path\to\stress_test_judge'
```

Do not use the executable directly from `src-tauri/target` as packaged Python
evidence. A regular AppContainer may be unable to load its adjacent runtime
DLLs from a private source tree and return `0xC0000135`; that is a test-layout
failure, not a valid Python verdict. The ACL helper is deliberately confined to
an existing child of `build/` and grants only AppContainer read/execute access.

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

The supported macOS release is Apple Silicon (`aarch64-apple-darwin`). Final
Core and Full bundles are built and smoke-tested by CodeMagic workflow
`macos-arm64-release`. The workflow verifies the app and sidecar architectures,
code signatures, entitlements, DMG contents, Full updater bundle and real
sidecar/compiler/runtime startup. A local M-series Mac may use
`npm run build:macos:core:local` or `npm run build:macos:full:local` for a test
bundle, but those artifacts are not the final public release.

`src-tauri/tauri.macos.core.conf.json` disables updater artifact creation;
`src-tauri/tauri.macos.full.conf.json` creates the canonical signed updater
tarball. The CodeMagic workflow requires the existing Tauri updater private key
and stages distinct `_core_`/`_full_` names. It does not require or claim
Developer ID or Apple notarization by default; public/free DMG users may need to
approve the app manually in Gatekeeper after verifying its checksum and source.

Set `JUDGEDESK_REQUIRE_NOTARIZATION=1` only in a separately configured
Developer ID/notarization pipeline. Keep the source/native checks before the
Tauri build so a compiler, executor, TypeScript, version, or fixture failure
does not consume a packaging attempt.

## Managed compiler packages

The app downloads the signed `toolchains-manifest.json` from the
`toolchains-v2` release in the public `ducminh25/judgedesk` distribution
repository. A package is accepted only when the manifest signature, catalog
metadata, pinned archive SHA-256 and required runtime files all validate.

The Full MSI/app bundle embeds every managed package supported on that host.
The Core distribution contains the judger and can download the same packages
later from the public release. Windows packages cover GCC for C/C++, CPython,
Free Pascal and Temurin Java. The Apple Silicon packages cover CPython, Free
Pascal and Temurin Java; C/C++ uses the compatible Apple Clang installation.
First-launch discovery is deliberately quick and does not run the historical
multi-minute certification suite.

On Windows, build both final local candidates with:

```powershell
npm run build:windows:release:local
```

This stages distinct Core/Full MSIs under `release-assets-windows`. The Core
configuration uses the WebView2 download bootstrapper; Full uses the offline
WebView2 installer. Tauri updater signatures are added later by CodeMagic and
must not be confused with Windows Authenticode signing.

Installed packages are stored in:

- Windows: `%LOCALAPPDATA%/ThemisV2/toolchains/`
- macOS: `~/Library/Application Support/ThemisV2/toolchains/`

The legacy `ThemisV2` data directory and application identifier are retained
for this rename so existing managed toolchains, preferences, and updater
identity continue to work.

Set `THEMIS_TOOLCHAIN_MANIFEST_URL` only when testing a private or pre-release
manifest. Production URLs must continue to target the public distribution
repository, not the private source repository.
