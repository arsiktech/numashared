#!/bin/zsh

set -euo pipefail

usage() {
  print -u2 'Usage: ./scripts/phase-gate.sh P2|P3|P4|P5'
}

if (( $# != 1 )); then
  usage
  exit 64
fi

phase=$1
case "$phase" in
  P2|P3|P4|P5) ;;
  *)
    usage
    exit 64
    ;;
esac
sync_phase=P2
if [[ "$phase" != P2 ]]; then
  sync_phase=P3
fi

repo_root=${0:A:h:h}
project="$repo_root/ios/NumaShared/NumaShared.xcodeproj"
destination='platform=iOS Simulator,name=iPhone 17 Pro Max,OS=27.0'
minimum_destination='platform=iOS Simulator,name=iPhone 17 Pro,OS=26.2'
derived_data="/tmp/NumaShared-${phase}-Gate"

require_directory() {
  if [[ ! -d "$1" ]]; then
    print -u2 "Required gate directory missing: $1"
    exit 66
  fi
}

require_executable() {
  if [[ ! -x "$1" ]]; then
    print -u2 "Required gate executable missing: $1"
    exit 66
  fi
}

run_gate() {
  local name=$1
  shift
  print
  print "== $name =="
  "$@"
}

require_directory "$repo_root/NumaSharedCore"
require_directory "$repo_root/NumaSharedSync"
require_directory "$project"
require_executable "$repo_root/scripts/p1-release-check.sh"
require_executable "$repo_root/scripts/upload-release.sh"
require_executable "$repo_root/scripts/sync-test.sh"
require_executable "$repo_root/scripts/xcodebuild-test.sh"
require_executable "$repo_root/scripts/convex-toolchain-check.sh"
require_executable "$repo_root/scripts/tests/phase-gate-test.sh"
require_executable "$repo_root/scripts/tests/convex-toolchain-contract-test.sh"
require_executable "$repo_root/scripts/tests/sync-test-contract-test.sh"
require_executable "$repo_root/scripts/tests/convex-local-guard-test.sh"
require_executable "$repo_root/scripts/tests/convex-e2e-wrapper-contract-test.sh"
require_executable "$repo_root/scripts/tests/event-terminal-contract-test.sh"
require_executable "$repo_root/scripts/tests/auth-error-contract-test.sh"
require_executable "$repo_root/scripts/tests/xcodebuild-wrapper-contract-test.sh"
require_executable "$repo_root/scripts/tests/release-build-floor-contract-test.sh"
require_executable "$repo_root/scripts/tests/release-signing-contract-test.sh"
require_executable "$repo_root/scripts/tests/release-inspection-contract-test.sh"
require_executable "$repo_root/scripts/tests/release-web-preflight-contract-test.mjs"
require_executable "$repo_root/scripts/tests/asc-build-floor-contract-test.mjs"

worktree_status=$(git -C "$repo_root" status --porcelain=v1 --untracked-files=all)
if [[ -n "$worktree_status" ]]; then
  print -u2 'Phase gate requires a clean frozen worktree; commit or remove every tracked and untracked candidate change first.'
  exit 65
fi

main_hash=$(git -C "$repo_root" rev-parse main)
head_hash=$(git -C "$repo_root" rev-parse HEAD)
tree_hash=$(git -C "$repo_root" rev-parse 'HEAD^{tree}')
if ! git -C "$repo_root" merge-base --is-ancestor main HEAD; then
  print -u2 "Phase head is not based on current main: main=$main_hash head=$head_hash"
  exit 65
fi
if git -C "$repo_root" diff --quiet --exit-code main...HEAD; then
  print -u2 "Phase candidate is empty: main=$main_hash head=$head_hash"
  exit 65
else
  diff_status=$?
  if (( diff_status != 1 )); then
    print -u2 "Unable to verify phase candidate diff: git exit $diff_status"
    exit "$diff_status"
  fi
fi
if ! git -C "$repo_root" diff --check main...HEAD; then
  print -u2 'Phase candidate contains whitespace errors in the frozen main...HEAD range.'
  exit 65
fi

print "Numa Shared $phase gate"
print "base(main)=$main_hash"
print "head=$head_hash"
print "tree=$tree_hash"
print "destination=$destination"
if [[ "$phase" == P5 ]]; then
  print "minimum-runtime-destination=$minimum_destination (deployment floor iOS 26.0)"
