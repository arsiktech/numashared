#!/bin/zsh

set -euo pipefail

source_root=${0:A:h:h:h}
temp_root=$(mktemp -d /tmp/NumaShared-phase-gate-test.XXXXXX)
temp_root=${temp_root:A}
trap 'rm -rf -- "$temp_root"' EXIT

repo="$temp_root/repo"
fake_bin="$temp_root/bin"
log="$temp_root/commands.log"
mkdir -p \
  "$repo/scripts/tests" \
  "$repo/NumaSharedCore" \
  "$repo/NumaSharedSync" \
  "$repo/ios/NumaShared/NumaShared.xcodeproj" \
  "$fake_bin"
cp "$source_root/scripts/phase-gate.sh" "$repo/scripts/phase-gate.sh"
cp "$source_root/scripts/xcodebuild-test.sh" "$repo/scripts/xcodebuild-test.sh"
cp "$source_root/scripts/upload-release.sh" "$repo/scripts/upload-release.sh"
chmod +x "$repo/scripts/phase-gate.sh"
chmod +x "$repo/scripts/xcodebuild-test.sh"
chmod +x "$repo/scripts/upload-release.sh"

cat > "$repo/scripts/convex-toolchain-check.sh" <<'EOF'
#!/bin/zsh
print -r -- 'convex-toolchain-pin' >> "$NUMA_PHASE_GATE_LOG"
EOF
chmod +x "$repo/scripts/convex-toolchain-check.sh"

for contract in phase-gate-test convex-toolchain-contract-test sync-test-contract-test convex-local-guard-test convex-e2e-wrapper-contract-test event-terminal-contract-test auth-error-contract-test xcodebuild-wrapper-contract-test release-build-floor-contract-test release-signing-contract-test release-inspection-contract-test; do
  cat > "$repo/scripts/tests/$contract.sh" <<EOF
#!/bin/zsh
print -r -- '$contract' >> "\$NUMA_PHASE_GATE_LOG"
EOF
  chmod +x "$repo/scripts/tests/$contract.sh"
done

cat > "$repo/scripts/tests/release-web-preflight-contract-test.mjs" <<'EOF'
#!/bin/zsh
print -r -- 'release-web-preflight-contract-test' >> "$NUMA_PHASE_GATE_LOG"
EOF
chmod +x "$repo/scripts/tests/release-web-preflight-contract-test.mjs"

cat > "$repo/scripts/tests/asc-build-floor-contract-test.mjs" <<'EOF'
#!/bin/zsh
print -r -- 'asc-build-floor-contract-test' >> "$NUMA_PHASE_GATE_LOG"
EOF
chmod +x "$repo/scripts/tests/asc-build-floor-contract-test.mjs"

for command_name in swift npm xcodebuild; do
  command_path="$fake_bin/$command_name"
  print '#!/bin/zsh' > "$command_path"
  print 'print -r -- "'"$command_name"' $*" >> "$NUMA_PHASE_GATE_LOG"' >> "$command_path"
  chmod +x "$command_path"
done

cat >> "$fake_bin/xcodebuild" <<'EOF'
if [[ "$*" == *'OS=26.2'* && "${NUMA_FAKE_MISSING_MINIMUM_RUNTIME:-0}" == '1' ]]; then
  print -u2 'Unable to find a destination matching iOS 26.2'
  exit 70
fi
EOF

cat > "$fake_bin/git" <<'EOF'
#!/bin/zsh
print -r -- "git $*" >> "$NUMA_PHASE_GATE_LOG"
case "$*" in
  *'status --porcelain=v1 --untracked-files=all')
    [[ "${NUMA_FAKE_DIRTY:-0}" == '1' ]] && print ' M candidate.swift'
    exit 0
    ;;
  *'rev-parse main') print '1111111111111111111111111111111111111111' ;;
  *'rev-parse HEAD')
    if [[ "${NUMA_FAKE_HEAD_CHANGE:-0}" == '1' ]]; then
      head_reads=0
      [[ -f "$NUMA_PHASE_GATE_STATE" ]] && head_reads=$(<"$NUMA_PHASE_GATE_STATE")
      (( head_reads += 1 ))
      print -r -- "$head_reads" > "$NUMA_PHASE_GATE_STATE"
      if (( head_reads > 1 )); then
        print '4444444444444444444444444444444444444444'
      else
        print '2222222222222222222222222222222222222222'
      fi
    else
      print '2222222222222222222222222222222222222222'
    fi
    ;;
  *'rev-parse HEAD^{tree}') print '3333333333333333333333333333333333333333' ;;
  *'merge-base --is-ancestor main HEAD') exit 0 ;;
  *'diff --quiet --exit-code main...HEAD')
    [[ "${NUMA_FAKE_EMPTY:-0}" == '1' ]] && exit 0
    exit 1
    ;;
  *'diff --check main...HEAD')
    if [[ "${NUMA_FAKE_RANGE_WHITESPACE:-0}" == '1' ]]; then
      print 'candidate.swift:1: trailing whitespace.'
      exit 2
    fi
    exit 0
    ;;
  *) exit 2 ;;
