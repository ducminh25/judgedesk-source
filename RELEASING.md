# Releasing ThemisV2

Releases are built on GitHub Actions. A tag build creates an MSI, a universal DMG and `SHA256SUMS`, then saves them in a **draft** GitHub Release. Publishing remains a manual quality gate.

## 1. Publish managed toolchains

Run **Actions → Build and Publish Toolchains → Run workflow** after changing compiler/runtime versions. The workflow builds packages on their native architectures, generates real SHA-256 values, and creates or updates the `toolchains-v1` release.

Confirm that the release contains:

- `themis-gcc-windows-x64-14.2.0.zip`
- `themis-python-windows-x64-3.12.13.zip`
- `themis-python-macos-x64-3.12.13.tar.gz`
- `themis-python-macos-arm64-3.12.13.tar.gz`
- `toolchains-manifest.json`
- `SHA256SUMS`

## 2. Configure optional production signing

Add secrets at **Repository Settings → Secrets and variables → Actions**.

Windows:

- `WINDOWS_CERTIFICATE`: base64-encoded PFX certificate.
- `WINDOWS_CERTIFICATE_PASSWORD`: PFX export password.
- `WINDOWS_CERTIFICATE_THUMBPRINT`: certificate SHA-1 thumbprint.

macOS Developer ID:

- `APPLE_CERTIFICATE`: base64-encoded Developer ID Application `.p12`.
- `APPLE_CERTIFICATE_PASSWORD`: `.p12` password.
- `KEYCHAIN_PASSWORD`: temporary CI keychain password.
- `APPLE_SIGNING_IDENTITY`: full Developer ID Application identity.

Apple notarization:

- `APPLE_API_ISSUER`: App Store Connect issuer UUID.
- `APPLE_API_KEY`: App Store Connect key ID.
- `APPLE_API_KEY_BASE64`: base64-encoded `.p8` private key.

Unsigned builds are allowed for pipeline testing, but the resulting draft must not be published.

## 3. Prepare and tag the version

Keep these versions identical:

- `package.json`
- `package-lock.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `src-tauri/tauri.conf.json`
- `src/version.ts`

Verify before tagging:

```bash
npm ci
npm run release:check-version
npm run lint
npm run test:server
cargo fmt --check --manifest-path src-tauri/Cargo.toml
```

Create and push an annotated tag matching the version exactly:

```bash
git tag -a v1.1.0 -m "ThemisV2 v1.1.0"
git push origin v1.1.0
```

## 4. Validate the draft release

Wait for **Build and Publish Release** to finish, then download the draft assets and verify:

- Windows signature with `Get-AuthenticodeSignature`.
- macOS signature with `codesign --verify --deep --strict`.
- Notarization with `xcrun stapler validate` and Gatekeeper with `spctl --assess`.
- SHA-256 values against `SHA256SUMS`.
- Clean install, launch, C++ grading, Python grading and uninstall on current Windows 10/11 and both Intel/Apple Silicon macOS test machines.

Publish the GitHub Release only after these checks pass.
