#!/bin/zsh

set -euo pipefail

repo_root=${0:A:h:h:h}
script="$repo_root/scripts/sync-test.sh"
support="$repo_root/scripts/sync-test-support.mjs"
waiter_support="$repo_root/scripts/sync-test-waiter.zsh"
wrapper="$repo_root/scripts/with-convex-local-e2e.sh"
temp_root=$(/usr/bin/mktemp -d /tmp/NumaShared-sync-contract.XXXXXX)
trap '/bin/rm -rf -- "$temp_root"' EXIT

[[ -x "$script" ]]
[[ -f "$waiter_support" ]]
source "$waiter_support"

capture_record="$temp_root/waiter-capture.log"
capture_simulator_diagnostics() {
  print -r -- "$1:$2" >> "$capture_record"
}
contract_waiter_failure() { return 66 }
contract_waiter_success() { return 0 }
if run_waiter_with_diagnostics contract-device A contract_waiter_failure; then
  print -u2 'Waiter wrapper discarded the failing command status'
  exit 1
else
  waiter_status=$?
fi
[[ "$waiter_status" == 66 ]]
[[ "$(< "$capture_record")" == 'contract-device:A' ]]
run_waiter_with_diagnostics contract-device B contract_waiter_success
(( $(wc -l < "$capture_record") == 1 ))

rg -F --quiet 'with-convex-local-e2e.sh' "$script"
rg -F --quiet 'ephemeral_project="$temp_root/numa-e2e-$run_suffix"' "$wrapper"
rg -F --quiet 'CONVEX_AGENT_MODE=anonymous' "$wrapper"
rg -F --quiet '/bin/cp -R "$repo_root/convex"' "$wrapper"
rg -F --quiet 'NumaSharedCore/Tests/NumaSharedCoreTests/Fixtures' "$wrapper"
rg -F --quiet 'ios/NumaShared/NumaSharedTests/Fixtures' "$wrapper"
rg -F --quiet 'cd "$ephemeral_project"' "$wrapper"
rg -F --quiet -- '--local-backend-version "$backend_version"' "$wrapper"
rg -F --quiet 'Fresh anonymous local Convex config' "$repo_root/scripts/local-e2e-start.sh"
if rg -F --quiet '/bin/cp "$repo_root/.convex/local/default/config.json"' "$wrapper"; then
  print -u2 'Local E2E wrapper copies operator Convex credentials into the gate'
  exit 1
fi
rg -F --quiet 'com.apple.CoreSimulator.SimRuntime.iOS-27-0' "$script"
rg -F --quiet 'simctl clone' "$script"
rg -F --quiet 'simctl shutdown "$base_udid"' "$script"
rg -F --quiet 'simctl erase' "$script"
rg -F --quiet 'run_seed_a' "$script"
rg -F --quiet 'run_seed_b' "$script"
rg -F --quiet 'SIMCTL_CHILD_NUMA_SHARED_E2E_CONVEX_URL' "$script"
rg -F --quiet 'create-one connected 0 5 5' "$script"
rg -F --quiet 'Accountless event promotion + setup reconciliation + clean-device adoption PASS' "$script"
rg -F --quiet 'create-after connected 0 6 6' "$script"
rg -F --quiet 'queue-twenty' "$script"
rg -F --quiet 'convergence_millis >= 5000' "$script"
rg -F --quiet 'pairs-equal' "$script"
rg -F --quiet 'queue-twenty offline 20 26 6' "$script"
rg -F --quiet 'account=shared pot=adopted events=26 unique=26 ordered-pairs=1...26 pending=0' "$script"
rg -F --quiet 'p3-owner-bootstrap' "$script"
rg -F --quiet 'p3-claim-leaked' "$script"
rg -F --quiet 'p3-reject-leaked' "$script"
rg -F --quiet 'p3-claim-approved' "$script"
rg -F --quiet 'p3-approve-claim' "$script"
rg -F --quiet 'p3-cross-expense' "$script"
rg -F --quiet 'p3-settlement' "$script"
rg -F --quiet 'p3-revision-a' "$script"
rg -F --quiet 'p3-revision-b' "$script"
rg -F --quiet 'p3-resolve-contest' "$script"
rg -F --quiet 'accounts=distinct pot=shared events=11 unique=11 ordered-pairs=1...11 pending=0 contested=0' "$script"
rg -F --quiet 'resolve-ticket' "$support"
rg -F --quiet 'p3-state' "$support"
rg -F --quiet 'capture_simulator_diagnostics' "$script"
rg -F --quiet 'log show --last 45s' "$script"
rg -F --quiet 'sanitize-log 120 32768' "$script"
rg -F --quiet 'run_waiter_with_diagnostics "$device" "$role"' "$script"
rg -F --quiet 'child_status_file="$temp_root/child.status"' "$wrapper"
rg -F --quiet 'Anonymous-local child failed with status' "$wrapper"
if rg -F --quiet 'simctl status_bar' "$script"; then
  print -u2 'Sync gate fakes transport state with simulator status-bar controls'
  exit 1
