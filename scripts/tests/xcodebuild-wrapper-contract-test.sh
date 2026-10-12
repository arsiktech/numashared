#!/bin/zsh

set -euo pipefail

repo_root=${0:A:h:h:h}
temp_root=$(mktemp -d /tmp/NumaShared-xcodebuild-wrapper.XXXXXX)
trap 'rm -rf -- "$temp_root"' EXIT
mkdir -p "$temp_root/bin"

cat > "$temp_root/bin/xcodebuild" <<'EOF'
#!/bin/zsh
print -r -- "$*" > "$NUMA_XCODEBUILD_WRAPPER_LOG"
exit "${NUMA_XCODEBUILD_WRAPPER_STATUS:-0}"
EOF
chmod +x "$temp_root/bin/xcodebuild"

PATH="$temp_root/bin:/usr/bin:/bin" \
NUMA_XCODEBUILD_WRAPPER_LOG="$temp_root/pass.log" \
  "$repo_root/scripts/xcodebuild-test.sh" test -project Project.xcodeproj
if [[ "$(<"$temp_root/pass.log")" != 'test -project Project.xcodeproj' ]]; then
  print -u2 'Xcodebuild wrapper did not preserve arguments.'
  exit 1
fi

set +e
PATH="$temp_root/bin:/usr/bin:/bin" \
NUMA_XCODEBUILD_WRAPPER_LOG="$temp_root/fail.log" \
NUMA_XCODEBUILD_WRAPPER_STATUS=73 \
  "$repo_root/scripts/xcodebuild-test.sh" test
exit_status=$?
set -e
if (( exit_status != 73 )); then
  print -u2 "Xcodebuild wrapper changed failure status: $exit_status"
  exit 1
fi

print 'xcodebuild wrapper contract test passed: arguments and status preserved'
