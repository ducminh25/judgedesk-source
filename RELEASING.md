# Releasing JudgeDesk

## Repository and identity invariants

- Source, source tags and CI live in public `ducminh25/judgedesk-source`.
- Installers, checksums, updater metadata, managed toolchains, documentation and
  support live in public `ducminh25/judgedesk`.
- `package.json`, `package-lock.json`, `src/version.ts`,
  `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`,
  `src-tauri/tauri.conf.json`, `native-executor/Cargo.toml` and
  `native-executor/Cargo.lock` must contain the same version.
- Keep application identifier `com.themisv2.judge`, the embedded updater public
  key and Windows MSI UpgradeCode `4ac645a9-f719-5210-85be-f03f49c33869`
  unchanged. They preserve installed data and in-place upgrades.
- Never replace the existing Tauri updater key or the Ed25519 toolchain manifest
  key. A lost private key ends that update/signing lineage; generate a new key
  only for a deliberately new application identity.

## Distribution matrix

Every release supports Windows 10/11 x64, macOS Apple Silicon (`arm64`), and
Linux x86_64 (`amd64` — Ubuntu 22.04 LTS, 24.04 LTS, 26.04 LTS+ and compatible
distributions with `GLIBC >= 2.34`).

| Platform | Core | Full |
| --- | --- | --- |
| Windows x64 | Small MSI; WebView2 bootstrap and managed toolchains may be downloaded | Offline WebView2 installer plus all approved managed C/C++, Python, Pascal, Java and Scratch packages |
| macOS Apple Silicon | App/DMG with Apple Clang support; managed Python, Pascal, Java and Scratch may be downloaded | App/DMG with all approved managed Python, Pascal, Java and Scratch packages; C/C++ uses verified Apple Clang |
| Linux x86_64 (`amd64`) | `.deb` (Ubuntu 22.04+ / Debian / Mint; auto-pulls `bubblewrap`, `zenity`, `g++`, `python3`), `.rpm` (Fedora / RHEL / openSUSE), and portable `.AppImage` | Uses host package manager (`apt`/`dnf`) with automatic cross-version compiler discovery (`Local (auto-detect)`) plus built-in Scratch VM |

Core and Full use the same application identity and cannot be installed side by
side. Installing one variant upgrades/replaces the other while preserving JudgeDesk
data. From v1.5.0+, the in-app updater streamlines upgrades by downloading the
lightweight Core payload in the background, preserving all existing configurations
and toolchain files in AppData/Resources. On Linux, the updater is format-isolated
by installed bundle type (`linux-x86_64-deb-core`, `linux-x86_64-rpm-core`,
`linux-x86_64-appimage-core`) so `.deb`, `.rpm`, and `.AppImage` installations
always download their matching package format.

For version `<version>`, the public release assets (11 files total) are:

- Windows & macOS baseline (8 required files):
  - `JudgeDesk_<version>_core_x64_en-US.msi`
  - `JudgeDesk_<version>_full_x64_en-US.msi`
  - `JudgeDesk_<version>_core_aarch64.dmg`
  - `JudgeDesk_<version>_full_aarch64.dmg`
  - `JudgeDesk_<version>_core_aarch64.app.tar.gz`
  - `JudgeDesk_<version>_full_aarch64.app.tar.gz`
  - `SHA256SUMS` and `latest.json`
- Linux x86_64 (`amd64`) packages (3 files built via `bash scripts/build-linux-release.sh`):
  - `JudgeDesk_<version>_amd64.deb`
  - `JudgeDesk-<version>-1.x86_64.rpm`
  - `JudgeDesk_<version>_amd64.AppImage`

`latest.json` contains the four signed Windows/macOS targets
(`windows-x86_64-core`, `windows-x86_64-full`, `darwin-aarch64-core`, and
`darwin-aarch64-full`), plus the format-isolated Linux targets
(`linux-x86_64-deb-core`, `linux-x86_64-core`, `linux-x86_64-rpm-core`, and
`linux-x86_64-appimage-core`) when signed Linux bundles are staged. Each entry
includes strict JudgeDesk metadata for edition, download bytes and installed
bytes. Missing, mismatched, stale or cross-architecture metadata blocks
publication.

The Core and Full macOS `.app.tar.gz` files are automatic-updater payloads and
are therefore mandatory. Standalone `.sig` and `.metadata.json` files are private
build/staging inputs, not public download assets. Tauri requires signature contents
inside `latest.json`; JudgeDesk uses the metadata to explain size and edition
before download. Retain and verify all signatures and metadata files (Windows,
macOS, and Linux) until anonymous final verification completes.

