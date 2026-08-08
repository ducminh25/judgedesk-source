#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "This gate requires an Apple Silicon macOS host." >&2
  exit 1
fi

app_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app="${JUDGEDESK_GATE_APP:-$app_root/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/JudgeDesk.app}"
bin="$app/Contents/MacOS"
gui_command="$bin/themis-v2"
helper_command="$gui_command --judgedesk-internal-job-supervisor-v1"
server_command="$bin/server"
executor_command="$bin/judgedesk-executor"
run_guardian_command="$executor_command --judgedesk-macos-run-guardian"
run_supervisor_command="$executor_command --judgedesk-macos-run-supervisor"
fixture=""
curl_pid=""
secondary_monitor_pid=""
gate_started_app=0
active_pgid=""
active_executor=""
active_guardian=""
active_anchor=""
gate_shell_pgid="$(ps -o pgid= -p $$ | tr -d ' ')"
executor_root="${TMPDIR:-/tmp}"
executor_root="${executor_root%/}/JudgeDeskExecutor"

fail() {
  echo "macOS process-supervisor gate failed: $*" >&2
  exit 1
}

report_unexpected_error() {
  local status="$1"
  local line="$2"
  local command="$3"
  echo "macOS process-supervisor gate aborted at line $line: $command (status $status)" >&2
  return "$status"
}
trap 'report_unexpected_error "$?" "$LINENO" "$BASH_COMMAND"' ERR

exact_pids() {
  local wanted="$1"
  ps -axo pid=,command= | awk -v wanted="$wanted" '
    {
      pid = $1
      $1 = ""
      sub(/^[[:space:]]+/, "")
      if ($0 == wanted) print pid
    }
  '
}

exact_count() {
  local count
  count="$(exact_pids "$1" | wc -l | tr -d ' ')"
  echo "${count:-0}"
}

pid_matches() {
  local pid="$1"
  local wanted="$2"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  [[ "$(ps -o command= -p "$pid" 2>/dev/null || true)" == "$wanted" ]]
}

parent_pid() {
  ps -o ppid= -p "$1" 2>/dev/null | tr -d ' '
}

only_pid() {
  local label="$1"
  local command="$2"
  local pids
  pids="$(exact_pids "$command")"
  [[ "$(printf '%s\n' "$pids" | sed '/^$/d' | wc -l | tr -d ' ')" == "1" ]] ||
    fail "expected exactly one $label process"
  printf '%s\n' "$pids"
}

process_count() {
  local total=0
  local command
  for command in "$gui_command" "$helper_command" "$server_command" "$executor_command"; do
    total=$((total + $(exact_count "$command")))
  done
  echo "$total"
}

directory_entry_count() {
  local directory="$1"
  if [[ ! -d "$directory" ]]; then
    echo 0
    return 0
  fi
  find "$directory" -mindepth 1 -maxdepth 1 -print | wc -l | tr -d ' '
}

inventory() {
  ps -axo pid=,ppid=,pgid=,state=,command= |
    grep -F "$bin/" |
    grep -v grep || true
}

all_judgedesk_runtime_inventory() {
  ps -axo pid=,ppid=,pgid=,state=,command= |
    awk '$0 ~ /\/JudgeDesk[.]app\/Contents\/MacOS\/(themis-v2|server|judgedesk-executor)( |$)/ { print }'
}

wait_for_inventory() {
  local expected="$1"
  local attempts="${2:-500}"
  local index
  for ((index = 0; index < attempts; index++)); do
    if [[ "$(process_count)" == "$expected" ]]; then
      return 0
    fi
    sleep 0.02
  done
  inventory >&2
  fail "timed out waiting for $expected JudgeDesk processes"
}

