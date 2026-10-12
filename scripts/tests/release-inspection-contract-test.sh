#!/bin/zsh

set -euo pipefail

repo_root=${0:A:h:h:h}
source "$repo_root/scripts/release-inspection.sh"

temp_root=$(mktemp -d /tmp/NumaShared-release-inspection-test.XXXXXX)
trap '/bin/rm -rf -- "$temp_root"' EXIT
mkdir -p "$temp_root/source/Payload/NumaShared.app" "$temp_root/extracted"
print 'fixture' > "$temp_root/source/Payload/NumaShared.app/Info.plist"
(cd "$temp_root/source" && /usr/bin/zip -qry "$temp_root/candidate.ipa" Payload)

app=$(extract_ipa_app "$temp_root/candidate.ipa" "$temp_root/extracted") || {
  print -u2 'A single IPA app payload was rejected'
  exit 1
}
[[ $app == "$temp_root/extracted/Payload/NumaShared.app" ]] || {
  print -u2 'Inspection did not select the exported IPA app'
  exit 1
}

mkdir -p "$temp_root/ambiguous/Payload/Other.app"
cp -R "$temp_root/source/Payload/NumaShared.app" "$temp_root/ambiguous/Payload/"
(cd "$temp_root/ambiguous" && /usr/bin/zip -qry "$temp_root/ambiguous.ipa" Payload)
mkdir -p "$temp_root/ambiguous-extracted"
if extract_ipa_app "$temp_root/ambiguous.ipa" "$temp_root/ambiguous-extracted" >/dev/null; then
  print -u2 'An IPA with multiple app payloads was accepted'
  exit 1
fi

fake_codesign="$temp_root/codesign"
{
  print '#!/bin/zsh'
  print 'case "$*" in'
  print '  "-d --entitlements :- /tmp/Signed.app")'
  print '    print "<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict><key>fixture</key><string>xml</string></dict></plist>" ;;'
  print '  "--verify --deep --strict --verbose=2 /tmp/Signed.app") exit 0 ;;'
  print '  "-d --verbose=4 /tmp/Signed.app")'
  print '    print -u2 "Authority=Apple Distribution: Fixture (794UJ787LZ)"'
  print '    print -u2 "TeamIdentifier=794UJ787LZ" ;;'
  print '  *) exit 64 ;;'
  print 'esac'
} > "$fake_codesign"
chmod +x "$fake_codesign"
CODESIGN_BIN="$fake_codesign" decode_signed_entitlements \
  /tmp/Signed.app "$temp_root/entitlements.plist"
[[ $(plutil -extract fixture raw -o - "$temp_root/entitlements.plist") == xml ]] || {
  print -u2 'Entitlement decoder did not request XML on standard output'
  exit 1
}
CODESIGN_BIN="$fake_codesign" verify_code_signature /tmp/Signed.app || {
  print -u2 'Strict exported-app signature verification was not requested'
  exit 1
}
CODESIGN_BIN="$fake_codesign" describe_code_signature \
  /tmp/Signed.app "$temp_root/signature.txt"
[[ $(sed -n 's/^Authority=//p' "$temp_root/signature.txt") \
  == 'Apple Distribution: Fixture (794UJ787LZ)' \
  && $(sed -n 's/^TeamIdentifier=//p' "$temp_root/signature.txt") == 794UJ787LZ ]] || {
  print -u2 'Distribution signature authority details were not requested'
  exit 1
}

failing_codesign="$temp_root/failing-codesign"
{
  print '#!/bin/zsh'
  print '[[ "$*" == "--verify --deep --strict --verbose=2 /tmp/Tampered.app" ]] || exit 64'
  print 'exit 42'
} > "$failing_codesign"
chmod +x "$failing_codesign"
if CODESIGN_BIN="$failing_codesign" verify_code_signature /tmp/Tampered.app; then
  print -u2 'A failed exported-app signature verification was accepted'
  exit 1
fi

runtime_app="$temp_root/Runtime.app"
mkdir -p "$runtime_app/Frameworks"
plutil -create xml1 "$runtime_app/Info.plist"
plutil -insert CFBundleExecutable -string Main "$runtime_app/Info.plist"
print 'main' > "$runtime_app/Main"
failing_otool="$temp_root/failing-otool"
{
  print '#!/bin/zsh'
  print '[[ "$1" == -L ]] || exit 64'
  print 'exit 42'
} > "$failing_otool"
chmod +x "$failing_otool"
if OTOOL_BIN="$failing_otool" verify_app_runtime_dependencies "$runtime_app" \
  >/dev/null 2>&1; then
  print -u2 'A failed runtime dependency inspection was accepted'
  exit 1
fi
malformed_otool="$temp_root/malformed-otool"
{
  print '#!/bin/zsh'
  print '[[ "$1" == -L ]] || exit 64'
  print 'print "not an otool listing"'
} > "$malformed_otool"
chmod +x "$malformed_otool"
if OTOOL_BIN="$malformed_otool" verify_app_runtime_dependencies "$runtime_app" \
  >/dev/null 2>&1; then
  print -u2 'Malformed runtime dependency inspection output was accepted'
  exit 1