fi

cd "$repo_root"

run_gate 'Convex toolchain pin' "$repo_root/scripts/convex-toolchain-check.sh"
run_gate 'Phase-gate contract' "$repo_root/scripts/tests/phase-gate-test.sh"
run_gate 'Convex toolchain contract' \
  "$repo_root/scripts/tests/convex-toolchain-contract-test.sh"
run_gate 'Deterministic-sync contract' "$repo_root/scripts/tests/sync-test-contract-test.sh"
run_gate 'Anonymous-local guard contract' \
  "$repo_root/scripts/tests/convex-local-guard-test.sh"
run_gate 'Anonymous-local E2E wrapper contract' \
  "$repo_root/scripts/tests/convex-e2e-wrapper-contract-test.sh"
run_gate 'Event-terminal taxonomy contract' \
  "$repo_root/scripts/tests/event-terminal-contract-test.sh"
run_gate 'Authentication recovery contract' \
  "$repo_root/scripts/tests/auth-error-contract-test.sh"
run_gate 'Xcodebuild wrapper contract' \
  "$repo_root/scripts/tests/xcodebuild-wrapper-contract-test.sh"
run_gate 'Release build-floor contract' \
  "$repo_root/scripts/tests/release-build-floor-contract-test.sh"
run_gate 'Release signing contract' \
  "$repo_root/scripts/tests/release-signing-contract-test.sh"
run_gate 'Release inspection contract' \
  "$repo_root/scripts/tests/release-inspection-contract-test.sh"
run_gate 'Release web preflight contract' \
  "$repo_root/scripts/tests/release-web-preflight-contract-test.mjs"
run_gate 'ASC build-floor inventory contract' \
  "$repo_root/scripts/tests/asc-build-floor-contract-test.mjs"
run_gate 'Core' swift test --package-path NumaSharedCore
run_gate 'Sync' swift test --package-path NumaSharedSync
run_gate 'Backend typecheck' npm run backend:typecheck --silent
run_gate 'Backend unit + ACL + redaction' npm run backend:test --silent
run_gate 'Anonymous-local backend integration' \
  "$repo_root/scripts/tests/convex-local-integration-test.sh"
run_gate 'Full iOS 27 Xcode + UI' \
  "$repo_root/scripts/xcodebuild-test.sh" test \
    -project "$project" \
    -scheme NumaShared \
    -destination "$destination" \
    -derivedDataPath "$derived_data"
if [[ "$phase" == P5 ]]; then
  # A real iOS 26 run is additional proof, never a substitute for the full iOS 27 lane.
  # Pin the installed release-test runtime explicitly: a missing runtime must fail.
  run_gate 'iOS 26 minimum-family local journey + native glass' \
    "$repo_root/scripts/xcodebuild-test.sh" test \
      -project "$project" \
      -scheme NumaShared \
      -destination "$minimum_destination" \
      -derivedDataPath "$derived_data" \
      -parallel-testing-enabled NO \
      -only-testing:NumaSharedUITests/GoldenPathUITests/testLocalExpenseBalanceAndRepayment
fi
run_gate 'Release boundary' "$repo_root/scripts/p1-release-check.sh"
run_gate 'Deterministic local sync' \
  env NUMA_PHASE="$sync_phase" "$repo_root/scripts/sync-test.sh"

final_worktree_status=$(git -C "$repo_root" status --porcelain=v1 --untracked-files=all)
final_main_hash=$(git -C "$repo_root" rev-parse main)
final_head_hash=$(git -C "$repo_root" rev-parse HEAD)
final_tree_hash=$(git -C "$repo_root" rev-parse 'HEAD^{tree}')
if [[ -n "$final_worktree_status" \
      || "$final_main_hash" != "$main_hash" \
      || "$final_head_hash" != "$head_hash" \
      || "$final_tree_hash" != "$tree_hash" ]]; then
  print -u2 'Phase candidate changed while the matrix was running; discard this receipt and rerun from a clean frozen worktree.'
  print -u2 "start: base=$main_hash head=$head_hash tree=$tree_hash"
  print -u2 "final: base=$final_main_hash head=$final_head_hash tree=$final_tree_hash"
  exit 65
fi

print
print "LOCAL PHASE MATRIX PASS: $phase base=$main_hash head=$head_hash tree=$tree_hash"
