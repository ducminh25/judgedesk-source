#!/usr/bin/env bash
set -euo pipefail

app_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$app_root"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "This script requires an Apple Silicon macOS host." >&2
  exit 1
fi

TAURI_TARGET=aarch64-apple-darwin npm run build:executor
TAURI_TARGET=aarch64-apple-darwin npm run build:server
sidecar="src-tauri/binaries/server-aarch64-apple-darwin"
executor="src-tauri/binaries/judgedesk-executor-aarch64-apple-darwin"
chmod +x "$sidecar"
chmod +x "$executor"
lipo "$sidecar" -verify_arch arm64
lipo "$executor" -verify_arch arm64

echo "[macOS diagnostics] Checking the executor before the security gate."
if "$executor" --test-sleep-ms 1; then
  echo "[macOS diagnostics] Direct executor launch passed."
else
  echo "[macOS diagnostics] Direct executor launch failed with status $?." >&2
fi
if /usr/bin/sandbox-exec -p '(version 1)(allow default)' "$executor" --test-sleep-ms 1; then
  echo "[macOS diagnostics] sandbox-exec allow-default launch passed."
else
  echo "[macOS diagnostics] sandbox-exec allow-default launch failed with status $?." >&2
fi

node scripts/smoke-test-sidecar.js "$sidecar"

echo "[macOS diagnostics] Recent executor and sandbox log entries:"
/usr/bin/log show --last 3m --style compact \
  --predicate 'process == "security-probe" OR process == "sandbox-exec" OR process == "judgedesk-executor-aarch64-apple-darwin"' \
  2>/dev/null | tail -n 200 || true
diagnostic_root="$HOME/Library/Logs/DiagnosticReports"
if [[ -d "$diagnostic_root" ]]; then
  while IFS= read -r -d '' report; do
    echo "[macOS diagnostics] Crash report: $report"
    tail -n 160 "$report" || true
  done < <(find "$diagnostic_root" -type f -mmin -5 -print0)
fi

npm run test:executor
npx tsx --test server/executor-tests/security.integration.test.ts

echo "The Apple Silicon sidecar passed smoke, executor, and security tests."
