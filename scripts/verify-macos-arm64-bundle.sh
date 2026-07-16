#!/usr/bin/env bash
set -euo pipefail

target_root="src-tauri/target/aarch64-apple-darwin/release/bundle"
dmg_file="$(find "$target_root/dmg" -maxdepth 1 -name 'ThemisV2_*.dmg' -print -quit)"
test -n "$dmg_file"

mount_dir="$(mktemp -d)"
cleanup_dmg_mount() {
  hdiutil detach "$mount_dir" >/dev/null 2>&1 || true
  rmdir "$mount_dir" >/dev/null 2>&1 || true
}
trap cleanup_dmg_mount EXIT

hdiutil attach "$dmg_file" -readonly -nobrowse -mountpoint "$mount_dir" >/dev/null
app_bundle="$(find "$mount_dir" -maxdepth 1 -name '*.app' -print -quit)"
test -n "$app_bundle"

lipo "$app_bundle/Contents/MacOS/themis-v2" -verify_arch arm64
lipo "$app_bundle/Contents/MacOS/server" -verify_arch arm64
codesign --verify --deep --strict --verbose=2 "$app_bundle"
node scripts/smoke-test-sidecar.js \
  "$app_bundle/Contents/MacOS/server" \
  "$app_bundle/Contents/Resources"

rm -rf release-assets-mac
mkdir -p release-assets-mac
cp "$target_root"/dmg/ThemisV2_*.dmg release-assets-mac/
cp "$target_root"/macos/*.app.tar.gz release-assets-mac/
cp "$target_root"/macos/*.app.tar.gz.sig release-assets-mac/
(
  cd release-assets-mac
  shasum --algorithm 256 ThemisV2_*.dmg ThemisV2.app.tar.gz \
    > SHA256SUMS-macos
)

echo "Apple Silicon DMG and updater bundle passed packaged smoke tests."
