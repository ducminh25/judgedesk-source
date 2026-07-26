# Releasing JudgeDesk

## Release invariants

- `package.json`, `package-lock.json`, `src/version.ts`,
  `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` and
  `src-tauri/tauri.conf.json`, plus `native-executor/Cargo.toml` and
  `native-executor/Cargo.lock`, must use the same version.
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
[v1.2.7 release checklist](docs/v1.2.7-release-test-checklist.md) before
tagging.

## Windows package built locally

```powershell
npm run build:windows:local
```

This command deliberately creates an unsigned MSI for local testing. Do not
publish it. The Tauri updater `.sig` authenticates an update to JudgeDesk, but
it is not a Windows Authenticode signature and does not establish the publisher
shown by Windows.

Before public distribution, configure Tauri Windows code signing with one
stable publisher identity (an eligible code-signing certificate or Azure
Artifact Signing), SHA-256 and an RFC 3161 timestamp. Build from the exact
release commit, then verify Authenticode on the MSI and every installed
JudgeDesk executable/sidecar. An absent, invalid or unexpected publisher is a
hard release failure.

Run the packaged stress/resource checklist with real-time Defender protection
enabled and without exclusions. The gate includes launching newly compiled
MinGW C++ AC, RE/divide-zero and MLE artifacts. If Defender reports a generated
artifact or distributed binary, retain the exact file/hash and detection name,
submit it to Microsoft as a suspected false positive, and block publication
until the signed release candidate passes again. Do not work around the gate by
disabling Defender, adding an exclusion, or changing required judging semantics.

Upload the resulting MSI to a temporary public prerelease named
`v<version>-staging`. It must be downloadable without authentication because the
signing workflow uses the public release URL. Run CodeMagic workflow
`windows-updater-signing` against the exact release commit; it downloads that
MSI and creates the updater `.sig` with the private key in the `themis_signing`
group. Remove the temporary prerelease and tag after collecting the signature.

Official Windows references:

- https://v2.tauri.app/distribute/sign/windows/
- https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation
- https://learn.microsoft.com/en-us/defender-endpoint/admin-submissions-mde
- https://www.microsoft.com/wdsi/filesubmission

## Apple Silicon package

Run CodeMagic workflow `macos-arm64-release` once, against the exact same commit
that passed the Windows and source gates. Do not use an intermediate commit for
a “trial DMG”; the workflow deliberately runs all cheap/source/native gates
before invoking Tauri packaging.

The current public/free CodeMagic path produces updater-signed artifacts without
requiring Apple Developer ID or notarization. The `themis_signing` Codemagic
variable group must contain:

- `TAURI_SIGNING_PRIVATE_KEY` and optional
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` for updater artifacts.

Never replace this key: existing installations verify updates with the public
key embedded in the app. The workflow verifies arm64 architecture, the app's
code-signing structure and entitlements, DMG contents, updater signature, the
packaged sidecar, Apple Clang, the native executor and Managed Python. It does
not claim Developer ID identity, a notarization ticket or Gatekeeper reputation;
manual DMG users may need **Open Anyway** after verifying the checksum and
release source.

If Developer ID/notarization is added later, configure the Apple credentials
separately and run the bundle verifier with `JUDGEDESK_REQUIRE_NOTARIZATION=1`.
Do not describe the current artifacts as notarized unless that stricter gate
actually passes.

Official setup references:

- https://v2.tauri.app/distribute/sign/macos/
- https://docs.codemagic.io/yaml-code-signing/signing-macos/
- https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution

## Publish

1. Create annotated source tag `v<version>` in `ducminh25/judgedesk`.
2. Collect the Windows MSI that passed the accepted Windows gates, its CodeMagic
   updater signature, and all artifacts from `macos-arm64-release`. Record
   Authenticode status separately; the updater `.sig` is not Authenticode.
3. Generate `latest.json` with `scripts/generate-updater-manifest.js` and create
   combined SHA-256 checksums.
4. Upload all artifacts to a draft `v<version>` release in
   `ducminh25/judgedesk`.
5. Verify every URL and signature, then publish the release. `latest.json` must
   be present before the release becomes the public `latest` release.
6. Remove the temporary `v<version>-staging` release after the signed Windows
   artifacts have been collected.
