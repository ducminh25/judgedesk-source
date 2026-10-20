#!/usr/bin/env bash
set -euo pipefail

app_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$app_root"

export PATH="$HOME/.cargo/bin:/usr/local/bin:$PATH"

arch="$(uname -m)"
case "$arch" in
  x86_64)
    target="x86_64-unknown-linux-gnu"
    deb_arch="amd64"
    rpm_arch="x86_64"
    scratch_zip_name="scratch-run_0.1.7_linux_amd64.zip"
    scratch_zip_sha256="e4eac2d97021c2ca8cdfb8b3001306c830614a6b6966c30cc901442441896185"
    ;;
  aarch64 | arm64)
    target="aarch64-unknown-linux-gnu"
    deb_arch="arm64"
    rpm_arch="aarch64"
    scratch_zip_name="scratch-run_0.1.7_linux_arm64.zip"
    scratch_zip_sha256=""
    ;;
  *)
    echo "Unsupported Linux architecture: $arch" >&2
    exit 1
    ;;
esac

node scripts/check-release-version.js
node scripts/check-node.js

# If running inside WSL2 against a Windows checkout on /mnt/*, use a Linux-native
# Cargo target directory so flock/build-script permissions work reliably.
if [[ "$app_root" == /mnt/* && -z "${CARGO_TARGET_DIR:-}" ]]; then
  export CARGO_TARGET_DIR="$HOME/jd-target"
fi

# Prevent Rust's libstd weak pidfd_spawnp/pidfd_getpid references from recording
# a hard GLIBC_2.39 VERNEED entry when linked on Ubuntu 24.04+, keeping the binary
# GLIBC requirement at <= GLIBC_2.34 (compatible with Ubuntu 22.04 LTS glibc 2.35+).
export RUSTFLAGS="${RUSTFLAGS:-} -C link-arg=-Wl,--defsym=pidfd_spawnp=0 -C link-arg=-Wl,--defsym=pidfd_getpid=0"
export APPIMAGE_EXTRACT_AND_RUN=1
export NO_STRIP=true

echo "Building fresh frontend bundle..."
if [[ -d "node_modules/@rolldown/binding-linux-x64-gnu" ]]; then
  npm run build:frontend
elif [[ -f "dist/index.html" ]]; then
  for check_src in "src/App.tsx" "src/version.ts" "src/locales/vi.json" "src/locales/en.json" "src/features/changelog/changelog-data.ts" "src/components/ProblemConfigModal.tsx" "src/components/JudgingDetailsModal.tsx" "src/features/problem-config/BasicProblemSettings.tsx" "src/features/help/help.en.json"; do
    if [[ "$check_src" -nt "dist/index.html" ]]; then
      echo "ERROR: dist/index.html is older than $check_src. Run 'npm run build:frontend' on the host first." >&2
      exit 1
    fi
  done
  echo "Using fresh host-built dist/ bundle."
else
  echo "ERROR: dist/index.html not found and Linux rolldown binding is not installed in node_modules." >&2
  exit 1
fi

scratch_pkg_dir="$app_root/src-tauri/toolchains/scratch-linux-x64"
mkdir -p "$scratch_pkg_dir"
if [[ ! -x "$scratch_pkg_dir/scratch-run" ]]; then
  echo "Staging bundled Scratch runtime (scratch-linux-x64)..."
  scratch_cache_dir="${CARGO_TARGET_DIR:-/tmp}/judgedesk-toolchain-cache"
  mkdir -p "$scratch_cache_dir"
  scratch_zip="$scratch_cache_dir/$scratch_zip_name"
  if [[ ! -f "$scratch_zip" ]]; then
    curl -fsSL "https://github.com/VNOI-Admin/scratch-run/releases/download/0.1.7/$scratch_zip_name" -o "$scratch_zip"
  fi
  actual_sha256="$(sha256sum "$scratch_zip" | awk '{print $1}')"
  if [[ -n "$scratch_zip_sha256" && "$actual_sha256" != "$scratch_zip_sha256" ]]; then
    echo "ERROR: SHA-256 mismatch for $scratch_zip_name: expected $scratch_zip_sha256, got $actual_sha256" >&2
    exit 1
  fi
  python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$scratch_zip" "$scratch_pkg_dir"
fi
chmod 755 "$scratch_pkg_dir/scratch-run"
if [[ ! -f "$scratch_pkg_dir/LICENSE" ]]; then
  curl -fsSL "https://raw.githubusercontent.com/VNOI-Admin/scratch-run/master/LICENSE" -o "$scratch_pkg_dir/LICENSE"
fi
cat <<EOF > "$scratch_pkg_dir/.judgedesk-package.json"
{
  "schemaVersion": 1,
  "packageId": "scratch-linux-x64",
  "version": "0.1.7",
  "archiveSha256": "${scratch_zip_sha256:-e4eac2d97021c2ca8cdfb8b3001306c830614a6b6966c30cc901442441896185}",
  "entrypointComponentId": "scratch.runtime",
  "components": [
    {
      "id": "scratch.runtime",
      "kind": "executable",
      "relativePath": "scratch-run",
      "roles": ["submission-runtime"]
    }
  ]
}
EOF

echo "Building release native executor for $target..."
cargo build --locked --release --manifest-path native-executor/Cargo.toml --target "$target"
executor_target_root="${CARGO_TARGET_DIR:-$app_root/native-executor/target}"
executor_src="$executor_target_root/$target/release/judgedesk-native-executor"
executor_dst="$app_root/src-tauri/binaries/judgedesk-executor-$target"
mkdir -p "$(dirname "$executor_dst")"
cp "$executor_src" "$executor_dst"
chmod 755 "$executor_dst"

if [[ -z "${ESBUILD_BINARY_PATH:-}" && -x "$HOME/tauri-cli/node_modules/@esbuild/linux-x64/bin/esbuild" ]]; then
  export ESBUILD_BINARY_PATH="$HOME/tauri-cli/node_modules/@esbuild/linux-x64/bin/esbuild"
fi

echo "Building Linux backend sidecar for $target..."
node scripts/build-server.js
chmod 755 "$app_root/src-tauri/binaries/server-$target"

eval "$(
  node -e '
    const env = JSON.parse(require("node:child_process").execFileSync(process.execPath, ["scripts/prepare-build-environment.js"], { encoding: "utf8" }));
    for (const [k, v] of Object.entries(env)) {
      console.log(`export ${k}=${JSON.stringify(String(v))}`);
    }
  '
)"

tauri_bin="$app_root/node_modules/.bin/tauri"
if [[ -x "$HOME/tauri-cli/node_modules/.bin/tauri" ]]; then
  tauri_bin="$HOME/tauri-cli/node_modules/.bin/tauri"
fi

tauri_target_root="${CARGO_TARGET_DIR:-$app_root/src-tauri/target}"
bundle_root="$tauri_target_root/release/bundle"
if [[ -d "$tauri_target_root/$target/release/bundle" ]]; then
  bundle_root="$tauri_target_root/$target/release/bundle"
fi
rm -rf "$bundle_root/deb" "$bundle_root/rpm" "$bundle_root/appimage"

bundles="${JUDGEDESK_LINUX_BUNDLES:-deb,rpm,appimage}"
echo "Building Tauri Linux bundles ($bundles) for $target..."
if ! "$tauri_bin" build --bundles "$bundles" --config src-tauri/tauri.linux.local.conf.json -- --locked; then
  if [[ "$bundles" == *"appimage"* ]]; then
    echo "WARN: AppImage bundling failed in this environment; retrying deb,rpm..." >&2
    "$tauri_bin" build --bundles "deb,rpm" --config src-tauri/tauri.linux.local.conf.json -- --locked
  else
    exit 1
  fi
fi

if [[ -d "$tauri_target_root/$target/release/bundle" ]]; then
  bundle_root="$tauri_target_root/$target/release/bundle"
fi

themis_bin="$tauri_target_root/release/themis-v2"
if [[ -f "$tauri_target_root/$target/release/themis-v2" ]]; then
  themis_bin="$tauri_target_root/$target/release/themis-v2"
fi

echo "Verifying ELF GLIBC baseline (must be <= GLIBC_2.35 for Ubuntu 22.04 LTS+ compatibility)..."
for elf_bin in "$themis_bin" "$executor_dst" "$app_root/src-tauri/binaries/server-$target"; do
  max_glibc="$(readelf -V "$elf_bin" | grep -oE 'GLIBC_[0-9]+\.[0-9]+(\.[0-9]+)?' | sort -uV | tail -n 1)"
  echo "  $(basename "$elf_bin"): max required $max_glibc"
  if grep -qE '^GLIBC_2\.(3[6-9]|[4-9][0-9])$' <<<"$max_glibc"; then
    echo "ERROR: $elf_bin requires $max_glibc (> GLIBC_2.35), breaking Ubuntu 22.04 LTS compatibility!" >&2
    exit 1
  fi
done

shopt -s nullglob
deb_files=("$bundle_root"/deb/*.deb)
if [[ "${#deb_files[@]}" -eq 0 ]]; then
  echo "Expected at least one .deb package in $bundle_root/deb" >&2
  exit 1
fi
deb_file="${deb_files[0]}"

echo "Verifying .deb package metadata and contents: $deb_file"
control_info="$(dpkg-deb -I "$deb_file")"
printf '%s\n' "$control_info"

if ! grep -q '^ Package: judge-desk$' <<<"$control_info"; then
  echo "ERROR: .deb package name is not judge-desk" >&2
  exit 1
fi
if ! grep -q 'bubblewrap' <<<"$control_info"; then
  echo "ERROR: .deb package Depends is missing bubblewrap" >&2
  exit 1
fi
if ! grep -q 'libgtk-3-0t64 | libgtk-3-0' <<<"$control_info"; then
  echo "ERROR: .deb package Depends is missing cross-Ubuntu GTK3 dependency alternative" >&2
  exit 1
fi

contents_info="$(dpkg-deb -c "$deb_file")"
if ! grep -q 'usr/bin/judgedesk-executor' <<<"$contents_info"; then
  echo "ERROR: .deb package is missing usr/bin/judgedesk-executor" >&2
  exit 1
fi
if ! grep -q 'usr/bin/themis-v2' <<<"$contents_info"; then
  echo "ERROR: .deb package is missing usr/bin/themis-v2" >&2
  exit 1
fi
if ! grep -q 'compiler-compat/include/bits/stdc++.h' <<<"$contents_info"; then
  echo "ERROR: .deb package is missing bundled bits/stdc++.h compatibility header" >&2
  exit 1
fi
if ! grep -q 'toolchains/scratch-linux-x64/scratch-run' <<<"$contents_info"; then
  echo "ERROR: .deb package is missing bundled toolchains/scratch-linux-x64/scratch-run" >&2
  exit 1
fi
if ! grep -q 'toolchains/scratch-linux-x64/.judgedesk-package.json' <<<"$contents_info"; then
  echo "ERROR: .deb package is missing bundled toolchains/scratch-linux-x64/.judgedesk-package.json" >&2
  exit 1
fi

release_version="$(node -p "require('./package.json').version")"
mkdir -p "$app_root/release-assets-linux"
rm -f "$app_root/release-assets-linux/"*

installed_kb="$(dpkg-deb -f "$deb_file" Installed-Size)"
installed_size_bytes="$(( installed_kb * 1024 ))"
if [[ "$installed_size_bytes" -le 0 ]]; then
  echo "ERROR: .deb package did not report a positive Installed-Size" >&2
  exit 1
fi

write_linux_metadata() {
  local bundle_path="$1"
  printf '{\n  "schemaVersion": 1,\n  "edition": "core",\n  "platform": "linux",\n  "arch": "x86_64",\n  "installedSizeBytes": %s\n}\n' \
    "$installed_size_bytes" > "${bundle_path}.metadata.json"
}

staged_deb="$app_root/release-assets-linux/JudgeDesk_${release_version}_${deb_arch}.deb"
cp "$deb_file" "$staged_deb"
write_linux_metadata "$staged_deb"

rpm_files=("$bundle_root"/rpm/*.rpm)
if [[ "${#rpm_files[@]}" -gt 0 ]]; then
  staged_rpm="$app_root/release-assets-linux/JudgeDesk-${release_version}-1.${rpm_arch}.rpm"
  cp "${rpm_files[0]}" "$staged_rpm"
  write_linux_metadata "$staged_rpm"
fi

appimage_files=("$bundle_root"/appimage/*.AppImage)
if [[ "${#appimage_files[@]}" -gt 0 ]]; then
  staged_appimage="$app_root/release-assets-linux/JudgeDesk_${release_version}_${deb_arch}.AppImage"
  cp "${appimage_files[0]}" "$staged_appimage"
  write_linux_metadata "$staged_appimage"
fi

(
  cd "$app_root/release-assets-linux"
  sha256sum JudgeDesk_*.deb JudgeDesk-*.rpm JudgeDesk_*.AppImage > SHA256SUMS-linux
  cat SHA256SUMS-linux
)

echo "Linux release artifacts staged in $app_root/release-assets-linux"
echo "Verify installation with: sudo apt install ./release-assets-linux/JudgeDesk_${release_version}_${deb_arch}.deb && dpkg -s judge-desk"