esac
EOF
chmod +x "$fake_bin/git"

cat > "$repo/scripts/p1-release-check.sh" <<'EOF'
#!/bin/zsh
print -r -- 'release-scan' >> "$NUMA_PHASE_GATE_LOG"
EOF
chmod +x "$repo/scripts/p1-release-check.sh"

cat > "$repo/scripts/sync-test.sh" <<'EOF'
#!/bin/zsh
print -r -- "sync-test phase=${NUMA_PHASE:-missing}" >> "$NUMA_PHASE_GATE_LOG"
EOF
chmod +x "$repo/scripts/sync-test.sh"

cat > "$repo/scripts/tests/convex-local-integration-test.sh" <<'EOF'
#!/bin/zsh
print -r -- 'anonymous-local-integration' >> "$NUMA_PHASE_GATE_LOG"
EOF
chmod +x "$repo/scripts/tests/convex-local-integration-test.sh"

if "$repo/scripts/phase-gate.sh" P1 > "$temp_root/invalid.out" 2>&1; then
  print -u2 'P1 unexpectedly passed phase validation'
  exit 1
fi
if [[ "$(<"$temp_root/invalid.out")" != *'Usage: ./scripts/phase-gate.sh P2|P3|P4|P5'* ]]; then
  print -u2 'Invalid-phase failure did not print the required usage'
  exit 1
fi

if PATH="$fake_bin:/usr/bin:/bin" \
   NUMA_PHASE_GATE_LOG="$temp_root/empty.log" \
   NUMA_FAKE_EMPTY=1 \
   "$repo/scripts/phase-gate.sh" P2 > "$temp_root/empty.out" 2>&1; then
  print -u2 'Empty main...HEAD candidate unexpectedly passed'
  exit 1
fi
if [[ "$(<"$temp_root/empty.out")" != *'Phase candidate is empty'* ]]; then
  print -u2 'Empty-candidate failure did not explain the problem'
  exit 1
fi

if PATH="$fake_bin:/usr/bin:/bin" \
   NUMA_PHASE_GATE_LOG="$temp_root/dirty.log" \
   NUMA_FAKE_DIRTY=1 \
   "$repo/scripts/phase-gate.sh" P2 > "$temp_root/dirty.out" 2>&1; then
  print -u2 'Dirty worktree unexpectedly passed candidate identity validation'
  exit 1
fi
if [[ "$(<"$temp_root/dirty.out")" != *'requires a clean frozen worktree'* ]]; then
  print -u2 'Dirty-worktree failure did not explain the frozen-candidate requirement'
  exit 1
fi

if PATH="$fake_bin:/usr/bin:/bin" \
   NUMA_PHASE_GATE_LOG="$temp_root/whitespace.log" \
   NUMA_FAKE_RANGE_WHITESPACE=1 \
   "$repo/scripts/phase-gate.sh" P2 > "$temp_root/whitespace.out" 2>&1; then
  print -u2 'Candidate with range whitespace errors unexpectedly passed'
  exit 1
fi
if [[ "$(<"$temp_root/whitespace.out")" != *'contains whitespace errors'* ]]; then
  print -u2 'Range-whitespace failure did not explain the problem'
  exit 1
fi

if PATH="$fake_bin:/usr/bin:/bin" \
   NUMA_PHASE_GATE_LOG="$temp_root/changed.log" \
   NUMA_PHASE_GATE_STATE="$temp_root/head-reads" \
   NUMA_FAKE_HEAD_CHANGE=1 \
   "$repo/scripts/phase-gate.sh" P2 > "$temp_root/changed.out" 2>&1; then
  print -u2 'Candidate changed during the matrix but unexpectedly passed'
  exit 1
fi
if [[ "$(<"$temp_root/changed.out")" != *'Phase candidate changed while the matrix was running'* ]]; then
  print -u2 'Mid-matrix candidate-change failure did not invalidate the receipt'
  exit 1
fi

PATH="$fake_bin:/usr/bin:/bin" \
NUMA_PHASE_GATE_LOG="$log" \
  "$repo/scripts/phase-gate.sh" P2 > "$temp_root/gate.out"

expected=$(cat <<EOF
git -C $repo status --porcelain=v1 --untracked-files=all
git -C $repo rev-parse main
git -C $repo rev-parse HEAD
git -C $repo rev-parse HEAD^{tree}
git -C $repo merge-base --is-ancestor main HEAD
git -C $repo diff --quiet --exit-code main...HEAD
git -C $repo diff --check main...HEAD
convex-toolchain-pin
phase-gate-test
convex-toolchain-contract-test
sync-test-contract-test
convex-local-guard-test
convex-e2e-wrapper-contract-test
event-terminal-contract-test
auth-error-contract-test
xcodebuild-wrapper-contract-test
release-build-floor-contract-test
release-signing-contract-test
release-inspection-contract-test
release-web-preflight-contract-test
asc-build-floor-contract-test
swift test --package-path NumaSharedCore
swift test --package-path NumaSharedSync
npm run backend:typecheck --silent
npm run backend:test --silent
anonymous-local-integration
xcodebuild test -project $repo/ios/NumaShared/NumaShared.xcodeproj -scheme NumaShared -destination platform=iOS Simulator,name=iPhone 17 Pro Max,OS=27.0 -derivedDataPath /tmp/NumaShared-P2-Gate
release-scan
sync-test phase=P2
git -C $repo status --porcelain=v1 --untracked-files=all
git -C $repo rev-parse main
git -C $repo rev-parse HEAD
git -C $repo rev-parse HEAD^{tree}
EOF
)

