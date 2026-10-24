#!/usr/bin/env bash
set -euo pipefail

app_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
evidence="${1:-$app_root/artifacts/linux-deb-$(date +%Y%m%d-%H%M%S)}"
python3 "$app_root/scripts/verify-linux-package.py" \
  --app /usr/bin/themis-v2 --bundle-type deb --evidence "$evidence"
