#!/usr/bin/env bash
set -euo pipefail

app_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$app_root"

export PATH="$HOME/.cargo/bin:/usr/local/bin:$PATH"

arch="$(uname -m)"
# Build on the oldest supported userspace. A newer host can silently bundle
# libraries that require newer GLIBC even when the application itself is old.
source /etc/os-release
if [[ "$ID" != ubuntu || "$VERSION_ID" != 22.04 ]]; then
  echo "ERROR: Linux release packages must be built on Ubuntu 22.04 (GLIBC 2.35 baseline)" >&2
  exit 1
fi
case "$arch" in
  x86_64)
    target="x86_64-unknown-linux-gnu"
    deb_arch="amd64"
    rpm_arch="x86_64"
    scratch_zip_name="scratch-run_0.1.7_linux_amd64.zip"
    scratch_zip_sha256="e4eac2d97021c2ca8cdfb8b3001306c830614a6b6966c30cc901442441896185"
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

edition="${JUDGEDESK_LINUX_EDITION:-core}"
case "$edition" in
  core) tauri_config=src-tauri/tauri.linux.local.conf.json ;;
  full) tauri_config=src-tauri/tauri.linux.full.local.conf.json ;;
  *) echo 'ERROR: JUDGEDESK_LINUX_EDITION must be core or full' >&2; exit 1 ;;
esac
export JUDGEDESK_LINUX_EDITION="$edition"
# These data-only resources can inherit 0777 from a Windows/DrvFS snapshot.
# RPM preserves source modes; declare their machine-wide install permissions.
chmod 644 "$app_root/sandbox/Dockerfile" "$app_root/compiler-compat/include/bits/stdc++.h"
if [[ "$edition" == full ]]; then
  node --import tsx scripts/validate-linux-full-resources.ts
  python3 scripts/verify-linux-elf-baseline.py build/distribution-resources \
    --report build/linux-full-resource-elf.json
  export JUDGEDESK_PRISTINE_TOOLCHAINS_DIR="$app_root/build/distribution-resources/toolchains"
fi

echo "Building fresh frontend bundle from Linux dependencies..."
npm run build:frontend

if [[ "$edition" == full ]]; then
  scratch_pkg_dir="$app_root/build/distribution-resources/toolchains/scratch-linux-x64"
else
  scratch_pkg_dir="$app_root/src-tauri/toolchains/scratch-linux-x64"
  scratch_cache_dir="${CARGO_TARGET_DIR:-/tmp}/judgedesk-toolchain-cache"
  mkdir -p "$scratch_cache_dir"
  scratch_zip="$scratch_cache_dir/$scratch_zip_name"
  if [[ ! -f "$scratch_zip" ]]; then
    curl -fsSL "https://github.com/VNOI-Admin/scratch-run/releases/download/0.1.7/$scratch_zip_name" -o "${scratch_zip}.download"
    mv -- "${scratch_zip}.download" "$scratch_zip"
  fi
  # Revalidate on every build, including builds that already have an executable.
  python3 scripts/stage-linux-scratch.py "$scratch_zip" "$scratch_zip_sha256" "$scratch_pkg_dir"
  "$scratch_pkg_dir/scratch-run" --version
  if [[ ! -f "$scratch_pkg_dir/LICENSE" ]]; then
    curl -fsSL "https://raw.githubusercontent.com/VNOI-Admin/scratch-run/0.1.7/LICENSE" -o "$scratch_pkg_dir/LICENSE"
  fi
fi
export JUDGEDESK_PRISTINE_SCRATCH="$scratch_pkg_dir/scratch-run"
export JUDGEDESK_REAL_PATCHELF="$(command -v patchelf)"
chmod 755 "$app_root/scripts/linux-patchelf.sh"
export PATCHELF="$app_root/scripts/linux-patchelf.sh"

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

tauri_bin="${JUDGEDESK_TAURI_CLI:-$app_root/node_modules/.bin/tauri}"
expected_cli="$(node -p 'require("./package-lock.json").packages["node_modules/@tauri-apps/cli"].version')"
if [[ "$("$tauri_bin" --version)" != "tauri-cli $expected_cli" ]]; then
  echo "ERROR: Linux packaging requires the locked Tauri CLI $expected_cli" >&2
  exit 1
fi
# An older cached linuxdeploy/plugin can survive a CLI update. Isolate this
# build-tool cache by locked CLI version instead of silently reusing that copy.
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}/judgedesk-packaging-$expected_cli"

tauri_target_root="${CARGO_TARGET_DIR:-$app_root/src-tauri/target}"
bundle_root="$tauri_target_root/release/bundle"
if [[ -d "$tauri_target_root/$target/release/bundle" ]]; then
  bundle_root="$tauri_target_root/$target/release/bundle"
fi
rm -rf "$bundle_root/deb" "$bundle_root/rpm" "$bundle_root/appimage"

bundles="${JUDGEDESK_LINUX_BUNDLES:-deb,rpm,appimage}"
echo "Building Tauri Linux bundles ($bundles) for $target..."
if [[ "$edition" == full && ",$bundles," == *,appimage,* ]]; then
  # linuxdeploy traces every ELF under usr/lib, including compiler sysroots.
  # Deploy desktop dependencies first; add verified SDKs before SquashFS only.
  desktop_bundles="${bundles//appimage/}"
  desktop_bundles="${desktop_bundles#,}"
  desktop_bundles="${desktop_bundles%,}"
  desktop_bundles="${desktop_bundles//,,/,}"
  if [[ -n "$desktop_bundles" ]]; then
    "$tauri_bin" build --bundles "$desktop_bundles" --config "$tauri_config" -- --locked
  else
    "$tauri_bin" build --no-bundle --config "$tauri_config" -- --locked
  fi
  "$tauri_bin" bundle --bundles appimage --config src-tauri/tauri.linux.full.appimage.local.conf.json