wait_for_listening_port() {
  local pid="$1"
  local attempts="${2:-500}"
  local candidate
  local index
  for ((index = 0; index < attempts; index++)); do
    candidate="$(
      lsof -Pan -p "$pid" -iTCP -sTCP:LISTEN -Fn 2>/dev/null |
        sed -n 's/^n127\.0\.0\.1://p' |
        head -n 1 || true
    )"
    if [[ "$candidate" =~ ^[0-9]+$ ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
    sleep 0.02
  done
  return 1
}

wait_for_cpp_submission_ready() {
  local port="$1"
  local last_status=""
  local index
  for ((index = 0; index < 300; index++)); do
    last_status="$(
      curl -fsS --max-time 2 "http://127.0.0.1:$port/api/status" 2>/dev/null || true
    )"
    if [[ -n "$last_status" ]] && printf '%s' "$last_status" | node -e '
      let body = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { body += chunk; });
      process.stdin.on("end", () => {
        try {
          process.exit(JSON.parse(body)?.gpp?.submissionReady === true ? 0 : 1);
        } catch {
          process.exit(1);
        }
      });
    '; then
      return 0
    fi
    sleep 0.1
  done
  printf 'Last packaged status: %s\n' "${last_status:-unavailable}" >&2
  return 1
}

assert_full_generation() {
  [[ "$(exact_count "$gui_command")" == "1" ]] || fail "GUI count is not one"
  [[ "$(exact_count "$helper_command")" == "1" ]] || fail "helper count is not one"
  [[ "$(exact_count "$server_command")" == "1" ]] || fail "backend count is not one"
  [[ "$(exact_count "$executor_command")" == "1" ]] || fail "executor count is not one"
}

quit_app() {
  local gui_pid
  gui_pid="$(only_pid GUI "$gui_command")"
  osascript -e 'tell application id "com.themisv2.judge" to quit' >/dev/null 2>&1 || true
  for ((index = 0; index < 500; index++)); do
    [[ "$(process_count)" == "0" ]] && return 0
    sleep 0.02
  done
  if pid_matches "$gui_pid" "$gui_command"; then
    kill -TERM "$gui_pid" >/dev/null 2>&1 || true
  fi
  for ((index = 0; index < 250; index++)); do
    [[ "$(process_count)" == "0" ]] && return 0
    sleep 0.02
  done
  if pid_matches "$gui_pid" "$gui_command"; then
    kill -KILL "$gui_pid" >/dev/null 2>&1 || true
  fi
  wait_for_inventory 0 500
}

cleanup_submission_group() {
  [[ "$active_pgid" =~ ^[0-9]+$ ]] || return 0
  ((active_pgid > 1)) || return 0
  [[ "$active_pgid" != "$gate_shell_pgid" ]] || return 0
  local members
  local invalid_members
  members="$(
    ps -axo pid=,pgid=,command= |
      awk -v pgid="$active_pgid" '$2 == pgid { print }'
  )"
  [[ -n "$members" ]] || return 0
  if [[ "$active_anchor" != "$active_pgid" ]] ||
    ! pid_matches "$active_anchor" "$run_supervisor_command" ||
    ! pid_matches "$active_guardian" "$run_guardian_command" ||
    [[ "$(parent_pid "$active_anchor")" != "$active_guardian" ]] ||
    [[ "$(parent_pid "$active_guardian")" != "$active_executor" ]]; then
    echo "Refusing to clean a submission group without the exact executor -> guardian -> supervisor identity chain." >&2
    return 0
  fi
  invalid_members="$(
    printf '%s\n' "$members" |
      awk -v anchor="$active_anchor" -v supervisor="$run_supervisor_command" '
        {
          pid = $1
          $1 = ""
          $2 = ""
          sub(/^[[:space:]]+/, "")
          if (pid == anchor && $0 == supervisor) next
          if (index($0, "/JudgeDeskExecutor/workspaces/") > 0) next
          print
        }
      '
  )"
  if [[ -n "$invalid_members" ]]; then
    echo "Refusing to clean unverified process group $active_pgid:" >&2
    printf '%s\n' "$invalid_members" >&2
    return 0
  fi
  # Freeze the test-owned group before killing it so a hostile descendant cannot
  # race cleanup by forking or execing after the command inventory was verified.
  kill -STOP -- "-$active_pgid" >/dev/null 2>&1 || true
  kill -KILL -- "-$active_pgid" >/dev/null 2>&1 || true
  for ((index = 0; index < 200; index++)); do
    if ! ps -axo pgid= | awk -v pgid="$active_pgid" '$1 == pgid { found = 1 } END { exit found ? 0 : 1 }'; then
      return 0
    fi
    sleep 0.01
  done
  echo "Test-owned submission process group $active_pgid did not become empty after SIGKILL." >&2
}

