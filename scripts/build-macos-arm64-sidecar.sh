#!/usr/bin/env bash
set -euo pipefail

app_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$app_root"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "This script requires an Apple Silicon macOS host." >&2
  exit 1
fi

# Keep kernel-backed process containment and its hostile regression probe as mandatory release
# contracts. The dynamic security suite below proves the behavior on the M2 builder; these checks
# prevent a future refactor from silently deleting the hard limit or the fork-bomb case while
# leaving a superficially green release workflow behind.
grep -Fq 'set_limit(libc::RLIMIT_NPROC' native-executor/src/platform/macos.rs
grep -Fq -- '--test-process-bomb' native-executor/src/main.rs
grep -Fq 'kernel process ceiling contains a real process bomb' \
  server/executor-tests/security.integration.test.ts

TAURI_TARGET=aarch64-apple-darwin npm run build:executor
TAURI_TARGET=aarch64-apple-darwin npm run build:server
sidecar="src-tauri/binaries/server-aarch64-apple-darwin"
executor="src-tauri/binaries/judgedesk-executor-aarch64-apple-darwin"
chmod +x "$sidecar"
chmod +x "$executor"
lipo "$sidecar" -verify_arch arm64
lipo "$executor" -verify_arch arm64

node scripts/smoke-test-sidecar.js "$sidecar"

npm run test:executor
npx tsx --test server/executor-tests/security.integration.test.ts
npx tsx scripts/smoke-test-macos-compiler.ts

python_smoke_data="$(mktemp -d)"
cleanup_python_smoke() {
  rm -rf "$python_smoke_data"
}
trap cleanup_python_smoke EXIT
THEMIS_APP_DATA_DIR="$python_smoke_data" \
  JUDGEDESK_SMOKE_INSTALL_MANAGED_PYTHON=1 \
  npx tsx scripts/smoke-test-managed-python.ts

echo "The Apple Silicon sidecar passed smoke, executor, security, compiler, and managed Python tests."
