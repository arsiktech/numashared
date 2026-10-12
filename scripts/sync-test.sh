#!/bin/zsh

set -euo pipefail
umask 077

script_path=${0:A}
repo_root=${script_path:h:h}
inside_marker=--inside-asserted-anonymous-local

if (( $# == 0 )); then
  child_command="${(q)script_path} ${(q)inside_marker}"
  exec "$repo_root/scripts/with-convex-local-e2e.sh" "$child_command"
fi
if (( $# != 1 )) || [[ "$1" != "$inside_marker" ]]; then
  print -u2 'Usage: ./scripts/sync-test.sh'
  exit 64
fi

support="$repo_root/scripts/sync-test-support.mjs"
waiter_support="$repo_root/scripts/sync-test-waiter.zsh"
project="$repo_root/ios/NumaShared/NumaShared.xcodeproj"
scheme=NumaShared
bundle_id=tech.arsik.numashared
base_name='iPhone 17 Pro Max'
runtime_key=com.apple.CoreSimulator.SimRuntime.iOS-27-0
phase=${NUMA_PHASE:-P2}
if [[ "$phase" != P2 && "$phase" != P3 ]]; then
  print -u2 'NUMA_PHASE must be P2 or P3'
  exit 64
fi

if [[ ! -f "$support" || ! -f "$waiter_support" || ! -d "$project" ]]; then
  print -u2 'Deterministic sync gate prerequisites are missing'
  exit 66
fi
source "$waiter_support"
if [[ -z "${NUMA_SHARED_E2E_BOOTSTRAP_SECRET:-}" ]]; then
  print -u2 'Asserted local E2E auth environment is missing'
  exit 66
fi

cloud_url=$(node "$support" loopback "${NUMA_SHARED_LOCAL_CLOUD_URL:-}")
site_url=$(node "$support" loopback "${NUMA_SHARED_LOCAL_SITE_URL:-}")
offline_url=http://127.0.0.1:1
if /usr/bin/nc -z -G 1 127.0.0.1 1 >/dev/null 2>&1; then
  print -u2 'Reserved offline endpoint unexpectedly accepts connections'
  exit 69
fi

run_suffix=$(uuidgen | tr '[:upper:]' '[:lower:]' | tr -d '-' | cut -c1-12)
run_seed_a=$(uuidgen | tr -d '-' | cut -c1-16)
run_seed_b=$(uuidgen | tr -d '-' | cut -c1-16)
if [[ "$run_seed_a" == "$run_seed_b" ]]; then
  print -u2 'Role-specific E2E identity seeds unexpectedly collided'
  exit 70
fi
run_id="${phase:l}-${run_suffix}"
invite_token_1=
invite_code_1=
invite_token_2=
invite_code_2=
invite_ticket=
target_pot_id=
if [[ "$phase" == P3 ]]; then
  invite_token_1=$(uuidgen | tr '[:upper:]' '[:lower:]' | tr -d '-')
  invite_code_1=$(uuidgen | tr -d '-' | cut -c1-6)
  invite_token_2=$(uuidgen | tr '[:upper:]' '[:lower:]' | tr -d '-')
  invite_code_2=$(uuidgen | tr -d '-' | cut -c1-6)
  if [[ "$invite_token_1" == "$invite_token_2" \
     || "$invite_code_1" == "$invite_code_2" ]]; then
    print -u2 'P3 invite credentials unexpectedly collided'
    exit 70
  fi
fi
temp_root=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/NumaShared-sync-${run_suffix}.XXXXXX")
derived_data="/tmp/NumaShared-Sync-${run_suffix}"
created_devices=()
launched_pid_a=unknown
launched_pid_b=unknown

cleanup() {
  set +e
  for device in "${created_devices[@]}"; do
    xcrun simctl shutdown "$device" >/dev/null 2>&1
    xcrun simctl delete "$device" >/dev/null 2>&1
  done
  /bin/rm -rf -- "$temp_root" "$derived_data"
}
trap cleanup EXIT INT TERM

base_udid=$(xcrun simctl list devices available -j \
  | node "$support" device "$base_name" "$runtime_key")
# Xcode's preceding UI row leaves the named source booted. CoreSimulator cannot
# clone a booted device, so make the source state explicit before clean cloning.
xcrun simctl shutdown "$base_udid" >/dev/null 2>&1 || true
device_a=$(xcrun simctl clone "$base_udid" "Numa Shared ${run_suffix} A")
created_devices+=("$device_a")
device_b=$(xcrun simctl clone "$base_udid" "Numa Shared ${run_suffix} B")
created_devices+=("$device_b")

for device in "$device_a" "$device_b"; do
  # Clones may inherit the source device's app data and Keychain. Erasing each
  # clone makes the run independent of any operator-owned simulator state.
  xcrun simctl erase "$device"
  xcrun simctl boot "$device"
  xcrun simctl bootstatus "$device" -b
done

print "Deterministic sync gate: phase=$phase runtime=iOS-27.0 simulators=2"
xcodebuild build \
  -quiet \
  -project "$project" \
  -scheme "$scheme" \
  -configuration Debug \
  -destination "platform=iOS Simulator,id=$device_a,OS=27.0" \
  -derivedDataPath "$derived_data" \
  -disableAutomaticPackageResolution

app_bundle="$derived_data/Build/Products/Debug-iphonesimulator/NumaShared.app"
if [[ ! -d "$app_bundle" ]]; then
  print -u2 "Debug app bundle missing: $app_bundle"
  exit 66
fi
for device in "$device_a" "$device_b"; do
  xcrun simctl install "$device" "$app_bundle"
done

container_a=$(xcrun simctl get_app_container "$device_a" "$bundle_id" data)
container_b=$(xcrun simctl get_app_container "$device_b" "$bundle_id" data)
artifact_a="$container_a/Library/Application Support/NumaShared/E2E/${run_id}-A.json"
artifact_b="$container_b/Library/Application Support/NumaShared/E2E/${run_id}-B.json"

launch_app() {
  local device=$1
  local role=$2
  local command=$3
  local deployment_url=$4
  local role_seed=$run_seed_a
  if [[ "$role" == B ]]; then
    role_seed=$run_seed_b
  fi
  local launch_output
  launch_output=$(SIMCTL_CHILD_NUMA_SHARED_E2E_RUN_ID="$run_id" \
  SIMCTL_CHILD_NUMA_SHARED_E2E_ROLE="$role" \
  SIMCTL_CHILD_NUMA_SHARED_E2E_RUN_SEED="$role_seed" \
  SIMCTL_CHILD_NUMA_SHARED_E2E_BOOTSTRAP_SECRET="$NUMA_SHARED_E2E_BOOTSTRAP_SECRET" \
  SIMCTL_CHILD_NUMA_SHARED_E2E_COMMAND="$command" \
  SIMCTL_CHILD_NUMA_SHARED_E2E_CONVEX_URL="$deployment_url" \
  SIMCTL_CHILD_NUMA_SHARED_E2E_SITE_URL="$site_url" \
  SIMCTL_CHILD_NUMA_SHARED_E2E_INVITE_TOKEN_1="$invite_token_1" \
  SIMCTL_CHILD_NUMA_SHARED_E2E_INVITE_CODE_1="$invite_code_1" \
  SIMCTL_CHILD_NUMA_SHARED_E2E_INVITE_TOKEN_2="$invite_token_2" \
  SIMCTL_CHILD_NUMA_SHARED_E2E_INVITE_CODE_2="$invite_code_2" \
  SIMCTL_CHILD_NUMA_SHARED_E2E_INVITE_TICKET="$invite_ticket" \
  SIMCTL_CHILD_NUMA_SHARED_E2E_TARGET_POT_ID="$target_pot_id" \
    xcrun simctl launch --terminate-running-process \
      "$device" "$bundle_id" --numa-shared-e2e)
  local launched_pid=${launch_output##*: }
  if [[ ! "$launched_pid" =~ '^[0-9]+$' ]]; then
    print -u2 "Simulator launch did not return a numeric PID for role $role"
    return 70
  fi
  if [[ "$role" == A ]]; then
    launched_pid_a=$launched_pid
  else
    launched_pid_b=$launched_pid
  fi
  print "E2E launch: role=$role pid=$launched_pid"
}

capture_simulator_diagnostics() {
  local device=$1
  local role=$2
  local pid=$launched_pid_a
  if [[ "$role" == B ]]; then
    pid=$launched_pid_b
  fi
  local raw_log="$temp_root/simulator-${role}.log"
  print -u2 "[DEBUG-E2E] waiter failed role=$role lastLaunchPID=$pid; bounded sanitized simulator log follows"
  if ! xcrun simctl spawn "$device" log show --last 45s \
    --style compact \
    --predicate 'process == "NumaShared" OR eventMessage CONTAINS "NumaShared"' \
    > "$raw_log" 2>&1; then
    print -u2 '[DEBUG-E2E] simulator log collection command failed'
  fi
  node "$support" sanitize-log 120 32768 < "$raw_log" >&2
}

wait_artifact() {
  local role=$3
  local device=$device_a
  if [[ "$role" == B ]]; then
    device=$device_b
  fi
  run_waiter_with_diagnostics "$device" "$role" node "$support" wait "$@"
}

if [[ "$phase" == P3 ]]; then
  launch_app "$device_a" A p3-owner-bootstrap "$cloud_url"
  wait_artifact "$artifact_a" "$run_id" A p3-owner-bootstrap connected 0 5 5 none completed 30000
  node "$support" p3-state "$artifact_a" owner 1 1 0 0 1
  identity_a=$(node "$support" identity "$artifact_a" "$run_id" A p3-owner-bootstrap)
  account_id_a=${identity_a%%$'\t'*}
  target_pot_id=${identity_a#*$'\t'}

  invite_ticket=$(node "$support" resolve-ticket "$site_url" "$invite_code_1")
  launch_app "$device_b" B p3-claim-leaked "$cloud_url"
  wait_artifact "$artifact_b" "$run_id" B p3-claim-leaked local 0 0 0 none any 30000
  node "$support" p3-state "$artifact_b" none 0 0 0 0 0
  pending_identity_b=$(node "$support" identity "$artifact_b" "$run_id" B p3-claim-leaked)
  account_id_b=${pending_identity_b%%$'\t'*}
  pending_pot_id_b=${pending_identity_b#*$'\t'}
  if [[ "$account_id_a" == "$account_id_b" || "$target_pot_id" == "$pending_pot_id_b" ]]; then
    print -u2 'Pending pot-link claim did not preserve distinct account and inaccessible local pot'
    exit 70
  fi

  launch_app "$device_a" A p3-reject-leaked "$cloud_url"
  wait_artifact "$artifact_a" "$run_id" A p3-reject-leaked connected 0 5 5 none completed 30000
  node "$support" p3-state "$artifact_a" owner 1 1 0 0 1

  invite_ticket=$(node "$support" resolve-ticket "$site_url" "$invite_code_2")
  launch_app "$device_b" B p3-claim-approved "$cloud_url"
  wait_artifact "$artifact_b" "$run_id" B p3-claim-approved local 0 0 0 none any 30000
  node "$support" p3-state "$artifact_b" none 0 0 0 0 0

  launch_app "$device_a" A p3-approve-claim "$cloud_url"
  wait_artifact "$artifact_a" "$run_id" A p3-approve-claim connected 0 6 6 none completed 30000
  node "$support" p3-state "$artifact_a" owner 2 1 0 0 1

  invite_ticket=
  launch_app "$device_b" B observe "$cloud_url"
  wait_artifact "$artifact_b" "$run_id" B observe connected 0 6 6 none completed 30000
  node "$support" p3-state "$artifact_b" member 2 1 0 0 1
  joined_identity_b=$(node "$support" identity "$artifact_b" "$run_id" B observe)
  joined_account_id_b=${joined_identity_b%%$'\t'*}
  joined_pot_id_b=${joined_identity_b#*$'\t'}
  if [[ "$joined_account_id_b" != "$account_id_b" \
     || "$joined_pot_id_b" != "$target_pot_id" ]]; then
    print -u2 'Approved second account did not adopt the shared pot'
    exit 70
  fi
  node "$support" pairs-equal "$artifact_a" "$artifact_b" 6

  launch_app "$device_b" B p3-cross-expense "$cloud_url"
  wait_artifact "$artifact_b" "$run_id" B p3-cross-expense connected 0 7 7 none completed 30000
  node "$support" p3-state "$artifact_b" member 2 2 0 0 1
  wait_artifact "$artifact_a" "$run_id" A p3-approve-claim connected 0 7 7 none completed 6000
  node "$support" p3-state "$artifact_a" owner 2 2 0 0 1
  node "$support" pairs-equal "$artifact_a" "$artifact_b" 7

  launch_app "$device_a" A p3-settlement "$cloud_url"
  wait_artifact "$artifact_a" "$run_id" A p3-settlement connected 0 8 8 none completed 30000
  node "$support" p3-state "$artifact_a" owner 2 2 1 0 1
  wait_artifact "$artifact_b" "$run_id" B p3-cross-expense connected 0 8 8 none completed 6000
  node "$support" p3-state "$artifact_b" member 2 2 1 0 1
  node "$support" pairs-equal "$artifact_a" "$artifact_b" 8

  launch_app "$device_a" A p3-revision-a "$cloud_url"
  wait_artifact "$artifact_a" "$run_id" A p3-revision-a connected 0 9 9 none completed 30000
  node "$support" p3-state "$artifact_a" owner 2 2 1 0 2

  launch_app "$device_b" B p3-revision-b "$cloud_url"
  wait_artifact "$artifact_b" "$run_id" B p3-revision-b connected 0 10 10 none completed 30000
  node "$support" p3-state "$artifact_b" member 2 2 1 1 3
  wait_artifact "$artifact_a" "$run_id" A p3-revision-a connected 0 10 10 none completed 6000
  node "$support" p3-state "$artifact_a" owner 2 2 1 1 3
  node "$support" pairs-equal "$artifact_a" "$artifact_b" 10

  launch_app "$device_a" A p3-resolve-contest "$cloud_url"
  wait_artifact "$artifact_a" "$run_id" A p3-resolve-contest connected 0 11 11 none completed 30000
  node "$support" p3-state "$artifact_a" owner 2 2 1 0 4
  wait_artifact "$artifact_b" "$run_id" B p3-revision-b connected 0 11 11 none completed 6000
  node "$support" p3-state "$artifact_b" member 2 2 1 0 4
  node "$support" pairs-equal "$artifact_a" "$artifact_b" 11

  print 'DETERMINISTIC LOCAL SYNC PASS: phase=P3 replicas=2 accounts=distinct pot=shared events=11 unique=11 ordered-pairs=1...11 pending=0 contested=0'
  exit 0
fi

# A persists its local setup and creates a real expense before first auth.
# Promotion must keep the expense at sequence 1, then reconcile the four
# append-only setup events as sequences 2...5.
launch_app "$device_a" A create-one "$cloud_url"
wait_artifact "$artifact_a" "$run_id" A create-one connected 0 5 5 none completed 30000
identity_a=$(node "$support" identity "$artifact_a" "$run_id" A create-one)
account_id=${identity_a%%$'\t'*}
active_pot_id=${identity_a#*$'\t'}

# B has a different empty local pot and must adopt A's complete history.
launch_app "$device_b" B observe "$cloud_url"
wait_artifact "$artifact_b" "$run_id" B observe connected 0 5 5 none completed 30000
identity_b=$(node "$support" identity "$artifact_b" "$run_id" B observe)
if [[ "$identity_b" != "$identity_a" ]]; then
  print -u2 'Clean replica did not adopt the same authenticated account and active pot'
  exit 70
fi
node "$support" pairs-equal "$artifact_a" "$artifact_b" 5
print "Accountless event promotion + setup reconciliation + clean-device adoption PASS: account=$account_id activePot=$active_pot_id ordered=1...5"

convergence_started=$(node -e 'process.stdout.write(String(Date.now()))')
launch_app "$device_a" A create-after "$cloud_url"
wait_artifact "$artifact_a" "$run_id" A create-after connected 0 6 6 none completed 30000
if [[ "$(node "$support" identity "$artifact_a" "$run_id" A create-after)" != "$identity_a" ]]; then
  print -u2 'A relaunch did not preserve the run account and active pot'
  exit 70
fi
wait_artifact "$artifact_b" "$run_id" B observe connected 0 6 6 none completed 6000
if [[ "$(node "$support" identity "$artifact_b" "$run_id" B observe)" != "$identity_a" ]]; then
  print -u2 'B convergence artifact changed account or active pot'
  exit 70
fi
node "$support" pairs-equal "$artifact_a" "$artifact_b" 6
convergence_finished=$(node -e 'process.stdout.write(String(Date.now()))')
convergence_millis=$(( convergence_finished - convergence_started ))
if (( convergence_millis >= 5000 )); then
  print -u2 "A-to-B convergence exceeded 5000 ms: ${convergence_millis} ms"
  exit 70
fi
print "A-to-B convergence PASS: ${convergence_millis} ms (<5000 ms)"

# A keeps the authenticated session but loses the real Convex transport.
launch_app "$device_a" A queue-twenty "$offline_url"
wait_artifact "$artifact_a" "$run_id" A queue-twenty offline 20 26 6 required any 30000
if [[ "$(node "$support" identity "$artifact_a" "$run_id" A queue-twenty)" != "$identity_a" ]]; then
  print -u2 'Offline relaunch changed account or active pot'
  exit 70
fi
print 'Offline queue PASS: real transport unavailable, pending=20'

# Restoring the asserted local transport drains once and both replicas converge.
launch_app "$device_a" A observe "$cloud_url"
wait_artifact "$artifact_a" "$run_id" A observe connected 0 26 26 none completed 45000
wait_artifact "$artifact_b" "$run_id" B observe connected 0 26 26 none completed 45000
if [[ "$(node "$support" identity "$artifact_a" "$run_id" A observe)" != "$identity_a" \
   || "$(node "$support" identity "$artifact_b" "$run_id" B observe)" != "$identity_a" ]]; then
  print -u2 'Final replicas changed account or active pot'
  exit 70
fi
node "$support" pairs-equal "$artifact_a" "$artifact_b" 26

print "DETERMINISTIC LOCAL SYNC PASS: phase=$phase replicas=2 account=shared pot=adopted events=26 unique=26 ordered-pairs=1...26 pending=0"