fi
fake_otool="$temp_root/otool"
{
  print '#!/bin/zsh'
  print '[[ "$1" == -L ]] || exit 64'
  print 'print "$2:"'
  print 'case "${2:t}" in'
  print '  Main)'
  print '    print "\t@rpath/Present.framework/Present (compatibility version 0.0.0, current version 0.0.0)"'
  print '    print "\t@rpath/Missing.framework/Missing (compatibility version 0.0.0, current version 0.0.0)" ;;'
  print '  Present|Missing) print "\t@rpath/${2:h:t}/${2:t} (compatibility version 0.0.0, current version 0.0.0)" ;;'
  print '  *) exit 64 ;;'
  print 'esac'
} > "$fake_otool"
chmod +x "$fake_otool"
if OTOOL_BIN="$fake_otool" verify_app_runtime_dependencies "$runtime_app" >/dev/null 2>&1; then
  print -u2 'A hard-linked missing runtime framework was accepted'
  exit 1
fi
for name in Present Missing; do
  mkdir -p "$runtime_app/Frameworks/$name.framework"
  plutil -create xml1 "$runtime_app/Frameworks/$name.framework/Info.plist"
  plutil -insert CFBundleExecutable -string "$name" \
    "$runtime_app/Frameworks/$name.framework/Info.plist"
  print "$name" > "$runtime_app/Frameworks/$name.framework/$name"
done
OTOOL_BIN="$fake_otool" verify_app_runtime_dependencies "$runtime_app" >/dev/null || {
  print -u2 'A complete runtime framework closure was rejected'
  exit 1
}

markers=("${(@f)$(release_qa_markers)}")
(( ${#markers} == 14 )) || {
  print -u2 "Expected 14 canonical QA markers, got ${#markers}"
  exit 1
}
scan_release_qa_markers "$app" >/dev/null
print -- '--qa-long-balance-layout' > "$app/LeakedMarker"
if scan_release_qa_markers "$app" >/dev/null 2>&1; then
  print -u2 'A canonical QA marker in the exported app was accepted'
  exit 1
fi
/bin/rm -f -- "$app/LeakedMarker"

mkdir -p "$temp_root/archive/Products"
print 'one' > "$temp_root/archive/Products/App"
ln -s App "$temp_root/archive/Products/AppLink"
first_hash=$(archive_manifest_sha256 "$temp_root/archive")
second_hash=$(archive_manifest_sha256 "$temp_root/archive")
[[ ${#first_hash} == 64 && $first_hash == $second_hash ]] || {
  print -u2 'Archive manifest hash is not deterministic'
  exit 1
}
print 'two' > "$temp_root/archive/Products/App"
changed_hash=$(archive_manifest_sha256 "$temp_root/archive")
[[ ${#changed_hash} == 64 && $changed_hash != $first_hash ]] || {
  print -u2 'Archive manifest hash did not detect a file mutation'
  exit 1
}

mode_before_hash=$changed_hash
chmod 755 "$temp_root/archive/Products/App"
mode_changed_hash=$(archive_manifest_sha256 "$temp_root/archive")
[[ ${#mode_changed_hash} == 64 && $mode_changed_hash != $mode_before_hash ]] || {
  print -u2 'Archive manifest hash did not detect a file-mode mutation'
  exit 1
}

candidate_root="$temp_root/upload-candidate"
mkdir -p "$candidate_root/export"
cp -R "$temp_root/archive" "$candidate_root/NumaShared.xcarchive"
cp "$temp_root/candidate.ipa" "$candidate_root/export/NumaShared.ipa"
source_commit=0123456789abcdef0123456789abcdef01234567
approval=$(candidate_upload_approval_token "$candidate_root" "$source_commit" 1.0 4)
NUMA_ASC_UPLOAD_APPROVED="$approval" require_candidate_upload_approval \
  "$candidate_root" "$source_commit" 1.0 4
if NUMA_ASC_UPLOAD_APPROVED="$source_commit:1.0:4" require_candidate_upload_approval \
  "$candidate_root" "$source_commit" 1.0 4 >/dev/null 2>&1; then
  print -u2 'Source/version/build-only upload approval was accepted'
  exit 1
fi
chmod 644 "$candidate_root/NumaShared.xcarchive/Products/App"
if NUMA_ASC_UPLOAD_APPROVED="$approval" require_candidate_upload_approval \
  "$candidate_root" "$source_commit" 1.0 4 >/dev/null 2>&1; then
  print -u2 'Archive mode mutation retained its prior upload approval'
  exit 1
fi
new_approval=$(candidate_upload_approval_token "$candidate_root" "$source_commit" 1.0 4)
print 'tamper' >> "$candidate_root/export/NumaShared.ipa"
if NUMA_ASC_UPLOAD_APPROVED="$new_approval" require_candidate_upload_approval \
  "$candidate_root" "$source_commit" 1.0 4 >/dev/null 2>&1; then
  print -u2 'IPA mutation retained its prior upload approval'
  exit 1
fi

print 'release inspection contract PASS: exported IPA app, strict distribution signature, runtime dependency closure, 14 QA markers, modes, hashes, and artifact-bound approval'