GitHub adds the two **Source code** links (`zip` and `tar.gz`) from the public
release tag automatically. Confirm that both links work, but do not upload
duplicate source archives or any private source. These GitHub-managed links are
not release assets and are not entries in `SHA256SUMS`.

## Source verification

Run from a clean release-candidate commit:

```powershell
npm ci
npm run release:check-version
npm run lint
npm run test:update-ui
npm run test:server
npm run build:frontend
npm run build:server
npm run test:executor
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo fmt --check --manifest-path native-executor/Cargo.toml
cargo fmt --check --manifest-path crates/judgedesk-core/Cargo.toml
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo test --locked --manifest-path crates/judgedesk-core/Cargo.toml
```

Run the Windows security, resource, single-instance and packaged smoke gates with
real-time Defender protection enabled. Do not add exclusions or weaken security
limits to make a release pass. Record any Defender detection with exact filename,
SHA-256 and detection name and block publication until it has been resolved.

The GitHub Actions `Verify Release Source` workflow repeats source checks when a
`v*` tag is pushed. It deliberately does not build or publish installers; the
platform-specific process below owns final artifacts.

## Verify or publish managed toolchains v2

The Full and Core builds both consume the signed public `toolchains-v2` release.
Before installer builds, compare the release-candidate package catalog,
blueprints and release scope with the currently published manifest.

If any package input or signed manifest content changed:

1. Run `.github/workflows/toolchains.yml` from the exact release-candidate ref in
   `judgedesk-source`.
2. Require both Windows x64 and macOS ARM64 jobs and their real-language secure
   runner gates to pass.
3. Verify the public manifest URL, Ed25519 signature, package SHA-256 values and
   all package download URLs.
4. Confirm the release contains exactly the approved language scope:
   C++, C, Python, Pascal, Java and Scratch. Go, Rust and other languages are future releases.

The workflow needs `PUBLIC_RELEASE_TOKEN` and
`TOOLCHAIN_MANIFEST_SIGNING_PRIVATE_KEY_B64` in the source repository.

If none of those inputs changed, do not rebuild or replace the existing
`toolchains-v2` release merely for an application patch. Verify its public
manifest URL, Ed25519 signature, package SHA-256 values, download URLs and exact
language/host allowlist again, then record that immutable release as the input
to both Core and Full builds.

## Windows Core and Full

Build both installers on the validated Windows host from the clean tagged commit:

```powershell
npm run build:windows:release:local
```

The command creates renamed Core/Full MSIs, strict `.metadata.json` files with
installed sizes read from each MSI File table, and `SHA256SUMS-windows` under
`release-assets-windows`. Local MSIs do not contain Tauri updater signatures.

Record Authenticode separately. A Tauri `.sig` authenticates updater downloads
but is not a Windows Authenticode publisher signature. Never describe an unsigned
MSI as code-signed. If no stable Authenticode certificate is configured, retain
that limitation in release notes and obtain explicit publication approval.

## Linux x86_64 (`.deb`, `.rpm`, `.AppImage`)

Build and verify the three Linux packages on an `x86_64` Ubuntu host (or WSL2
`JudgeDesk-Ubuntu-24.04`) from the clean tagged commit:

```bash
bash scripts/build-linux-release.sh
sudo apt install ./release-assets-linux/JudgeDesk_<version>_amd64.deb
bash scripts/verify-linux-deb.sh
```

The build script enforces:
1. ELF symbol compatibility (`GLIBC <= 2.34` via `readelf -V`) across `themis-v2`,
   `server`, and `judgedesk-executor` so packages install and run cleanly on
   **Ubuntu 22.04 LTS (`glibc 2.35`)**, **Ubuntu 24.04 LTS (`glibc 2.39`)**, and
   **Ubuntu 26.04 LTS+**;
2. cross-Ubuntu Debian dependency declarations (`libgtk-3-0t64 | libgtk-3-0`,
   `libayatana-appindicator3-1 | libappindicator3-1`, `bubblewrap`, `zenity`,
   `g++`, `python3`);
3. real installed `.deb` smoke verification (`verify-linux-deb.sh`) proving
   `/api/distribution` (`bundleType: "deb"`), C++ and Python `AC` grading inside
   the Bubblewrap + cgroup v2 + seccomp-bpf sandbox, strict `.metadata.json`
   generation for `.deb`, `.rpm`, and `.AppImage`, and `SHA256SUMS-linux`
   generation under `release-assets-linux`.

## CodeMagic signing for local Windows and Linux builds

Create a temporary public prerelease/tag `v<version>-staging` on
`ducminh25/judgedesk` and upload:
- both Windows MSIs and their `.metadata.json` files from `release-assets-windows/`,
- the three Linux bundles (`.deb`, `.rpm`, `.AppImage`) and their `.metadata.json`
  files from `release-assets-linux/`.

