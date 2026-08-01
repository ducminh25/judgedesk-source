#!/usr/bin/env bash
set -euo pipefail

target_root="src-tauri/target/aarch64-apple-darwin/release/bundle"
shopt -s nullglob
dmg_files=("$target_root"/dmg/JudgeDesk_*.dmg)
if [[ "${#dmg_files[@]}" -ne 1 ]]; then
  echo "Expected exactly one JudgeDesk DMG, found ${#dmg_files[@]}." >&2
  exit 1
fi
dmg_file="${dmg_files[0]}"
distribution_variant="${JUDGEDESK_DISTRIBUTION_VARIANT:-}"

case "${JUDGEDESK_LOCAL_BUNDLE:-0}" in
  0 | 1) ;;
  *)
    echo "JUDGEDESK_LOCAL_BUNDLE must be 0 or 1." >&2
    exit 1
    ;;
esac

if [[ "${JUDGEDESK_LOCAL_BUNDLE:-0}" == "0" ]]; then
  case "$distribution_variant" in
    core | full) ;;
    *)
      echo "JUDGEDESK_DISTRIBUTION_VARIANT must be core or full for release staging." >&2
      exit 1
      ;;
  esac
fi

mount_dir="$(mktemp -d)"
verification_data="$(mktemp -d "${TMPDIR:-/tmp}/judgedesk-macos-bundle-verify.XXXXXX")"
tree_guard="$verification_data/process-tree.generation"
cleanup_dmg_mount() {
  hdiutil detach "$mount_dir" >/dev/null 2>&1 || true
  rmdir "$mount_dir" >/dev/null 2>&1 || true
  rm -f -- "$tree_guard"
  rmdir "$verification_data" >/dev/null 2>&1 || true
}
trap cleanup_dmg_mount EXIT

chmod 700 "$verification_data"
tree_generation="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
umask 077
printf 'JUDGEDESK_PROCESS_TREE/1\ngeneration=%s\n' "$tree_generation" >"$tree_guard"
chmod 600 "$tree_guard"
export JUDGEDESK_TREE_GUARD_REQUIRED=1
export JUDGEDESK_TREE_GUARD_PATH="$tree_guard"
export JUDGEDESK_TREE_GUARD_GENERATION="$tree_generation"

hdiutil attach "$dmg_file" -readonly -nobrowse -mountpoint "$mount_dir" >/dev/null
app_bundle="$(find "$mount_dir" -maxdepth 1 -name '*.app' -print -quit)"
test -n "$app_bundle"
server_binary="$app_bundle/Contents/MacOS/server"
executor_binary="$app_bundle/Contents/MacOS/judgedesk-executor"

lipo "$app_bundle/Contents/MacOS/themis-v2" -verify_arch arm64
lipo "$server_binary" -verify_arch arm64
lipo "$executor_binary" -verify_arch arm64
codesign --verify --deep --strict --verbose=2 "$app_bundle"
codesign --verify --strict --verbose=2 "$executor_binary"
signature_info="$(codesign -dvvv "$app_bundle" 2>&1)"
printf '%s\n' "$signature_info"
server_entitlements="$(codesign -d --entitlements - "$server_binary" 2>&1)"
printf '%s\n' "$server_entitlements"
if ! grep -q 'com.apple.security.cs.allow-jit' <<<"$server_entitlements"; then
  echo "The packaged backend sidecar is missing the JIT entitlement required by V8." >&2
  exit 1
fi
if [[ "${JUDGEDESK_REQUIRE_NOTARIZATION:-0}" == "1" ]]; then
  if ! grep -q '^Authority=Developer ID Application:' <<<"$signature_info"; then
    echo "The release app is not signed with Developer ID Application." >&2
    exit 1
  fi
  if ! grep -Eq '^CodeDirectory .*flags=.*runtime' <<<"$signature_info"; then
    echo "The release app is missing hardened runtime." >&2
    exit 1
  fi
  xcrun stapler validate "$dmg_file"
  spctl --assess --type execute --verbose=4 "$app_bundle"
fi
node scripts/smoke-test-sidecar.js \
  "$server_binary" \
  "$app_bundle/Contents/Resources" \
  --require-cpp

if [[ "${JUDGEDESK_LOCAL_BUNDLE:-0}" == "1" ]]; then
  shasum --algorithm 256 "$dmg_file"
  echo "Apple Silicon local DMG passed architecture, signature, entitlement, and packaged sidecar smoke tests."
  exit 0
fi

mkdir -p release-assets-mac
release_version="$(node -p "require('./package.json').version")"
asset_prefix="JudgeDesk_${release_version}_${distribution_variant}_aarch64"
cp "$dmg_file" "release-assets-mac/${asset_prefix}.dmg"

if [[ "$distribution_variant" == "full" ]]; then
  updater_bundles=("$target_root"/macos/*.app.tar.gz)
  if [[ "${#updater_bundles[@]}" -ne 1 ]]; then
    echo "Expected exactly one macOS updater bundle, found ${#updater_bundles[@]}." >&2
    exit 1
  fi
  updater_bundle="${updater_bundles[0]}"
  test -s "${updater_bundle}.sig"
  cp "$updater_bundle" "release-assets-mac/${asset_prefix}.app.tar.gz"
  cp "${updater_bundle}.sig" "release-assets-mac/${asset_prefix}.app.tar.gz.sig"
fi

(
  cd release-assets-mac
  find . -maxdepth 1 -type f ! -name '*.sig' ! -name 'SHA256SUMS-macos' \
    -print | sort | xargs shasum --algorithm 256 > SHA256SUMS-macos
)

echo "Apple Silicon ${distribution_variant} bundle passed packaged smoke tests and was staged."