else
  "$tauri_bin" build --bundles "$bundles" --config "$tauri_config" -- --locked
fi

if [[ -d "$tauri_target_root/$target/release/bundle" ]]; then
  bundle_root="$tauri_target_root/$target/release/bundle"
fi

if [[ ",$bundles," == *,appimage,* ]]; then
  # AppRun must capture the host environment before its GTK hook and wrapped
  # launcher change it. Repack with the same output tool Tauri just used; do not
  # run linuxdeploy again (which would patch the verified runtime payloads).
  appdir="$bundle_root/appimage/JudgeDesk.AppDir"
  if [[ "$edition" == full ]]; then
    full_destination="$appdir/usr/lib/JudgeDesk"
    [[ -d "$full_destination" && ! -L "$full_destination" && ! -e "$full_destination/toolchains" ]] || {
      echo 'ERROR: Full AppImage desktop must be staged without toolchain payloads' >&2; exit 1;
    }
    cp -a -- "$app_root/build/distribution-resources/." "$full_destination/"
    python3 scripts/verify-linux-elf-baseline.py "$appdir" --report "$bundle_root/full-appdir-elf.json"
  fi
  python3 scripts/prepare-linux-apprun.py "$appdir"
  appimage_plugin="$XDG_CACHE_HOME/tauri/linuxdeploy-plugin-appimage.AppImage"
  [[ -x "$appimage_plugin" ]] || { echo 'ERROR: Tauri AppImage output plugin is missing' >&2; exit 1; }
  appimage_file="$bundle_root/appimage/JudgeDesk_$(node -p 'require("./package.json").version')_${deb_arch}.AppImage"
  repacked="$bundle_root/appimage/.judgedesk-host-env.AppImage"
  OUTPUT="$repacked" ARCH="$arch" "$appimage_plugin" --appdir "$appdir"
  [[ -s "$repacked" ]] || { echo 'ERROR: AppImage repack did not produce an artifact' >&2; exit 1; }
  chmod 755 "$repacked"
  mv -- "$repacked" "$appimage_file"
fi

for bundle_type in ${bundles//,/ }; do
  case "$bundle_type" in
    deb) extension=deb ;;
    rpm) extension=rpm ;;
    appimage) extension=AppImage ;;
    *) echo "ERROR: Unsupported Linux bundle type: $bundle_type" >&2; exit 1 ;;
  esac
  if ! compgen -G "$bundle_root/$bundle_type/*.$extension" > /dev/null; then
    echo "ERROR: Requested $bundle_type artifact was not produced" >&2
    exit 1
  fi
done
bash scripts/verify-linux-runtime-payloads.sh "$scratch_pkg_dir/scratch-run" "$bundle_root"
echo "Verifying all final package ELFs, including AppImage runtime and bundled libraries..."
bash scripts/verify-linux-bundle-baseline.sh "$bundle_root" "$bundle_root/elf-baseline"

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
release_assets="$app_root/release-assets-linux"
edition_suffix=""
rpm_edition_suffix=""
if [[ "$edition" == full ]]; then
  release_assets="$release_assets/full"
  edition_suffix="_full"
  rpm_edition_suffix="-full"
fi
mkdir -p "$release_assets"
rm -f "$release_assets/"*

installed_kb="$(dpkg-deb -f "$deb_file" Installed-Size)"
installed_size_bytes="$(( installed_kb * 1024 ))"
if [[ "$installed_size_bytes" -le 0 ]]; then
  echo "ERROR: .deb package did not report a positive Installed-Size" >&2
  exit 1
fi

write_linux_metadata() {
  local bundle_path="$1"
  printf '{\n  "schemaVersion": 1,\n  "edition": "%s",\n  "platform": "linux",\n  "arch": "x86_64",\n  "installedSizeBytes": %s\n}\n' \
    "$edition" "$installed_size_bytes" > "${bundle_path}.metadata.json"
}

staged_deb="$release_assets/JudgeDesk_${release_version}${edition_suffix}_${deb_arch}.deb"
cp "$deb_file" "$staged_deb"
write_linux_metadata "$staged_deb"

rpm_files=("$bundle_root"/rpm/*.rpm)
if [[ "${#rpm_files[@]}" -gt 0 ]]; then
  staged_rpm="$release_assets/JudgeDesk-${release_version}${rpm_edition_suffix}-1.${rpm_arch}.rpm"
  cp "${rpm_files[0]}" "$staged_rpm"
  write_linux_metadata "$staged_rpm"
fi

appimage_files=("$bundle_root"/appimage/*.AppImage)
if [[ "${#appimage_files[@]}" -gt 0 ]]; then
  staged_appimage="$release_assets/JudgeDesk_${release_version}${edition_suffix}_${deb_arch}.AppImage"
  cp "${appimage_files[0]}" "$staged_appimage"
  write_linux_metadata "$staged_appimage"
fi

(
  cd "$release_assets"
  sha256sum JudgeDesk_*.deb JudgeDesk-*.rpm JudgeDesk_*.AppImage > SHA256SUMS-linux
  cat SHA256SUMS-linux
)

echo "Linux $edition artifacts staged in $release_assets"
echo "Verify installation with: sudo apt install --reinstall $staged_deb && dpkg -s judge-desk"
