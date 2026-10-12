#!/bin/zsh

set -euo pipefail
umask 077

repo_root=${0:A:h:h}
output=${1:-/tmp/NumaShared-P5}
output=${output:A}
[[ ${NUMA_EXPORT_COMPLIANCE_APPROVED:-} == yes ]] || {
  print -u2 'Archive blocked: set NUMA_EXPORT_COMPLIANCE_APPROVED=yes only after operator confirmation'
  exit 65
}
[[ ! -e $output ]] || { print -u2 "Archive output already exists: $output"; exit 73; }

cd "$repo_root"
./scripts/release-preflight.sh
source_commit=$(git rev-parse HEAD)
site_host=${NUMA_SHARED_SITE_URL#https://}
mkdir -p "$output/export"
archive="$output/NumaShared.xcarchive"

xcodebuild archive \
  -project ios/NumaShared/NumaShared.xcodeproj \
  -scheme NumaShared \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$archive" \
  NUMA_SHARED_CONVEX_URL="$NUMA_SHARED_CONVEX_URL" \
  NUMA_SHARED_SITE_URL="$NUMA_SHARED_SITE_URL" \
  NUMA_SHARED_SITE_HOST="$site_host" \
  NUMA_SHARED_APP_STORE_URL="$NUMA_SHARED_APP_STORE_URL" \
  NUMA_SHARED_SUPPORT_EMAIL="$NUMA_SHARED_SUPPORT_EMAIL"

xcodebuild -exportArchive \
  -archivePath "$archive" \
  -exportPath "$output/export" \
  -exportOptionsPlist config/ExportOptions-AppStore.plist

[[ -z $(git status --short) && $(git rev-parse HEAD) == $source_commit ]] || {
  print -u2 'Candidate source changed while the archive was running'
  exit 65
}
print -r -- "$source_commit" > "$output/source-commit.txt"

print "LOCAL EXPORT COMPLETE: $output"
