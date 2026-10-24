#!/usr/bin/env bash
set -euo pipefail

bundle_root="${1:?Expected Tauri bundle directory}"
report_root="${2:?Expected report directory}"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d /tmp/judgedesk-elf-baseline.XXXXXX)"
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$report_root"
shopt -s nullglob
count=0

for bundle in "$bundle_root"/deb/*.deb "$bundle_root"/rpm/*.rpm "$bundle_root"/appimage/*.AppImage; do
  count=$((count + 1))
  label="$(basename "$bundle")"
  payload="$work/$count"
  mkdir "$payload"
  case "$bundle" in
    *.deb) dpkg-deb --extract "$bundle" "$payload" ;;
    *.rpm)
      rpm --checksig "$bundle"
      # A filename argument writes a sibling .tar on rpm 4.17; stdin is portable.
      rpm2archive --nocompression - < "$bundle" > "$work/payload.tar"
      tar --no-same-owner -xf "$work/payload.tar" -C "$payload"
      ;;
    *.AppImage)
      # Inspect the outer runtime as well as all files in the squashfs payload.
      python3 "$repo/scripts/verify-linux-elf-baseline.py" "$bundle" --report "$report_root/$label.runtime.elf.json"
      offset="$("$bundle" --appimage-offset)"
      [[ "$offset" =~ ^[0-9]+$ ]]
      unsquashfs -no-progress -offset "$offset" -d "$payload/AppDir" "$bundle" > /dev/null
      ;;
  esac
  python3 "$repo/scripts/verify-linux-elf-baseline.py" "$payload" --report "$report_root/$label.elf.json"
  # Keep peak extraction space to one payload. Reports retain every ELF digest.
  [[ "$payload" == "$work/"* ]] || { echo 'ERROR: Unsafe verification temporary path' >&2; exit 1; }
  rm -rf -- "$payload"
  rm -f -- "$work/payload.tar"
done
[[ "$count" -gt 0 ]] || { echo 'ERROR: No Linux bundles inspected' >&2; exit 1; }
