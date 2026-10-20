#!/usr/bin/env bash
set -euo pipefail

work="$(mktemp -d /tmp/jd-deb-e2e.XXXXXX)"
app_pid=""
cleanup() {
  if [[ -n "$app_pid" ]]; then
    kill -TERM "$app_pid" 2>/dev/null || true
    wait "$app_pid" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

mkdir -p "$work/contestants/alice" "$work/contestants/bob" "$work/tests/A/01" "$work/data" "$work/appdata"
cat <<'EOF' > "$work/contestants/alice/A.cpp"
#include <bits/stdc++.h>
using namespace std;
int main() {
    if (FILE* f = fopen("A.inp", "r")) {
        fclose(f);
        (void)freopen("A.inp", "r", stdin);
        (void)freopen("A.out", "w", stdout);
    }
    long long a = 0, b = 0;
    if (cin >> a >> b) {
        cout << (a + b) << "\n";
    }
    return 0;
}
EOF
cat <<'EOF' > "$work/contestants/bob/A.py"
import os, sys
if os.path.exists("A.inp"):
    with open("A.inp", "r") as fin, open("A.out", "w") as fout:
        a, b = map(int, fin.read().split())
        fout.write(f"{a + b}\n")
else:
    a, b = map(int, sys.stdin.read().split())
    print(a + b)
EOF
printf '10 32\n' > "$work/tests/A/01/A.inp"
printf '42\n' > "$work/tests/A/01/A.out"

token="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
XDG_DATA_HOME="$work/data" \
THEMIS_APP_DATA_DIR="$work/appdata" \
JUDGEDESK_API_TOKEN="$token" \
WEBKIT_DISABLE_COMPOSITING_MODE=1 \
  systemd-run --user --scope -p Delegate=yes /usr/bin/themis-v2 > "$work/app.log" 2>&1 &
app_pid="$!"

port=""
for _ in $(seq 1 150); do
  if grep -q "Pure Rust Native Core running directly on port" "$work/app.log" 2>/dev/null; then
    port="$(sed -n 's/.*Pure Rust Native Core running directly on port \([0-9]*\).*/\1/p' "$work/app.log" | head -n 1)"
    break
  fi
  sleep 0.1
done

cat "$work/app.log"
if [[ -z "$port" ]]; then
  echo "ERROR: Packaged /usr/bin/themis-v2 did not bind its embedded Rust server port" >&2
  exit 1
fi
echo "Packaged JudgeDesk embedded server listening on port $port"

status_ready=0
for _ in $(seq 1 150); do
  status_json="$(curl -fsS -H "X-JudgeDesk-Session: $token" "http://127.0.0.1:$port/api/status" || true)"
  if grep -q '"ready":true' <<<"$status_json" && grep -q '"installed":true' <<<"$status_json"; then
    echo "Status ready: $status_json"
    status_ready=1
    break
  fi
  sleep 0.1
done
if [[ "$status_ready" -ne 1 ]]; then
  echo "ERROR: Packaged JudgeDesk did not report ready C++ compiler + secureRunner" >&2
  exit 1
fi

dist_json="$(curl -fsS -H "X-JudgeDesk-Session: $token" "http://127.0.0.1:$port/api/distribution")"
echo "Distribution identity: $dist_json"
if ! grep -q '"bundleType":"deb"' <<<"$dist_json"; then
  echo "ERROR: Expected /api/distribution to report bundleType=deb for installed .deb package" >&2
  exit 1
fi

payload="$(printf '{"thisinhPath":"%s/contestants","testPath":"%s/tests","targetContestants":["alice","bob"],"targetProblems":["A"],"problemConfigs":{},"jobId":"deb_e2e_1"}' "$work" "$work")"
judge_out="$(curl -fsS -N -X POST "http://127.0.0.1:$port/api/batch-judge" \
  -H "Content-Type: application/json" \
  -H "X-JudgeDesk-Session: $token" \
  -d "$payload")"
echo "Batch judge output:"
printf '%s\n' "$judge_out"

ac_count="$(grep -o '"status":"AC"' <<<"$judge_out" | wc -l | tr -d ' ')"
if [[ "$ac_count" -lt 4 ]]; then
  echo "ERROR: Expected AC status for both C++ and Python contestants (got $ac_count AC occurrences)" >&2
  exit 1
fi

curl -fsS -X POST "http://127.0.0.1:$port/api/shutdown" -H "X-JudgeDesk-Session: $token"
echo ""
kill -TERM "$app_pid" 2>/dev/null || true
wait "$app_pid" 2>/dev/null || true
app_pid=""

for _ in $(seq 1 50); do
  if ! pgrep -f "/usr/bin/judgedesk-executor|--judgedesk-internal-job-supervisor-v1" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
if pgrep -f "/usr/bin/judgedesk-executor|--judgedesk-internal-job-supervisor-v1" >/dev/null 2>&1; then
  echo "ERROR: Orphan executor or supervisor process remained after shutdown" >&2
  exit 1
fi

echo "E2E_DEB_VERIFIED_OK"
