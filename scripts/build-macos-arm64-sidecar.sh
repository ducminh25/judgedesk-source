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
grep -Fq 'set_limit(libc::RLIMIT_NPROC' native-executor/src/macos_launcher.rs
grep -Fq 'SYS_setpgid SYS_setsid SYS_posix_spawn' native-executor/src/platform/macos.rs
grep -Fq 'posixSpawnGroupBlockedWithEperm' native-executor/src/platform/macos.rs
grep -Fq 'libc::POSIX_SPAWN_SETPGROUP' native-executor/src/security_probe.rs
grep -Fq 'forbiddenExecBlockedWithEperm' native-executor/src/platform/macos.rs
grep -Fq 'POSIX_SPAWN_CLOEXEC_DEFAULT' native-executor/src/macos_run_guardian.rs
grep -Fq 'stop_kill_anchor_group_and_reap' native-executor/src/macos_process.rs
grep -Fq 'PREPARED_BROADCAST_ORDER' native-executor/src/macos_launcher.rs
grep -Fq 'no owned unreaped anchor pin' native-executor/src/macos_run_controller.rs
if grep -Fq 'signal_live_anchor_group' native-executor/src/macos_run_controller.rs; then
  echo "The executor controller must not regain numeric supervisor signalling authority." >&2
  exit 1
fi
grep -Fq -- '--test-process-bomb' native-executor/src/main.rs
grep -Fq 'kernel process ceiling contains a real process bomb' \
  server/executor-tests/security.integration.test.ts
grep -Fq 'macOS per-run guardian enforces destructive single-fault boundaries' \
  server/executor-tests/macos-run-guardian.integration.test.ts

executor_gate_data="$(mktemp -d)"
python_smoke_data=""
cleanup_test_data() {
  rm -rf -- "$executor_gate_data"
  if [[ -n "$python_smoke_data" ]]; then
    rm -rf -- "$python_smoke_data"
  fi
}
trap cleanup_test_data EXIT

chmod 700 "$executor_gate_data"
tree_generation="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
tree_guard="$executor_gate_data/process-tree.generation"
umask 077
printf 'JUDGEDESK_PROCESS_TREE/1\ngeneration=%s\n' "$tree_generation" >"$tree_guard"
chmod 600 "$tree_guard"
export JUDGEDESK_TREE_GUARD_REQUIRED=1
export JUDGEDESK_TREE_GUARD_PATH="$tree_guard"
export JUDGEDESK_TREE_GUARD_GENERATION="$tree_generation"

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
python_smoke_data="$(mktemp -d)"
THEMIS_APP_DATA_DIR="$python_smoke_data" \
  JUDGEDESK_SMOKE_INSTALL_MANAGED_PYTHON=1 \
  npx tsx scripts/smoke-test-managed-python.ts
THEMIS_APP_DATA_DIR="$python_smoke_data" \
  npx tsx --test server/executor-tests/security.integration.test.ts
JUDGEDESK_RUN_GUARDIAN_FAULT_GATE=1 \
  npx tsx --test server/executor-tests/macos-run-guardian.integration.test.ts
npx tsx scripts/smoke-test-macos-compiler.ts

echo "The Apple Silicon sidecar passed smoke, executor, guardian fault, security, compiler, and managed Python tests."