cleanup() {
  local status=$?
  trap - ERR EXIT INT TERM
  set +e
  if [[ -n "$secondary_monitor_pid" ]]; then
    kill "$secondary_monitor_pid" >/dev/null 2>&1 || true
    wait "$secondary_monitor_pid" >/dev/null 2>&1 || true
  fi
  if [[ -n "$curl_pid" ]]; then
    kill "$curl_pid" >/dev/null 2>&1 || true
    wait "$curl_pid" >/dev/null 2>&1 || true
  fi
  cleanup_submission_group
  if [[ "$gate_started_app" == "1" ]] && [[ "$(process_count)" != "0" ]]; then
    for gui_pid in $(exact_pids "$gui_command"); do
      if pid_matches "$gui_pid" "$gui_command"; then
        kill -TERM "$gui_pid" >/dev/null 2>&1 || true
      fi
    done
    for ((index = 0; index < 250; index++)); do
      [[ "$(process_count)" == "0" ]] && break
      sleep 0.02
    done
    for gui_pid in $(exact_pids "$gui_command"); do
      if pid_matches "$gui_pid" "$gui_command"; then
        kill -KILL "$gui_pid" >/dev/null 2>&1 || true
      fi
    done
    for ((index = 0; index < 500; index++)); do
      [[ "$(process_count)" == "0" ]] && break
      sleep 0.02
    done
    if [[ "$(process_count)" != "0" ]]; then
      echo "Candidate JudgeDesk process tree remained after gate cleanup:" >&2
      inventory >&2
    fi
  fi
  if [[ -n "$fixture" && "$fixture" == /tmp/judgedesk-supervisor-gate.* ]]; then
    rm -rf -- "$fixture"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

[[ -d "$app" ]] || fail "packaged app not found: $app"
[[ "$(process_count)" == "0" ]] ||
  fail "refusing to disrupt an existing JudgeDesk process; quit it before running this gate"
if [[ -n "$(all_judgedesk_runtime_inventory)" ]]; then
  fail "refusing to run while another JudgeDesk bundle is active"
fi
[[ "$(directory_entry_count "$executor_root/workspaces")" == "0" ]] ||
  fail "executor workspace cache is not empty before the packaged gate"
[[ "$(directory_entry_count "$executor_root/profiles")" == "0" ]] ||
  fail "Seatbelt profile cache is not empty before the packaged gate"
fixture="$(mktemp -d /tmp/judgedesk-supervisor-gate.XXXXXX)"

open -n "$app"
gate_started_app=1
wait_for_inventory 4
assert_full_generation

initial_gui="$(only_pid GUI "$gui_command")"
initial_helper="$(only_pid helper "$helper_command")"
initial_server="$(only_pid backend "$server_command")"
initial_executor="$(only_pid executor "$executor_command")"

secondary_marker="$fixture/secondary-monitor.running"
secondary_failure="$fixture/secondary-monitor.err"
touch "$secondary_marker"
(
  check_secondary_generation() {
    local expected
    local observed
    expected="$(
      printf 'backend %s\nexecutor %s\nhelper %s\n' \
        "$initial_server" "$initial_executor" "$initial_helper" |
        sort
    )"
    observed="$(
      ps -axo pid=,command= |
        awk \
          -v helper="$helper_command" \
          -v backend="$server_command" \
          -v executor="$executor_command" '
            {
              pid = $1
              $1 = ""
              sub(/^[[:space:]]+/, "")
              if ($0 == helper) print "helper " pid
              if ($0 == backend) print "backend " pid
              if ($0 == executor) print "executor " pid
            }
          ' |
        sort
    )"
    if [[ "$observed" != "$expected" ]]; then
      echo "secondary launch changed backend generation:" >&2
      echo "expected: $expected" >&2
      echo "observed: ${observed:-none}" >&2
      return 1
    fi
  }

  while [[ -e "$secondary_marker" ]]; do
    if ! check_secondary_generation; then
      inventory >&2
      exit 1
    fi
    sleep 0.002
  done
  # Continue sampling after all `open` processes return. A broken secondary
  # could have launched a delayed child just before xargs completed.
  for ((index = 0; index < 100; index++)); do
    if ! check_secondary_generation; then
      inventory >&2
      exit 1
    fi
    sleep 0.002
  done
) 2>"$secondary_failure" &
secondary_monitor_pid=$!
sleep 0.02
seq 1 20 | xargs -P 20 -I{} open -n "$app"
rm -f -- "$secondary_marker"
if ! wait "$secondary_monitor_pid"; then
  cat "$secondary_failure" >&2 || true
  secondary_monitor_pid=""
  fail "a secondary launch transiently changed the backend process generation"