fi

device_listing="$temp_root/devices.json"
print -r -- '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-27-0":[{"name":"iPhone 17 Pro Max","udid":"AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE","isAvailable":true,"deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max"}]}}' > "$device_listing"
[[ "$(node "$support" device 'iPhone 17 Pro Max' 'com.apple.CoreSimulator.SimRuntime.iOS-27-0' < "$device_listing")" == 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE' ]]
print -r -- '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-27-0":[{"name":"iPhone 17 Pro Max","udid":"AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE","isAvailable":true,"deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"}]}}' > "$device_listing"
if node "$support" device 'iPhone 17 Pro Max' 'com.apple.CoreSimulator.SimRuntime.iOS-27-0' < "$device_listing" > /dev/null 2>&1; then
  print -u2 'Sync simulator verifier accepted a non-iPhone-17-Pro-Max device'
  exit 1
fi

artifact="$temp_root/artifact.json"
print -r -- '{"ready":true,"runID":"p2-contract","role":"B","command":"observe","accountID":"f30ded96-a289-4c53-9824-0d387aaddb44","activePotID":"01890f5e-7b00-7000-8000-000000000001","connectionState":"connected","pendingCount":0,"totalEventCount":2,"acknowledgedServerSequences":[1,2],"acknowledgedEvents":[{"serverSequence":1,"eventID":"event-a"},{"serverSequence":2,"eventID":"event-b"}],"localOrdinalEventIDs":["event-a","event-b"],"uniqueEventIDs":["event-a","event-b"],"lastSyncOutcome":"completed","lastError":null,"timestamp":"2026-07-13T00:00:00Z"}' > "$artifact"
node "$support" wait \
  "$artifact" p2-contract B observe connected 0 2 2 none completed 1000 \
  > "$temp_root/pass.out"
rg -F --quiet 'artifact PASS' "$temp_root/pass.out"
[[ "$(node "$support" identity "$artifact" p2-contract B observe)" == $'f30ded96-a289-4c53-9824-0d387aaddb44\t01890f5e-7b00-7000-8000-000000000001' ]]
replica="$temp_root/replica.json"
/bin/cp "$artifact" "$replica"
node "$support" pairs-equal "$artifact" "$replica" 2 > "$temp_root/pairs.out"
rg -F --quiet 'ordered acknowledgement pairs PASS' "$temp_root/pairs.out"
reordered_replica="$temp_root/reordered-replica.json"
print -r -- '{"ready":true,"runID":"p2-contract","role":"B","command":"observe","accountID":"f30ded96-a289-4c53-9824-0d387aaddb44","activePotID":"01890f5e-7b00-7000-8000-000000000001","connectionState":"connected","pendingCount":0,"totalEventCount":2,"acknowledgedServerSequences":[1,2],"acknowledgedEvents":[{"eventID":"event-a","serverSequence":1},{"eventID":"event-b","serverSequence":2}],"localOrdinalEventIDs":["event-a","event-b"],"uniqueEventIDs":["event-a","event-b"],"lastSyncOutcome":"completed","lastError":null,"timestamp":"2026-07-13T00:00:00Z"}' > "$reordered_replica"
node "$support" pairs-equal "$artifact" "$reordered_replica" 2 \
  > "$temp_root/reordered-pairs.out"
rg -F --quiet 'ordered acknowledgement pairs PASS' "$temp_root/reordered-pairs.out"

print -r -- '{"ready":true,"runID":"p2-contract","role":"B","command":"observe","accountID":"f30ded96-a289-4c53-9824-0d387aaddb44","activePotID":"01890f5e-7b00-7000-8000-000000000001","connectionState":"connected","pendingCount":0,"totalEventCount":2,"acknowledgedServerSequences":[1,2],"acknowledgedEvents":[{"serverSequence":1,"eventID":"event-a"},{"serverSequence":2,"eventID":"event-a"}],"localOrdinalEventIDs":["event-a","event-b"],"uniqueEventIDs":["event-a","event-a"],"lastSyncOutcome":"completed","lastError":null,"timestamp":"2026-07-13T00:00:00Z"}' > "$artifact"
if node "$support" wait \
  "$artifact" p2-contract B observe connected 0 2 2 none completed 100 \
  > "$temp_root/fail.out" 2>&1; then
  print -u2 'Sync artifact verifier accepted duplicate event IDs'
  exit 1
fi
rg -F --quiet 'event IDs are not exactly-once unique' "$temp_root/fail.out"

print -r -- '{"ready":true,"runID":"p2-contract","role":"B","command":"observe","accountID":"f30ded96-a289-4c53-9824-0d387aaddb44","activePotID":"01890f5e-7b00-7000-8000-000000000001","connectionState":"connected","pendingCount":0,"totalEventCount":2,"acknowledgedServerSequences":[1,2],"acknowledgedEvents":[{"serverSequence":1,"eventID":"event-b"},{"serverSequence":2,"eventID":"event-a"}],"localOrdinalEventIDs":["event-b","event-a"],"uniqueEventIDs":["event-a","event-b"],"lastSyncOutcome":"completed","lastError":null,"timestamp":"2026-07-13T00:00:00Z"}' > "$artifact"
if node "$support" pairs-equal "$artifact" "$replica" 2 \
  > "$temp_root/pair-fail.out" 2>&1; then
  print -u2 'Sync artifact verifier accepted different replica ordering'
  exit 1
fi
rg -F --quiet 'Replica acknowledgement pairs differ' "$temp_root/pair-fail.out"

# Both replicas agreeing on the same server permutation is insufficient when
# it differs from the originating replica's immutable append order.
print -r -- '{"ready":true,"runID":"p2-contract","role":"B","command":"observe","accountID":"f30ded96-a289-4c53-9824-0d387aaddb44","activePotID":"01890f5e-7b00-7000-8000-000000000001","connectionState":"connected","pendingCount":0,"totalEventCount":2,"acknowledgedServerSequences":[1,2],"acknowledgedEvents":[{"serverSequence":1,"eventID":"event-b"},{"serverSequence":2,"eventID":"event-a"}],"localOrdinalEventIDs":["event-a","event-b"],"uniqueEventIDs":["event-a","event-b"],"lastSyncOutcome":"completed","lastError":null,"timestamp":"2026-07-13T00:00:00Z"}' > "$artifact"
if node "$support" wait \
  "$artifact" p2-contract B observe connected 0 2 2 none completed 100 \
  > "$temp_root/order-fail.out" 2>&1; then
  print -u2 'Sync artifact verifier accepted a shared reverse upload order'
  exit 1
fi
rg -F --quiet 'acknowledged event pairs do not preserve local append order' \
  "$temp_root/order-fail.out"

print -r -- '{"ready":true,"runID":"p2-contract","role":"A","command":"create-one","accountID":"f30ded96-a289-4c53-9824-0d387aaddb44","activePotID":"01890f5e-7b00-7000-8000-000000000001","connectionState":"paused","pendingCount":0,"totalEventCount":1,"acknowledgedServerSequences":[],"acknowledgedEvents":[],"localOrdinalEventIDs":["event-a"],"uniqueEventIDs":["event-a"],"lastSyncOutcome":"paused","lastError":"INVALID_SERVER_RESPONSE","timestamp":"2026-07-13T00:00:00Z"}' > "$artifact"
if node "$support" wait \
  "$artifact" p2-contract A create-one connected 0 1 0 none paused 100 \
  > "$temp_root/paused-fail.out" 2>&1; then
  print -u2 'Sync artifact waiter accepted a paused connection as connected'
  exit 1
fi
rg -F --quiet \
  'connection state paused not accepted; lastError=INVALID_SERVER_RESPONSE; lastSyncOutcome=paused' \
  "$temp_root/paused-fail.out"

print -r -- '{"kind":"NUMA_SHARED_E2E_DIAGNOSTIC_V1","ready":false,"terminal":true,"runID":"p2-contract","role":"A","command":"create-one","stage":"authentication","failureCode":"E2E_TRANSPORT_UNAVAILABLE","timestamp":"2026-07-13T00:00:00Z"}' > "$artifact"
started=$(node -e 'process.stdout.write(String(Date.now()))')
if node "$support" wait \
  "$artifact" p2-contract A create-one connected 0 1 1 none completed 5000 \
  > "$temp_root/terminal-fail.out" 2>&1; then
  print -u2 'Sync artifact waiter accepted a terminal E2E failure'
  exit 1
fi
finished=$(node -e 'process.stdout.write(String(Date.now()))')
elapsed_millis=$(( finished - started ))
if (( elapsed_millis >= 1000 )); then
  print -u2 "Terminal E2E failure was not surfaced immediately: ${elapsed_millis}ms"
  exit 1
fi
rg -F --quiet 'role=A command=create-one stage=authentication code=E2E_TRANSPORT_UNAVAILABLE' \
  "$temp_root/terminal-fail.out"

p3_artifact="$temp_root/p3-artifact.json"
print -r -- '{"ready":true,"currentMemberRole":"member","activeMemberCount":2,"expenseRecordCount":2,"settlementRecordCount":1,"contestedRecordCount":1,"maximumRevisionCount":3}' > "$p3_artifact"
node "$support" p3-state "$p3_artifact" member 2 2 1 1 3 \
  > "$temp_root/p3-state-pass.out"
rg -F --quiet 'P3 state PASS' "$temp_root/p3-state-pass.out"
if node "$support" p3-state "$p3_artifact" owner 2 2 1 1 3 \
  > "$temp_root/p3-state-fail.out" 2>&1; then
  print -u2 'P3 state verifier accepted the wrong current-member role'
  exit 1
fi
rg -F --quiet 'P3 state mismatch: currentMemberRole' \
  "$temp_root/p3-state-fail.out"
print -r -- '{"ready":true,"activeMemberCount":0,"expenseRecordCount":0,"settlementRecordCount":0,"contestedRecordCount":0,"maximumRevisionCount":0}' > "$p3_artifact"
node "$support" p3-state "$p3_artifact" none 0 0 0 0 0 \
  > "$temp_root/p3-state-none.out"
rg -F --quiet 'role=none' "$temp_root/p3-state-none.out"

print -r -- '{"kind":"NUMA_SHARED_E2E_DIAGNOSTIC_V1","ready":false,"terminal":false,"runID":"p2-contract","role":"A","command":"create-one","stage":"command-preparation","failureCode":null,"timestamp":"2026-07-13T00:00:00Z"}' > "$artifact"
if node "$support" wait \
  "$artifact" p2-contract B observe connected 0 1 1 none completed 100 \
  > "$temp_root/mismatched-progress.out" 2>&1; then
  print -u2 'Sync artifact waiter trusted a mismatched progress artifact'
  exit 1
fi
rg -F --quiet 'runID, role, or command mismatch' "$temp_root/mismatched-progress.out"

log_fixture="$temp_root/raw.log"
for index in {1..180}; do
  print -r -- "line=$index Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature url=https://private.example/path?token=sentinel socket=wss://socket.private.example/path API_TOKEN=short-sentinel NUMA_SHARED_E2E_BOOTSTRAP_SECRET=sentinel-secret /Users/private/secret.txt" >> "$log_fixture"
done
node "$support" sanitize-log 120 32768 \
  < "$log_fixture" > "$temp_root/sanitized.log"
line_count=$(wc -l < "$temp_root/sanitized.log")
byte_count=$(wc -c < "$temp_root/sanitized.log")
if (( line_count > 121 || byte_count > 32768 )); then
  print -u2 "Sanitized simulator log exceeded its bound: lines=$line_count bytes=$byte_count"
  exit 1
fi
rg -F --quiet '[REDACTED]' "$temp_root/sanitized.log"
if rg -F --quiet 'sentinel' "$temp_root/sanitized.log" \
  || rg -F --quiet 'private.example' "$temp_root/sanitized.log" \
  || rg -F --quiet 'socket.private.example' "$temp_root/sanitized.log" \
  || rg -F --quiet 'short-sentinel' "$temp_root/sanitized.log" \
  || rg -F --quiet '/Users/private' "$temp_root/sanitized.log"; then
  print -u2 'Sanitized simulator log retained secret or private-path material'
  exit 1
fi

print 'sync-test contract PASS: P2 promotion/offline convergence + P3 semantic journey contract'