Run CodeMagic workflow `windows-updater-signing` against the exact source commit.
Pass the locally recorded lowercase SHA-256 hashes as build variables:
- `WINDOWS_CORE_MSI_SHA256` and `WINDOWS_FULL_MSI_SHA256`,
- `LINUX_DEB_SHA256`, `LINUX_RPM_SHA256`, and `LINUX_APPIMAGE_SHA256`.

CodeMagic downloads and verifies every file's SHA-256 before invoking the
established Tauri updater key (`npx tauri signer sign`); a missing or mismatched
hash fails the build before any package is signed. It returns the signed packages,
all `.sig` files, `.metadata.json` files, and checksums. Delete the staging
release/tag only after all final artifacts have been collected and verified.

## macOS Apple Silicon Core and Full

Run CodeMagic workflow `macos-arm64-release` against the exact tagged source
commit. The workflow:

1. repeats source/native checks;
2. builds and tests the Apple Silicon server and native executor;
3. builds, mounts and smoke-tests the Core DMG;
4. builds, mounts and smoke-tests the Full DMG, then compiles/runs C, C++,
   Python, Pascal, Java and Scratch with the packaged resources;
5. runs packaged C++ and Python custom-checker/cancellation gates and the
   packaged process-supervisor gate;
6. returns both DMGs, both signed `.app.tar.gz` payloads, their `.sig`, strict
   size metadata and checksums.

The CodeMagic `themis_signing` group must contain
`TAURI_SIGNING_PRIVATE_KEY` and, when applicable,
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Local automation reads `CODEMAGIC_API_TOKEN`
and `CODEMAGIC_APP_ID` (`6a59050a8f1abc95b83e8570`) from gitignored `.env.local`
in the repository root.

The current public/free path uses ad-hoc app signing plus the established Tauri
updater signature. It is not Developer ID notarization. Manual DMG users may need
**Open Anyway** after checking the official release and SHA-256. Do not claim
notarization unless `JUDGEDESK_REQUIRE_NOTARIZATION=1` passes in the actual build.

## Tag and publish

1. Let the release-candidate commit pass source tests (`npm run check:full`,
   `npm run test:update-ui`, `cargo fmt --check`) and update `CHANGELOG.md` and
   `src/features/changelog/changelog-data.ts`.
2. Commit and push `main` to `ducminh25/judgedesk-source`, create annotated source
   tag `v<version>` and push the tag so `HEAD` is clean (`sourceState: "clean"`).
3. From that exact clean `v<version>` commit:
   - Build Windows Core/Full locally (`npm run build:windows:release:local`).
   - Build Linux `.deb`, `.rpm`, `.AppImage` locally in WSL2 (`bash scripts/build-linux-release.sh`).
   - Trigger CodeMagic `macos-arm64-release` on commit `v<version>`.
4. Publish temporary prerelease `v<version>-staging` on `ducminh25/judgedesk` with
   the local Windows MSIs + `.metadata.json` and Linux bundles + `.metadata.json`,
   then run CodeMagic `windows-updater-signing` on commit `v<version>` with the
   recorded SHA-256 variables.
5. Wait until both CodeMagic workflows (`macos-arm64-release` and
   `windows-updater-signing`) finish green, then download all artifacts into one
   clean local `release-staging/` directory.
6. Run `scripts/generate-updater-manifest.js` (`PUBLIC_RELEASE_REPOSITORY=ducminh25/judgedesk GITHUB_REF_NAME=v<version> node scripts/generate-updater-manifest.js release-staging`);
   it validates staging metadata and embeds every `.sig` plus measured size
   metadata (Windows, macOS, and Linux) in `release-staging/latest.json`.
7. Run `node scripts/assemble-public-release.mjs` to create a clean
   `public-release-assets/` directory containing the 11 public files (6 Windows/macOS
   installers/updater archives + 3 Linux packages + `latest.json` + combined
   `SHA256SUMS` over the other 10 public assets; no standalone `.sig` or
   `.metadata.json` files).
8. Run
   `npm run release:verify-public-assets -- public-release-assets v<version>`.
   Any missing or extra file, including a standalone `.sig`, blocks publication.
9. Create or upload to the `v<version>` release in public `ducminh25/judgedesk`,
   attach release notes and only `public-release-assets/*`, verify download URLs
   and checksums, and publish the release.
10. Delete the temporary `v<version>-staging` prerelease and tag on
    `ducminh25/judgedesk`, and clean up local temporary staging directories.

v1.3.4 is a deliberate manual cutover to the four-target manifest. Versions
before v1.3.4 do not understand the edition targets and must be upgraded with a
manual MSI/DMG once. From v1.3.4 onward, skipping releases is supported because
the stable endpoint always serves the latest version with both editions.