fi
secondary_monitor_pid=""
assert_full_generation
[[ "$(only_pid GUI "$gui_command")" == "$initial_gui" ]] || fail "secondary launch replaced the GUI"
[[ "$(only_pid helper "$helper_command")" == "$initial_helper" ]] || fail "secondary launch replaced the helper"
[[ "$(only_pid backend "$server_command")" == "$initial_server" ]] || fail "secondary launch replaced the backend"
[[ "$(only_pid executor "$executor_command")" == "$initial_executor" ]] || fail "secondary launch replaced the executor"

owner_lock="process-tree.owner.lock"
generation_lock="process-tree.generation"
[[ "$(lsof -a -p "$initial_gui" 2>/dev/null | grep -Ec "$owner_lock|$generation_lock" || true)" == "0" ]] ||
  fail "GUI inherited process-tree lock descriptors"
[[ "$(lsof -a -p "$initial_server" 2>/dev/null | grep -Ec "$owner_lock|$generation_lock" || true)" == "0" ]] ||
  fail "backend inherited process-tree lock descriptors"
[[ "$(lsof -a -p "$initial_helper" 2>/dev/null | grep -c "$owner_lock" || true)" == "1" ]] ||
  fail "helper does not hold exactly one owner lock"
[[ "$(lsof -a -p "$initial_helper" 2>/dev/null | grep -c "$generation_lock" || true)" == "1" ]] ||
  fail "helper does not hold exactly one generation descriptor"
[[ "$(lsof -a -p "$initial_executor" 2>/dev/null | grep -c "$owner_lock" || true)" == "0" ]] ||
  fail "executor inherited the owner lock"
[[ "$(lsof -a -p "$initial_executor" 2>/dev/null | grep -c "$generation_lock" || true)" == "1" ]] ||
  fail "executor does not hold exactly one generation guard"

quit_app

open -n "$app"
wait_for_inventory 4
assert_full_generation
active_gui="$(only_pid GUI "$gui_command")"
active_helper="$(only_pid helper "$helper_command")"
active_executor="$(only_pid executor "$executor_command")"
active_server="$(only_pid backend "$server_command")"
port="$(wait_for_listening_port "$active_server")" ||
  fail "packaged backend did not open a listening port"
[[ "$port" =~ ^[0-9]+$ ]] || fail "could not discover the packaged backend port"
wait_for_cpp_submission_ready "$port" ||
  fail "packaged C++ toolchain did not become submission-ready"

mkdir -p "$fixture/contestants/alice" "$fixture/tests/A/01"
printf '%s\n' \
  '#include <chrono>' \
  '#include <thread>' \
  'int main() {' \
  '  std::this_thread::sleep_for(std::chrono::seconds(60));' \
  '  return 0;' \
  '}' >"$fixture/contestants/alice/A.cpp"
printf '1\n' >"$fixture/tests/A/01/input.inp"
printf '1\n' >"$fixture/tests/A/01/answer.out"
request_body="$(
  printf \
    '{"thisinhPath":"%s/contestants","testPath":"%s/tests","targetContestants":["alice"],"targetProblems":["A"],"jobId":"macos_process_supervisor_gate"}' \
    "$fixture" \
    "$fixture"
)"
curl -sS -N \
  --max-time 20 \
  -H 'Content-Type: application/json' \
  --data-binary "$request_body" \
  "http://127.0.0.1:$port/api/batch-judge" \
  >"$fixture/events.txt" \
  2>"$fixture/curl.err" &
curl_pid=$!

