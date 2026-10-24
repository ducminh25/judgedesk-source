#!/usr/bin/env bash
set -euo pipefail

pristine="${1:?Expected pristine Scratch executable}"
bundle_root="${2:?Expected Tauri bundle directory}"
work="$(mktemp -d /tmp/judgedesk-payload-check.XXXXXX)"
trap 'rm -rf -- "$work"' EXIT
member="usr/lib/JudgeDesk/toolchains/scratch-linux-x64/scratch-run"
shopt -s nullglob

verify_payload() {
  local label="$1"
  if ! cmp -s -- "$pristine" "$work/scratch-run"; then
    echo "ERROR: $label changed the pinned Scratch executable bytes" >&2
    exit 1
  fi
  chmod 755 "$work/scratch-run"
  [[ "$("$work/scratch-run" --version)" == "0.1.7" ]]
  echo "Verified $label: Scratch bytes and bootstrap"
}

for bundle in "$bundle_root"/deb/*.deb; do
  dpkg-deb --fsys-tarfile "$bundle" | tar -xOf - "$member" > "$work/scratch-run"
  verify_payload "$(basename "$bundle")"
done
for bundle in "$bundle_root"/rpm/*.rpm; do
  # rpm2cpio 4.18 requires LONGARCHIVESIZE, which rpm-rs packages omit.
  # rpm2archive validates file metadata without depending on that optional tag.
  # Use stdin so older rpm2archive also writes the tar stream to stdout.
  rpm --checksig "$bundle"
  rpm2archive --nocompression - < "$bundle" > "$work/payload.tar"
  tar -xOf "$work/payload.tar" "./$member" > "$work/scratch-run"
  verify_payload "$(basename "$bundle")"
done
for bundle in "$bundle_root"/appimage/*.AppImage; do
  offset="$("$bundle" --appimage-offset)"
  [[ "$offset" =~ ^[0-9]+$ ]]
  unsquashfs -cat -offset "$offset" "$bundle" "$member" > "$work/scratch-run"
  verify_payload "$(basename "$bundle")"
  unsquashfs -cat -offset "$offset" "$bundle" AppRun > "$work/AppRun"
  grep -q '^# JudgeDesk host environment snapshot v1$' "$work/AppRun"
  python3 - "$work/AppRun" <<'PY'
import pathlib
import sys

script = pathlib.Path(sys.argv[1]).read_text()
marker = script.index('# JudgeDesk host environment snapshot v1')
hook = script.index('apprun-hooks')
if marker >= hook:
    raise SystemExit('AppImage environment snapshot must precede AppRun hooks')
PY
  echo 'Verified AppImage host environment capture precedes the GTK hook'
done
