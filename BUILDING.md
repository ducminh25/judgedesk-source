# Building ThemisV2

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

Run the development application with:

```bash
npm run dev
```

## Local desktop packages

Windows x64:

```powershell
npm run build:server
npx tauri build --config src-tauri/tauri.windows.conf.json --target x86_64-pc-windows-msvc
```

macOS universal packages are produced by GitHub Actions because the Intel and Apple Silicon SEA sidecars must first be built on their native runner and merged with `lipo`. A local Mac can build its own architecture with `npm run build:server` followed by `npx tauri build`.

## Managed compiler packages

The app downloads `toolchains-manifest.json` from the `toolchains-v1` GitHub Release. Every package is accepted only when its catalog metadata matches and its SHA-256 digest is valid.

The MSI and DMG contain the judger itself, not the large compiler archives. On first launch, the setup wizard offers Judger only, C/C++, Python, or the full package; selected managed toolchains are then downloaded into the user's application-data directory. This keeps one deterministic installer per operating system while preserving the requested installation choices.

Installed packages are stored in:

- Windows: `%LOCALAPPDATA%/ThemisV2/toolchains/`
- macOS: `~/Library/Application Support/ThemisV2/toolchains/`

Set `THEMIS_TOOLCHAIN_MANIFEST_URL` only when testing a private or pre-release manifest.
