# Releasing JudgeDesk

## Release invariants

- `package.json`, `package-lock.json`, `src/version.ts`,
  `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` and
  `src-tauri/tauri.conf.json` must use the same version.
- Keep `com.themisv2.judge`, the updater public key and the public endpoint
  unchanged. Existing `1.x` installations depend on this identity.
- Keep Windows MSI UpgradeCode `4ac645a9-f719-5210-85be-f03f49c33869`
  unchanged so JudgeDesk replaces ThemisV2 instead of installing beside it.
- A public release is update-capable only when it contains `latest.json` plus
  both signed updater pairs:
  - `JudgeDesk_<version>_x64_en-US.msi` and `.msi.sig`;
  - `JudgeDesk.app.tar.gz` and `.app.tar.gz.sig`.
- The DMG is for manual macOS installation. The `.app.tar.gz` is what the Tauri
  updater downloads on Apple Silicon.

## Verification

```powershell
npm ci
npm run release:check-version
npm run lint
npm run test:server
npm run build:frontend
npm run build:server
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

Run `npm run test:desktop` for the real Windows/WebView2 UI and complete the
release smoke checklist before tagging.

## Windows package built locally

```powershell
npm run build:windows:local
```

Upload the resulting MSI to a temporary public prerelease named
`v<version>-staging`. It must be downloadable without authentication because the
signing workflow uses the public release URL. Run CodeMagic workflow
`windows-updater-signing` against the exact release commit; it downloads that
MSI and creates the updater `.sig` with the private key in the `themis_signing`
group. Remove the temporary prerelease and tag after collecting the signature.

## Apple Silicon package

Run CodeMagic workflow `macos-arm64-release` against the exact same commit. It
builds and verifies the app, DMG, updater tarball, signature, entitlements,
architectures and a real sidecar startup.

## Publish

1. Create annotated source tag `v<version>` in the private source repo.
2. Collect the locally built MSI, the CodeMagic Windows signature, and all
   artifacts from `macos-arm64-release`.
3. Generate `latest.json` with `scripts/generate-updater-manifest.js` and create
   combined SHA-256 checksums.
4. Upload all artifacts to a draft `v<version>` release in
   `ducminh25/themis-v2`.
5. Verify every URL and signature, then publish the release. `latest.json` must
   be present before the release becomes the public `latest` release.
6. Remove the temporary `v<version>-staging` release after the signed Windows
   artifacts have been collected.
