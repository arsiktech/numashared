#!/bin/zsh

set -euo pipefail

repo_root=${0:A:h:h}
source "$repo_root/scripts/release-inspection.sh"
derived_data=/tmp/NumaShared-P1-Release
project="$repo_root/ios/NumaShared/NumaShared.xcodeproj"
app_bundle="$derived_data/Build/Products/Release-iphonesimulator/NumaShared.app"
binary="$app_bundle/NumaShared"

# Build only the active (runnable) architecture. On this Apple Silicon host that is
# arm64 — the same slice that runs in the simulator and ships to the App Store
# (arm64 device). The x86_64 simulator slice is never run here nor shipped, and with
# the local packages built as dynamic frameworks (needed for Xcode 27's test host) the
# convex-swift Rust FFI does not link for x86_64. Restricting to the active arch keeps
# this check validating the real shippable binary. See DECISIONS.md 2026-07-14.
xcodebuild clean build \
  -project "$project" \
  -scheme NumaShared \
  -configuration Release \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max,OS=27.0' \
  -derivedDataPath "$derived_data" \
  ONLY_ACTIVE_ARCH=YES

if [[ ! -f "$binary" ]]; then
  print -u2 "Release binary missing: $binary"
  exit 1
fi

scan_release_qa_markers "$app_bundle"
verify_app_runtime_dependencies "$app_bundle"
