#!/bin/zsh

set -euo pipefail
umask 077

repo_root=${0:A:h:h}
source "$repo_root/scripts/release-inspection.sh"
output=${1:-/tmp/NumaShared-P5}
output=${output:A}
archive="$output/NumaShared.xcarchive"
info="$archive/Products/Applications/NumaShared.app/Info.plist"
source_commit_file="$output/source-commit.txt"

[[ -f $info && -f $source_commit_file ]] || {
  print -u2 "Upload candidate is incomplete: $output"
  exit 66
}
source_commit=$(<"$source_commit_file")
version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$info")
build=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$info")
require_candidate_upload_approval "$output" "$source_commit" "$version" "$build"
[[ ! -e $output/upload ]] || {
  print -u2 "Upload receipt path already exists: $output/upload"
  exit 73
}

cd "$repo_root"
./scripts/release-preflight.sh
./scripts/inspect-release.sh "$output"
require_candidate_upload_approval "$output" "$source_commit" "$version" "$build"

xcodebuild -exportArchive \
  -archivePath "$archive" \
  -exportPath "$output/upload" \
  -exportOptionsPlist config/ExportOptions-Upload.plist \
  -authenticationKeyPath "$ASC_KEY_PATH" \
  -authenticationKeyID "$ASC_KEY_ID" \
  -authenticationKeyIssuerID "$ASC_ISSUER_ID"

print "ASC UPLOAD REQUEST COMPLETE: source=$source_commit version=$version build=$build"
