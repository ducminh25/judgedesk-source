# Building JudgeDesk

## Required toolchains

- Node.js `24.19.0` LTS with npm `11.17.0` (enforced by `.nvmrc`,
  `package.json` and `scripts/check-node.js`). The exact Node binary becomes the
  packaged SEA backend, so release builds intentionally use a reproducible
  version rather than a floating `latest` alias.
- Rust `1.97.1` with `rustfmt` (pinned by `rust-toolchain.toml`).
- Windows: Visual Studio Build Tools with **Desktop development with C++** and WebView2.
- macOS: Xcode Command Line Tools (`xcode-select --install`).
- Linux (`x86_64` / Ubuntu 22.04 LTS+): `build-essential`, `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `patchelf`, `rpm`, `file`, `bubblewrap`, `zenity`, `xdg-utils`.

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

### Linux x86_64 packages (`.deb`, `.rpm`, `.AppImage`)

Build all three Linux release installers on **Ubuntu 22.04 LTS (`x86_64`,
GLIBC 2.35)**. Newer distros are runtime test targets, not release build hosts:

```bash
bash scripts/build-linux-release.sh
```

Run `npm ci` in a Linux checkout or frozen source snapshot. The frontend is
always rebuilt; Windows `node_modules` and a previously generated `dist/` are
not valid substitutes. Use the lockfile's Tauri CLI (currently 2.12.0); the
script rejects mismatched versions and non-22.04 build hosts. Final payload
verification also requires Python 3, `binutils`, `rpm`/`rpm2archive`, and
`squashfs-tools` on the build host.
Scratch is re-staged from its pinned archive on every build and its executable
bytes/bootstrap are verified in all three final installer formats.

The script:
1. builds the frontend (`npm run build:frontend`);
2. compiles the Linux sidecar (`server-x86_64-unknown-linux-gnu`) and native
   executor (`judgedesk-executor-x86_64-unknown-linux-gnu`) with weak symbol
   definitions for `GLIBC_2.39` `pidfd_spawnp`/`pidfd_getpid` so the resulting
   ELF binaries remain compatible with **Ubuntu 22.04 LTS (`glibc 2.35`)** and
   newer;
3. packages `.deb`, `.rpm`, and `.AppImage` bundles using
   `src-tauri/tauri.linux.local.conf.json` (with cross-Ubuntu dependencies
   `libgtk-3-0t64 | libgtk-3-0`, `libayatana-appindicator3-1 | libappindicator3-1`,
   `bubblewrap`, `zenity`, `g++`, `python3`);
4. extracts every final DEB/RPM/AppImage and scans **every regular ELF**, plus
   the outer AppImage runtime, using `readelf` version needs. The gate rejects
   requirements newer than `GLIBC_2.35`, unsupported `GLIBC_*` ABI tags, malformed
   ELF files and empty payloads. Per-file hashes and requirements are written to
   the bundle directory's `elf-baseline/` reports;
5. stages `JudgeDesk_<version>_amd64.deb`, `JudgeDesk-<version>-1.x86_64.rpm`,
   `JudgeDesk_<version>_amd64.AppImage`, and `SHA256SUMS-linux` under
   `release-assets-linux/`.

Checking only the three application executables does not establish the baseline
of bundled libraries. Build on the supported release host and run the
whole-payload gate to reject dependencies on newer GLIBC versions.
Passing the ELF gate still requires actual runtime tests on the supported
distros; it does not certify graphics drivers or other host services.

To verify an installed `.deb` end-to-end against all six supported languages inside
the real Bubblewrap + cgroup v2 + seccomp-bpf sandbox, run:

```bash
sudo apt install ./release-assets-linux/JudgeDesk_<version>_amd64.deb
bash scripts/verify-linux-deb.sh
```

This smoke test needs the six toolchains installed/configured on the host and a
graphical user session with delegated systemd cgroups. It uses fresh user data,
does not force X11 or disable WebKit rendering features, and checks backend drain
plus absence of leftover processes. Inspect the actual window separately before
claiming GUI rendering success.

Ubuntu 22.04's default runtime packages need additional preparation: its
`user@.service` delegates `memory` and `pids`, but the executor also requires
`cpu`; its Bubblewrap 0.6.1 lacks the `--size` option used to bound tmpfs. Do not
remove that limit or weaken sandbox checks to make an acceptance run pass.
An administrator must provide the required controller delegation and a
maintained, patched Bubblewrap with `--size` support. The 22.04 QA environment
documents these explicit prerequisites; its passing runs must not be described
as a clean-default-install experience. AppImage does not currently configure
these host prerequisites itself.

For candidate acceptance, bind a smoke run to the exact installer and embedded
build identity, for example:

```bash
python3 scripts/verify-linux-package.py --app /usr/bin/themis-v2 \
  --bundle-type deb --artifact /path/to/JudgeDesk_1.6.0_amd64.deb \
  --artifact-sha256 '<recorded SHA-256>' --expected-build-number '<build number>' \
  --evidence artifacts/linux-candidate-deb
```

For AppImage, pass its path to both `--app` and `--artifact`. DEB acceptance
compares installed application payloads against the installer before launching.
The verifier rejects optimized Python, which would disable its assertions.

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
- Linux: `~/.local/share/ThemisV2/toolchains/`

The legacy `ThemisV2` data directory and application identifier are retained
for this rename so existing managed toolchains, preferences, and updater
identity continue to work.

Set `THEMIS_TOOLCHAIN_MANIFEST_URL` only when testing a private or pre-release
manifest. Production URLs must continue to target the public distribution
repository, not the private source repository.
