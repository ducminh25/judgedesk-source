# JudgeDesk toolchain release security

This document is the release runbook for compiler/runtime packages. Toolchain
signing is deliberately independent from Tauri updater signing.

## Trust model

- Current signing key ID: `judgedesk-toolchains-2026-07`.
- Current public-key SHA-256 fingerprint:
  `34938c0c58abb2a750d2ef6693b79ca470531e9b48032c0b2606686308cff622`.
- Only the public key is stored in the application source.
- The private key must remain outside the repository and be backed up in an
  encrypted secret store controlled by the project owner.
- GitHub Actions receives the PKCS#8 private PEM only through the encrypted
  `TOOLCHAIN_MANIFEST_SIGNING_PRIVATE_KEY_B64` repository secret.
- `TOOLCHAIN_MANIFEST_SIGNING_KEY_ID` is non-secret and must match the public
  key compiled into the app.
- The updater key must never sign a toolchain manifest, and the toolchain key
  must never sign an updater artifact.

The signed manifest pins package ID, exact version, host OS/architecture,
minimum OS, component paths and roles, health-probe policy, archive byte size,
archive SHA-256, installed byte size, upstream source, license/notice paths and
SPDX SBOM path. JudgeDesk rejects unknown fields, untrusted keys, policy drift,
unsafe paths and invalid signatures before downloading or extracting an
archive.

## Initial provisioning

Run once on a trusted offline or release-administration machine:

```powershell
npm run toolchains:keygen
```

The command refuses to overwrite an existing key. Verify the printed public
fingerprint against this document and `OFFICIAL_TOOLCHAIN_MANIFEST_PUBLIC_KEYS`.
Back up the private PEM before enabling a release workflow.

To provision GitHub without putting the PEM in shell history:

```powershell
$key = [Convert]::ToBase64String(
  [IO.File]::ReadAllBytes(
    "$env:LOCALAPPDATA\JudgeDesk\release-secrets\judgedesk-toolchains-2026-07.private.pem"
  )
)
$key | gh secret set TOOLCHAIN_MANIFEST_SIGNING_PRIVATE_KEY_B64
Remove-Variable key
```

Repository access, branch protection and Actions permissions must be reviewed
before provisioning. Never print the secret or attach it to an evidence bundle.

## Release procedure

1. Update the trusted catalog, current release scope and package blueprints in one reviewed change. The current scope is C++, C, Python, FPC and Java only; dormant package sources are not published by the default workflow.
2. Pin every upstream URL and SHA-256 in the build workflow.
3. Build each OS/architecture package on its native runner. Execute its
   entrypoint and a compile/run probe before uploading the artifact.
4. Add the required upstream license files, JudgeDesk notice and SPDX 2.3 SBOM
   before creating the archive.
5. The publish job re-extracts every current-release archive, validates bounded contents and
   metadata, computes sizes/digests, signs the canonical manifest, and then
   validates its own output with the public trust store.
6. Upload the manifest, archives and `SHA256SUMS` to the dedicated toolchain
   release. Record the workflow run, commit SHA, manifest SHA-256 and package
   digests in the release evidence.
7. Build JudgeDesk Full from that exact signed manifest. JudgeDesk Core embeds
   the same manifest and downloads the same archive bytes.
8. Run packaged Windows/macOS gates before a profile is marked Stable.

Do not reuse a package ID/version for different bytes. If any input, recipe or
notice changes, increment the package version or build identifier and publish a
new catalog revision.

## Rotation

1. Generate a new Ed25519 pair with a new date-based key ID.
2. Add the new public key alongside the old key and release an app update.
3. Wait until the supported installed-app population trusts the new key.
4. Switch the workflow secret and key ID; publish new manifests with the new
   key.
5. Keep the old public key only while supported manifests still require it.
6. Remove the old key in a later app release and archive/destroy its private
   material according to project retention policy.

## Revocation and incident response

If a private key or signed package is suspected to be compromised:

1. Disable the toolchain publishing workflow and remove the GitHub secret.
2. Remove affected release assets from public distribution.
3. Publish an app update that removes the compromised public key and marks
   affected package IDs/digests revoked.
4. Keep affected profiles fail-closed until a newly keyed catalog and clean
   packages pass the full release gate.
5. Document the affected key IDs, package digests, time window and remediation.

Removing an asset alone is insufficient: already downloaded or bundled packages
must be denied by digest in the application policy.
