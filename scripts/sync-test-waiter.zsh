#!/bin/zsh

run_waiter_with_diagnostics() {
  local device=$1
  local role=$2
  shift 2

  local waiter_status=0
  "$@" || waiter_status=$?
  if (( waiter_status == 0 )); then
    return 0
  fi

  capture_simulator_diagnostics "$device" "$role" || true
  return "$waiter_status"
}