for ((index = 0; index < 1000; index++)); do
  if grep -q 'Judging test' "$fixture/events.txt" 2>/dev/null; then
    if [[ "$(exact_count "$run_guardian_command")" == "1" &&
      "$(exact_count "$run_supervisor_command")" == "1" ]]; then
      candidate_guardian="$(exact_pids "$run_guardian_command")"
      candidate_anchor="$(exact_pids "$run_supervisor_command")"
      candidate_pgid="$(ps -o pgid= -p "$candidate_anchor" 2>/dev/null | tr -d ' ' || true)"
      group_members="$(
        ps -axo pgid= |
          awk -v pgid="$candidate_pgid" '$1 == pgid { count++ } END { print count + 0 }'
      )"
      if [[ "$(parent_pid "$candidate_guardian")" == "$active_executor" &&
        "$(parent_pid "$candidate_anchor")" == "$candidate_guardian" &&
        "$candidate_pgid" == "$candidate_anchor" &&
        "$group_members" -ge 2 ]]; then
        active_guardian="$candidate_guardian"
        active_anchor="$candidate_anchor"
        active_pgid="$candidate_pgid"
        break
      fi
    fi
  fi
  sleep 0.01
done
[[ "$active_guardian" =~ ^[0-9]+$ && "$active_anchor" =~ ^[0-9]+$ ]] || {
  tail -n 30 "$fixture/events.txt" >&2 || true
  inventory >&2
  fail "no verified executor -> guardian -> run-supervisor submission group was observed"
}
[[ "$active_pgid" =~ ^[0-9]+$ ]] || fail "active submission process group was not readable"
[[ "$active_pgid" == "$active_anchor" ]] || fail "run supervisor is not its process-group anchor"
[[ "$active_pgid" != "$(ps -o pgid= -p "$active_gui" | tr -d ' ')" ]] ||
  fail "submission did not receive its own process group"

pid_matches "$active_gui" "$gui_command" ||
  fail "primary GUI identity changed before crash injection"
kill -9 "$active_gui"
open -n "$app" >/dev/null 2>&1 &

max_gui=0
max_helper=0
max_server=0
max_executor=0
stable=0
previous_tuple=""
replacement_gui=""
replacement_helper=""
replacement_server=""
replacement_executor=""
for ((index = 0; index < 1000; index++)); do
  gui_count="$(exact_count "$gui_command")"
  helper_count="$(exact_count "$helper_command")"
  server_count="$(exact_count "$server_command")"
  executor_count="$(exact_count "$executor_command")"
  ((gui_count > max_gui)) && max_gui="$gui_count"
  ((helper_count > max_helper)) && max_helper="$helper_count"
  ((server_count > max_server)) && max_server="$server_count"
  ((executor_count > max_executor)) && max_executor="$executor_count"
  if [[ "$gui_count" == "1" &&
    "$helper_count" == "1" &&
    "$server_count" == "1" &&
    "$executor_count" == "1" ]]; then
    replacement_gui="$(exact_pids "$gui_command")"
    replacement_helper="$(exact_pids "$helper_command")"
    replacement_server="$(exact_pids "$server_command")"
    replacement_executor="$(exact_pids "$executor_command")"
    if [[ "$replacement_gui" != "$active_gui" &&
      "$replacement_helper" != "$active_helper" &&
      "$replacement_server" != "$active_server" &&
      "$replacement_executor" != "$active_executor" &&
      "$(parent_pid "$replacement_helper")" == "$replacement_gui" &&
      "$(parent_pid "$replacement_server")" == "$replacement_gui" &&
      "$(parent_pid "$replacement_executor")" == "$replacement_server" ]]; then
      current_tuple="$replacement_gui/$replacement_helper/$replacement_server/$replacement_executor"
      if [[ "$current_tuple" == "$previous_tuple" ]]; then
        stable=$((stable + 1))
      else
        previous_tuple="$current_tuple"
        stable=1
      fi
      [[ "$stable" -ge 5 ]] && break
    else
      stable=0
      previous_tuple=""
    fi
  else
    stable=0
    previous_tuple=""
  fi
  sleep 0.01
done
[[ "$stable" -ge 5 ]] || {
  inventory >&2
  fail "replacement generation did not become internally consistent"
}
for ((index = 0; index < 500; index++)); do
  curl_state="$(ps -o state= -p "$curl_pid" 2>/dev/null | tr -d ' ' || true)"
  [[ -z "$curl_state" || "$curl_state" == Z* ]] && break
  sleep 0.01
