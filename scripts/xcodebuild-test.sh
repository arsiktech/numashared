#!/bin/zsh

set -euo pipefail

xcodebuild "$@" &
build_pid=$!

watch_stalled_metadata_probe() {
  local service_pid
  local probe_pid
  typeset -A observed_probes
  while kill -0 "$build_pid" 2>/dev/null; do
    sleep 10
    service_pid=$(pgrep -P "$build_pid" -f 'SWBBuildService$' | head -n 1 || true)
    [[ -n "$service_pid" ]] || continue
    while IFS= read -r probe_pid; do
      [[ -n "$probe_pid" ]] || continue
      if [[ -n "${observed_probes[$probe_pid]-}" ]]; then
        print -u2 "Terminating Xcode metadata probe stalled across two samples pid=$probe_pid"
        kill "$probe_pid" 2>/dev/null || true
      else
        observed_probes[$probe_pid]=1
      fi
    done < <(
      ps -axo pid=,ppid=,command= | awk -v parent="$service_pid" '$2 == parent && index($0, "/clang -v -E -dM ") && index($0, " -x c -c /dev/null") { print $1 }'
    )
  done
}

watch_stalled_metadata_probe &
watchdog_pid=$!
set +e
wait "$build_pid"
exit_status=$?
set -e
kill "$watchdog_pid" 2>/dev/null || true
wait "$watchdog_pid" 2>/dev/null || true
exit "$exit_status"
