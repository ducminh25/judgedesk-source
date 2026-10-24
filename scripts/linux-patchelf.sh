#!/usr/bin/env bash
set -euo pipefail

# Full SDKs are verified as complete trees. Their vendor RPATHs have already
# passed relocation probes; linuxdeploy must not invalidate the pinned bytes.
if [[ -n "${JUDGEDESK_PRISTINE_TOOLCHAINS_DIR:-}" && "$#" -gt 0 ]]; then
  full_target="${@: -1}"
  case "$full_target" in
    */usr/lib/JudgeDesk/toolchains/*)
      relative="${full_target#*/usr/lib/JudgeDesk/toolchains/}"
      case "/$relative/" in
        */../*|*/./*|*\\*) echo 'ERROR: Unsafe Full payload path' >&2; exit 1 ;;
      esac
      pristine="$JUDGEDESK_PRISTINE_TOOLCHAINS_DIR/$relative"
      if [[ ! -f "$pristine" || -L "$pristine" || -L "$full_target" ]] || ! cmp -s -- "$pristine" "$full_target"; then
        echo "ERROR: Full runtime changed before ELF protection: $full_target" >&2
        exit 1
      fi
      case "${1:-}" in
        --set-rpath)
          echo "Preserving verified Full payload bytes: $full_target" >&2
          exit 0 ;;
        --print-rpath|--print-needed|--print-interpreter|--print-soname|--print-os-abi)
          exec "${JUDGEDESK_REAL_PATCHELF:?}" "$@" ;;
        *) echo "ERROR: Unsupported mutation of an immutable Full payload: ${1:-}" >&2; exit 1 ;;
      esac
      ;;
  esac
fi

# pkg stores absolute offsets into its own executable. Rewriting its ELF RPATH
# moves the appended payload even when NO_STRIP is set. Dependency discovery and
# all ordinary ELF files still go through the real patchelf.
if [[ "${1:-}" == "--set-rpath" ]]; then
  target="${@: -1}"
  case "$target" in
    */usr/lib/JudgeDesk/toolchains/scratch-linux-x64/scratch-run)
      if ! cmp -s -- "${JUDGEDESK_PRISTINE_SCRATCH:?}" "$target"; then
        echo "ERROR: Scratch runtime changed before RPATH protection: $target" >&2
        exit 1
      fi
      echo "Preserving pkg executable bytes: $target" >&2
      exit 0
      ;;
  esac
fi
exec "${JUDGEDESK_REAL_PATCHELF:?}" "$@"
