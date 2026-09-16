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
| Windows x64 | Small MSI; WebView2 bootstrap and managed toolchains may be downloaded | Offline WebView2 installer plus all approved managed C/C++, Python, Pascal, Java and Scratch packages |
| macOS Apple Silicon | App/DMG with Apple Clang support; managed Python, Pascal, Java and Scratch may be downloaded | App/DMG with all approved managed Python, Pascal, Java and Scratch packages; C/C++ uses verified Apple Clang |

Core and Full use the same application identity and cannot be installed side by
side. Installing one variant upgrades/replaces the other while preserving JudgeDesk
data. From v1.5.0, the in-app updater streamlines upgrades by downloading the
lightweight Core payload in the background for both editions, preserving all existing
configurations and toolchain files in AppData/Resources. Both Core and Full remain
fully published as complete installer assets on GitHub Releases for fresh offline
installations. Updating preserves 100% of explicit compiler/runtime preferences.

For version `<version>`, upload exactly these eight public release assets:

- `JudgeDesk_<version>_core_x64_en-US.msi`
- `JudgeDesk_<version>_full_x64_en-US.msi`
- `JudgeDesk_<version>_core_aarch64.dmg`
- `JudgeDesk_<version>_full_aarch64.dmg`
- `JudgeDesk_<version>_core_aarch64.app.tar.gz`
- `JudgeDesk_<version>_full_aarch64.app.tar.gz`
- `SHA256SUMS` and `latest.json`

`latest.json` must contain exactly four signed targets:
`windows-x86_64-core`, `windows-x86_64-full`, `darwin-aarch64-core`, and
`darwin-aarch64-full`. Each entry includes strict JudgeDesk metadata for edition,
download bytes and installed bytes. Missing, mismatched, stale or cross-architecture
metadata blocks publication.

The Core and Full macOS `.app.tar.gz` files are automatic-updater payloads and
are therefore mandatory. Standalone `.sig` and `.metadata.json` files are private
build/staging inputs, not public download assets. Tauri requires signature contents
inside `latest.json`; JudgeDesk uses the metadata to explain size and edition
before download. Retain and verify all four signatures and metadata files until
anonymous final verification completes.

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
cargo test --locked --manifest-path src-tauri/Cargo.toml
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
   private `judgedesk-source`.
2. Require both Windows x64 and macOS ARM64 jobs and their real-language secure
   runner gates to pass.
3. Verify the public manifest URL, Ed25519 signature, package SHA-256 values and
   all package download URLs.
4. Confirm the release contains exactly the approved language scope:
   C++, C, Python, Pascal, Java and Scratch. Go, Rust and other languages are future releases.

The workflow needs `PUBLIC_RELEASE_TOKEN` and
`TOOLCHAIN_MANIFEST_SIGNING_PRIVATE_KEY_B64` in the private source repository.

If none of those inputs changed, do not rebuild or replace the existing
`toolchains-v2` release merely for an application patch. Verify its public
manifest URL, Ed25519 signature, package SHA-256 values, download URLs and exact
language/host allowlist again, then record that immutable release as the input
to both Core and Full builds.

## Windows Core and Full

Build both installers on the validated Windows host:

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

Create a temporary public prerelease/tag `v<version>-staging` and upload both
MSIs plus both `.metadata.json` files. Run CodeMagic workflow
`windows-updater-signing` against the exact source
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
   Python, Pascal, Java and Scratch with the packaged resources;
5. runs packaged C++ and Python custom-checker/cancellation gates and the
   packaged process-supervisor gate;
6. returns both DMGs, both signed `.app.tar.gz` payloads, their `.sig`, strict
   size metadata and checksums.

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
4. Put the verified installers, updater archive and standalone signatures in one
   clean private staging directory.
5. Run `scripts/generate-updater-manifest.js`; it must select all four exact
   Core/Full updater artifacts, validate staging metadata and embed every `.sig`
   plus measured size metadata in `latest.json`.
6. Create a separate clean `public-release-assets` directory containing exactly
   the eight-item allowlist above. Generate one combined `SHA256SUMS` over the
   other seven public assets; do not include standalone `.sig`, `.metadata.json`
   files or GitHub's generated source links.
7. Run
   `npm run release:verify-public-assets -- public-release-assets v<version>`.
   Any missing or extra file, including a standalone `.sig`, blocks publication.
8. Create a draft `v<version>` release in public `ducminh25/judgedesk`, attach
   release notes and only `public-release-assets/*`, then verify each anonymous
   download URL plus both GitHub-generated Source code links.
9. Verify checksums and all four downloaded updater payloads using the signatures
   embedded in the downloaded `latest.json`; include a tamper-negative signature
   test for every edition/platform. Verify the published byte sizes match manifest
   metadata. Do not depend on unpublished local `.sig` files for this gate.
10. Publish the draft only after both operating-system matrices pass. Remove the
    temporary staging release afterward.

v1.3.4 is a deliberate manual cutover to the four-target manifest. Versions
before v1.3.4 do not understand the edition targets and must be upgraded with a
manual MSI/DMG once. From v1.3.4 onward, skipping releases is supported because
the stable endpoint always serves the latest version with both editions.
