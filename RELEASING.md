# Releasing JudgeDesk

## Repository and identity invariants

- Source, source tags and CI live in private `ducminh25/judgedesk-source`.
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

Every release supports Windows 10/11 x64 and macOS Apple Silicon only.

| Platform | Core | Full |
| --- | --- | --- |
| Windows x64 | Small MSI; WebView2 bootstrap and managed toolchains may be downloaded | Offline WebView2 installer plus all approved managed C/C++, Python, Pascal and Java packages |
| macOS Apple Silicon | App/DMG with Apple Clang support; managed Python, Pascal and Java may be downloaded | App/DMG with all approved managed Python, Pascal and Java packages; C/C++ uses verified Apple Clang |

Core and Full use the same application identity and cannot be installed side by
side. Installing one variant upgrades/replaces the other while preserving JudgeDesk
data. Full is the canonical updater payload because an automatic update must not
silently remove toolchains that were included by a previous Full installation.

For version `<version>`, the public artifact names are:

- `JudgeDesk_<version>_core_x64_en-US.msi`
- `JudgeDesk_<version>_full_x64_en-US.msi`
- `JudgeDesk_<version>_core_aarch64.dmg`
- `JudgeDesk_<version>_full_aarch64.dmg`
- `JudgeDesk_<version>_full_aarch64.app.tar.gz`
- updater `.sig` files for both Windows MSIs and the macOS Full app archive
- `SHA256SUMS` and `latest.json`

`latest.json` must select only the signed Full MSI and Full macOS app archive.
Core remains a manual installer choice; a Core installation may later update to
Full through the normal updater.

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
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

Run the Windows security, resource, single-instance and packaged smoke gates with
real-time Defender protection enabled. Do not add exclusions or weaken security
limits to make a release pass. Record any Defender detection with exact filename,
SHA-256 and detection name and block publication until it has been resolved.

The GitHub Actions `Verify Release Source` workflow repeats source checks when a
`v*` tag is pushed. It deliberately does not build or publish installers; the
platform-specific process below owns final artifacts.

## Publish managed toolchains v2

The Full and Core builds both consume the signed public `toolchains-v2` release.
Before installer builds:

1. Run `.github/workflows/toolchains.yml` from the exact release-candidate ref in
   private `judgedesk-source`.
2. Require both Windows x64 and macOS ARM64 jobs and their real-language secure
   runner gates to pass.
3. Verify the public manifest URL, Ed25519 signature, package SHA-256 values and
   all package download URLs.
4. Confirm the release contains exactly the approved v1.3.0 language scope:
   C++, C, Python, Pascal and Java. Go and other languages are future releases.

The workflow needs `PUBLIC_RELEASE_TOKEN` and
`TOOLCHAIN_MANIFEST_SIGNING_PRIVATE_KEY_B64` in the private source repository.

## Windows Core and Full

Build both installers on the validated Windows host:

```powershell
npm run build:windows:release:local
```

The command creates renamed Core/Full MSIs and `SHA256SUMS-windows` under
`release-assets-windows`. Local MSIs do not contain Tauri updater signatures.

Record Authenticode separately. A Tauri `.sig` authenticates updater downloads
but is not a Windows Authenticode publisher signature. Never describe an unsigned
MSI as code-signed. If no stable Authenticode certificate is configured, retain
that limitation in release notes and obtain explicit publication approval.

Create a temporary public prerelease/tag `v<version>-staging` and upload both
MSIs. Run CodeMagic workflow `windows-updater-signing` against the exact source
commit. Pass the locally recorded lowercase hashes as build variables
`WINDOWS_CORE_MSI_SHA256` and `WINDOWS_FULL_MSI_SHA256`. CodeMagic downloads and
verifies both files before invoking the established Tauri updater key; a missing
or mismatched hash fails the build before either MSI is signed. It returns both
MSIs, both `.sig` files and checksums. Delete the staging release/tag only after
all final artifacts have been collected and verified.

## macOS Apple Silicon Core and Full

Run CodeMagic workflow `macos-arm64-release` against the exact tagged source
commit. The workflow:

1. repeats source/native checks;
2. builds and tests the Apple Silicon server and native executor;
3. builds, mounts and smoke-tests the Core DMG;
4. builds, mounts and smoke-tests the Full DMG, then compiles/runs C, C++,
   Python, Pascal and Java with the packaged resources;
5. runs packaged C++ and Python custom-checker/cancellation gates and the
   packaged process-supervisor gate;
6. returns both DMGs, the signed Full `.app.tar.gz`, its `.sig` and checksums.

The CodeMagic `themis_signing` group must contain
`TAURI_SIGNING_PRIVATE_KEY` and, when applicable,
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

The current public/free path uses ad-hoc app signing plus the established Tauri
updater signature. It is not Developer ID notarization. Manual DMG users may need
**Open Anyway** after checking the official release and SHA-256. Do not claim
notarization unless `JUDGEDESK_REQUIRE_NOTARIZATION=1` passes in the actual build.

## Tag and publish

1. Let the release-candidate commit pass source tests and the two local Windows
   package/smoke gates.
2. Fast-forward private `main`, create annotated source tag `v<version>` and push
   both.
3. Run CodeMagic Windows signing and macOS Core/Full workflows on that exact SHA.
4. Put all final files in one clean release directory.
5. Run `scripts/generate-updater-manifest.js`; it must select the Full artifacts.
6. Generate one combined `SHA256SUMS` over every non-signature public artifact.
7. Create a draft `v<version>` release in public `ducminh25/judgedesk`, attach
   release notes and every artifact, then verify each anonymous download URL.
8. Verify updater signatures, toolchain manifest signature and checksums from the
   downloaded public files, not only from local copies.
9. Publish the draft only after both operating-system matrices pass. Remove the
   temporary staging release afterward.

Existing v1.3.0 users can receive v1.3.1 through the updater. `latest.json`
continues to select only the Full Windows MSI and Full macOS updater archive so
an automatic update never removes managed toolchains included by a previous
Full installation.