done
curl_state="$(ps -o state= -p "$curl_pid" 2>/dev/null | tr -d ' ' || true)"
if [[ -n "$curl_state" && "$curl_state" != Z* ]]; then
  kill "$curl_pid" >/dev/null 2>&1 || true
  wait "$curl_pid" >/dev/null 2>&1 || true
  curl_pid=""
  fail "old backend kept the judge stream open after GUI crash"
fi
wait "$curl_pid" >/dev/null 2>&1 || true
curl_pid=""
assert_full_generation
[[ "$max_gui" -le 1 && "$max_helper" -le 1 && "$max_server" -le 1 && "$max_executor" -le 1 ]] ||
  fail "old and replacement generations overlapped: gui=$max_gui helper=$max_helper backend=$max_server executor=$max_executor"
if ps -axo pgid= | awk -v pgid="$active_pgid" '$1 == pgid { found = 1 } END { exit found ? 0 : 1 }'; then
  fail "submission process group $active_pgid survived GUI crash recovery"
fi
replacement_port="$(wait_for_listening_port "$replacement_server")" ||
  fail "replacement backend did not open a listening port"
[[ "$replacement_port" =~ ^[0-9]+$ ]] || fail "replacement backend has no listening port"
replacement_status="$(curl -fsS --max-time 5 "http://127.0.0.1:$replacement_port/api/status")" ||
  fail "replacement backend health request failed"
node -e '
  const status = JSON.parse(process.argv[1]);
  if (!status.secureRunner?.ready) process.exit(1);
' "$replacement_status" || fail "replacement backend secure runner is not ready"

recovery_gui="$(only_pid GUI "$gui_command")"
recovery_helper="$(only_pid helper "$helper_command")"
pid_matches "$recovery_helper" "$helper_command" ||
  fail "supervisor identity changed before crash injection"
kill -9 "$recovery_helper"
for ((index = 0; index < 1000; index++)); do
  if [[ "$(exact_count "$server_command")" == "0" && "$(exact_count "$executor_command")" == "0" ]]; then
    break
  fi
  sleep 0.01
done
[[ "$(exact_count "$gui_command")" == "1" ]] || fail "GUI did not survive helper failure"
[[ "$(exact_count "$helper_command")" == "0" ]] || fail "failed helper was unexpectedly restarted"
[[ "$(exact_count "$server_command")" == "0" ]] || fail "backend survived helper failure"
[[ "$(exact_count "$executor_command")" == "0" ]] || fail "executor survived helper failure"
[[ "$(lsof -a -p "$recovery_gui" 2>/dev/null | grep -c "$owner_lock" || true)" == "1" ]] ||
  fail "GUI did not retain the owner recovery lock"
[[ "$(lsof -a -p "$recovery_gui" 2>/dev/null | grep -c "$generation_lock" || true)" == "1" ]] ||
  fail "GUI did not retain the generation recovery lock"

open -n "$app"
sleep 1
[[ "$(exact_count "$gui_command")" == "1" ]] || fail "secondary launch bypassed the surviving primary"
[[ "$(process_count)" == "1" ]] || fail "secondary launch restarted a failed backend generation"

quit_app
open -n "$app"
wait_for_inventory 4
assert_full_generation
final_server="$(only_pid backend "$server_command")"
final_port="$(wait_for_listening_port "$final_server")" ||
  fail "final backend did not open a listening port"
final_status="$(curl -fsS --max-time 5 "http://127.0.0.1:$final_port/api/status")" ||
  fail "final backend health request failed"
node -e '
  const status = JSON.parse(process.argv[1]);
  if (!status.secureRunner?.ready) process.exit(1);
' "$final_status" || fail "final backend secure runner is not ready"
quit_app
[[ -z "$(all_judgedesk_runtime_inventory)" ]] ||
  fail "a JudgeDesk runtime process remained after the final shutdown"
[[ "$(directory_entry_count "$executor_root/workspaces")" == "0" ]] ||
  fail "an executor workspace remained after crash recovery and final shutdown"
[[ "$(directory_entry_count "$executor_root/profiles")" == "0" ]] ||
  fail "a Seatbelt profile remained after crash recovery and final shutdown"

echo "macOS packaged process-supervisor gate passed."
