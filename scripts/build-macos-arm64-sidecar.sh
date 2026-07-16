#!/usr/bin/env bash
set -euo pipefail

app_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$app_root"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "This script requires an Apple Silicon macOS host." >&2
  exit 1
fi

TAURI_TARGET=aarch64-apple-darwin npm run build:server
sidecar="src-tauri/binaries/server-aarch64-apple-darwin"
chmod +x "$sidecar"
lipo "$sidecar" -verify_arch arm64
node scripts/smoke-test-sidecar.js "$sidecar"

echo "The Apple Silicon sidecar passed its smoke test."
