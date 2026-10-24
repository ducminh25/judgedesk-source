#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python3 "$repo/scripts/test-linux-apprun.py"
python3 "$repo/scripts/test-linux-upstream.py"
work="$(mktemp -d /tmp/judgedesk-packaging-test.XXXXXX)"
trap 'rm -rf -- "$work"' EXIT
target="$work/JudgeDesk.AppDir/usr/lib/JudgeDesk/toolchains/scratch-linux-x64/scratch-run"
mkdir -p "$(dirname "$target")"
printf 'pkg-payload-with-fixed-offsets\n' > "$target"
cp "$target" "$work/pristine"
cat > "$work/patchelf" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == "--print-rpath" ]]; then
  printf 'original-rpath\n'
else
  printf 'mutated\n' >> "${@: -1}"
fi
EOF
chmod +x "$work/patchelf"
export JUDGEDESK_REAL_PATCHELF="$work/patchelf"
export JUDGEDESK_PRISTINE_SCRATCH="$work/pristine"
bash "$repo/scripts/linux-patchelf.sh" --set-rpath '\$ORIGIN' "$target"
cmp "$target" "$work/pristine"
[[ "$(bash "$repo/scripts/linux-patchelf.sh" --print-rpath "$target")" == "original-rpath" ]]
printf 'ordinary-elf\n' > "$work/ordinary"
bash "$repo/scripts/linux-patchelf.sh" --set-rpath '\$ORIGIN' "$work/ordinary"
grep -q mutated "$work/ordinary"
printf 'damaged\n' >> "$target"
if bash "$repo/scripts/linux-patchelf.sh" --set-rpath '\$ORIGIN' "$target"; then
  echo 'ERROR: a damaged pkg payload was accepted' >&2
  exit 1
fi
echo 'Linux packaging payload protection: PASS'
full_source="$work/full-pristine"
full_target="$work/JudgeDesk.AppDir/usr/lib/JudgeDesk/toolchains/python-linux-x64/bin/python3"
mkdir -p "$full_source/python-linux-x64/bin" "$(dirname "$full_target")"
printf 'verified-full-runtime\n' > "$full_source/python-linux-x64/bin/python3"
cp "$full_source/python-linux-x64/bin/python3" "$full_target"
export JUDGEDESK_PRISTINE_TOOLCHAINS_DIR="$full_source"
bash "$repo/scripts/linux-patchelf.sh" --set-rpath '\$ORIGIN' "$full_target"
cmp "$full_source/python-linux-x64/bin/python3" "$full_target"
[[ "$(bash "$repo/scripts/linux-patchelf.sh" --print-rpath "$full_target")" == "original-rpath" ]]
printf 'damaged\n' >> "$full_target"
if bash "$repo/scripts/linux-patchelf.sh" --set-rpath '\$ORIGIN' "$full_target"; then
  echo 'ERROR: Full toolchain integrity drift was accepted' >&2
  exit 1
fi
unset JUDGEDESK_PRISTINE_TOOLCHAINS_DIR
echo 'Linux Full immutable payload protection: PASS'
python3 "$repo/scripts/test-linux-elf-baseline.py"

# Acceptance must fail before launching a process if checks are disabled or
# the artifact is not the candidate requested by the caller.
if python3 -O "$repo/scripts/verify-linux-package.py" --help > "$work/optimized.log" 2>&1; then
  echo 'ERROR: optimized Python disabled acceptance assertions' >&2
  exit 1
fi
grep -q 'Acceptance checks require Python assertions' "$work/optimized.log"
if python3 "$repo/scripts/verify-linux-package.py" --app /bin/true --bundle-type appimage \
    --artifact "$work/pristine" --artifact-sha256 invalid --evidence "$work/hash-mismatch" \
    > "$work/hash-mismatch.log" 2>&1; then
  echo 'ERROR: wrong installer hash accepted' >&2
  exit 1
fi
grep -q 'Installer SHA-256 mismatch' "$work/hash-mismatch.log"
pristine_hash="$(sha256sum "$work/pristine" | cut -d ' ' -f 1)"
if python3 "$repo/scripts/verify-linux-package.py" --app /bin/true --bundle-type appimage \
    --artifact "$work/pristine" --artifact-sha256 "$pristine_hash" --evidence "$work/path-mismatch" \
    > "$work/path-mismatch.log" 2>&1; then
  echo 'ERROR: a different AppImage launch path was accepted' >&2
  exit 1
fi
grep -q 'AppImage launch path must be the verified installer' "$work/path-mismatch.log"
echo 'Candidate identity and acceptance safeguards: PASS'

python3 - "$repo" "$work" <<'PY'
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import zipfile

repo, work = map(Path, sys.argv[1:])
spec = importlib.util.spec_from_file_location("stage_scratch", repo / "scripts/stage-linux-scratch.py")
module = importlib.util.module_from_spec(spec)
sys.dont_write_bytecode = True
spec.loader.exec_module(module)
archive = work / "scratch.zip"
with zipfile.ZipFile(archive, "w") as package:
    package.writestr("scratch-run", b"pristine-pkg-runtime")
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
destination = work / "stage"
module.stage(archive, digest, destination)
receipt = json.loads((destination / ".judgedesk-package.json").read_text())
assert set(receipt["components"][0]) == {"id", "kind", "relativePath", "roles"}
(destination / "scratch-run").write_bytes(b"corrupted-old-stage")
module.stage(archive, digest, destination)
assert (destination / "scratch-run").read_bytes() == b"pristine-pkg-runtime"
try:
    module.stage(archive, "0" * 64, destination)
except ValueError:
    pass
else:
    raise AssertionError("unverified archive was accepted")
assert (destination / "scratch-run").read_bytes() == b"pristine-pkg-runtime"
print("Verified staging and repair: PASS")
PY