actual=$(<"$log")
if [[ "$actual" != "$expected" ]]; then
  print -u2 'Phase-gate command sequence changed unexpectedly'
  print -u2 -- '--- expected ---'
  print -u2 -r -- "$expected"
  print -u2 -- '--- actual ---'
  print -u2 -r -- "$actual"
  exit 1
fi

if [[ "$(<"$temp_root/gate.out")" != *'LOCAL PHASE MATRIX PASS: P2 base=1111111111111111111111111111111111111111 head=2222222222222222222222222222222222222222 tree=3333333333333333333333333333333333333333'* ]]; then
  print -u2 'Successful gate did not report the frozen base/head receipt'
  exit 1
fi
if [[ "$(<"$temp_root/gate.out")" == *'PHASE GATE PASS'* ]]; then
  print -u2 'Local matrix output used the reserved phase-gate PASS wording'
  exit 1
fi

: > "$temp_root/p4.log"
PATH="$fake_bin:/usr/bin:/bin" \
NUMA_PHASE_GATE_LOG="$temp_root/p4.log" \
  "$repo/scripts/phase-gate.sh" P4 > "$temp_root/p4.out"
if ! rg -Fx --quiet 'sync-test phase=P3' "$temp_root/p4.log"; then
  print -u2 'P4 did not reuse the latest deterministic multi-account sync scenario'
  exit 1
fi
if rg -Fx --quiet 'sync-test phase=P4' "$temp_root/p4.log"; then
  print -u2 'P4 forwarded an unsupported sync-test phase'
  exit 1
fi
if [[ "$(<"$temp_root/p4.out")" != *'LOCAL PHASE MATRIX PASS: P4 base=1111111111111111111111111111111111111111 head=2222222222222222222222222222222222222222 tree=3333333333333333333333333333333333333333'* ]]; then
  print -u2 'P4 gate did not preserve its own frozen phase receipt'
  exit 1
fi

: > "$temp_root/p5.log"
PATH="$fake_bin:/usr/bin:/bin" \
NUMA_PHASE_GATE_LOG="$temp_root/p5.log" \
  "$repo/scripts/phase-gate.sh" P5 > "$temp_root/p5.out"
minimum_command="xcodebuild test -project $repo/ios/NumaShared/NumaShared.xcodeproj -scheme NumaShared -destination platform=iOS Simulator,name=iPhone 17 Pro,OS=26.2 -derivedDataPath /tmp/NumaShared-P5-Gate -parallel-testing-enabled NO -only-testing:NumaSharedUITests/GoldenPathUITests/testLocalExpenseBalanceAndRepayment"
p5_expected=${expected//NumaShared-P2-Gate/NumaShared-P5-Gate}
p5_expected=${p5_expected//sync-test phase=P2/sync-test phase=P3}
p5_expected=${p5_expected/release-scan/$minimum_command$'\n'release-scan}
if [[ "$(<"$temp_root/p5.log")" != "$p5_expected" ]]; then
  print -u2 'P5 must preserve the full existing matrix and add the pinned iOS 26 journey'
  diff -u <(print -r -- "$p5_expected") "$temp_root/p5.log" || true
  exit 1
fi
if [[ "$(<"$temp_root/p5.out")" != *'LOCAL PHASE MATRIX PASS: P5 base=1111111111111111111111111111111111111111 head=2222222222222222222222222222222222222222 tree=3333333333333333333333333333333333333333'* ]]; then
  print -u2 'P5 gate did not preserve its own frozen phase receipt'
  exit 1
fi

if PATH="$fake_bin:/usr/bin:/bin" \
   NUMA_PHASE_GATE_LOG="$temp_root/missing-runtime.log" \
   NUMA_FAKE_MISSING_MINIMUM_RUNTIME=1 \
   "$repo/scripts/phase-gate.sh" P5 > "$temp_root/missing-runtime.out" 2>&1; then
  print -u2 'P5 unexpectedly passed with the iOS 26 runtime missing'
  exit 1
else
  missing_runtime_status=$?
fi
if (( missing_runtime_status != 70 )) \
   || [[ "$(<"$temp_root/missing-runtime.out")" != *'Unable to find a destination matching iOS 26.2'* ]] \
   || [[ "$(<"$temp_root/missing-runtime.out")" == *'LOCAL PHASE MATRIX PASS'* ]] \
   || rg -q '^(release-scan$|sync-test phase=)' "$temp_root/missing-runtime.log"; then
  print -u2 'Missing minimum-runtime evidence must preserve failure status and stop the matrix'
  exit 1
fi

print 'phase-gate contract test passed: frozen range, P2/P4/P5 sync selection, iOS 27 pin, and fail-closed iOS 26 journey'
