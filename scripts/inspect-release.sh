#!/bin/zsh

set -euo pipefail

repo_root=${0:A:h:h}
source "$repo_root/scripts/release-inspection.sh"
output=${1:-/tmp/NumaShared-P5}
output=${output:A}
archive="$output/NumaShared.xcarchive"
archive_app="$archive/Products/Applications/NumaShared.app"
ipa=($output/export/*.ipa(N))
expected_app_id=${NUMA_SHARED_APP_IDENTIFIER:-}
[[ -n $expected_app_id ]] || {
  print -u2 'Missing NUMA_SHARED_APP_IDENTIFIER for signed-candidate inspection'
  exit 65
}
[[ -d $archive_app ]] || { print -u2 "Archive app missing: $archive_app"; exit 66; }
(( ${#ipa} == 1 )) || { print -u2 'Expected exactly one exported IPA'; exit 66; }
source_commit_file="$output/source-commit.txt"
[[ -f $source_commit_file ]] || { print -u2 'Candidate source-commit receipt missing'; exit 66; }
source_commit=$(<"$source_commit_file")
[[ ${#source_commit} == 40 && $source_commit != *[^0-9a-f]* ]] \
  || { print -u2 'Candidate source commit is invalid'; exit 1; }
git -C "$repo_root" cat-file -e "$source_commit^{commit}" 2>/dev/null \
  || { print -u2 'Candidate source commit is not present in this repository'; exit 1; }
cd "$repo_root"

payload_root=$(mktemp -d /tmp/NumaShared-ipa-inspection.XXXXXX)
entitlements=$(mktemp /tmp/NumaShared-entitlements.XXXXXX.plist)
signature_details=$(mktemp /tmp/NumaShared-signature.XXXXXX.txt)
cleanup() {
  /bin/rm -f -- "$entitlements"
  /bin/rm -f -- "$signature_details"
  /bin/rm -rf -- "$payload_root"
}
trap cleanup EXIT
app=$(extract_ipa_app "$ipa[1]" "$payload_root") \
  || { print -u2 'Exported IPA must contain exactly one app payload'; exit 1; }
[[ -d $app ]] || { print -u2 'Exported IPA app payload is missing'; exit 1; }
verify_code_signature "$app" \
  || { print -u2 'Exported IPA code signature verification failed'; exit 1; }
describe_code_signature "$app" "$signature_details" \
  || { print -u2 'Exported IPA signature details could not be read'; exit 1; }
signature_authority=$(sed -n 's/^Authority=//p' "$signature_details" | head -n 1)
signature_team=$(sed -n 's/^TeamIdentifier=//p' "$signature_details" | head -n 1)
[[ $signature_authority == 'Apple Distribution: '*'(794UJ787LZ)' \
  && $signature_team == 794UJ787LZ ]] \
  || { print -u2 'Exported IPA distribution authority mismatch'; exit 1; }
verify_app_runtime_dependencies "$app" \
  || { print -u2 'Exported IPA runtime dependency closure failed'; exit 1; }

info="$app/Info.plist"
bundle=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$info")
version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$info")
build=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$info")
[[ $bundle == tech.arsik.numashared ]] || { print -u2 "Unexpected bundle: $bundle"; exit 1; }
for key in NumaSharedConvexURL NumaSharedSiteURL NumaSharedAppStoreURL NumaSharedSupportEmail; do
  value=$(/usr/libexec/PlistBuddy -c "Print :$key" "$info")
  [[ -n $value ]] || { print -u2 "Empty Release Info.plist key: $key"; exit 1; }
done
site_url=$(/usr/libexec/PlistBuddy -c 'Print :NumaSharedSiteURL' "$info")
convex_url=$(/usr/libexec/PlistBuddy -c 'Print :NumaSharedConvexURL' "$info")
[[ $(/usr/libexec/PlistBuddy -c 'Print :ITSAppUsesNonExemptEncryption' "$info") == false ]] \
  || { print -u2 'Unexpected encryption declaration'; exit 1; }

decode_signed_entitlements "$app" "$entitlements" \
  || { print -u2 'Signed IPA entitlements could not be decoded'; exit 1; }
app_id=$(/usr/libexec/PlistBuddy -c 'Print :application-identifier' "$entitlements")
team=$(/usr/libexec/PlistBuddy -c 'Print :com.apple.developer.team-identifier' "$entitlements")
[[ $app_id == $expected_app_id && $team == 794UJ787LZ ]] \
  || { print -u2 'Signed identity mismatch'; exit 1; }
[[ $(/usr/libexec/PlistBuddy -c 'Print :aps-environment' "$entitlements") == production ]] \
  || { print -u2 'Signed APNs environment is not production'; exit 1; }
[[ $(/usr/libexec/PlistBuddy -c 'Print :com.apple.developer.applesignin:0' "$entitlements") == Default ]] \
  || { print -u2 'Signed Sign in with Apple entitlement is invalid'; exit 1; }
site_host=${site_url#https://}
[[ -n $site_host && $site_host != */* ]] \
  || { print -u2 'Archived site URL is not an HTTPS origin'; exit 1; }
associated_domain=$(/usr/libexec/PlistBuddy \
  -c 'Print :com.apple.developer.associated-domains:0' "$entitlements")
[[ $associated_domain == "applinks:$site_host" ]] \
  || { print -u2 'Signed associated domain does not match the archived site origin'; exit 1; }
node scripts/release-web-preflight.mjs "$site_url" "$convex_url" "$app_id"

scan_release_qa_markers "$app"

archive_hash=$(archive_manifest_sha256 "$archive") \
  || { print -u2 'Archive manifest could not be hashed'; exit 1; }
ipa_hash=$(/usr/bin/shasum -a 256 "$ipa[1]" | /usr/bin/cut -d' ' -f1)
[[ ${#archive_hash} == 64 && $archive_hash != *[^0-9a-f]* ]] \
  || { print -u2 'Archive manifest hash is invalid'; exit 1; }
[[ ${#ipa_hash} == 64 && $ipa_hash != *[^0-9a-f]* ]] \
  || { print -u2 'IPA hash is invalid'; exit 1; }
print "RELEASE INSPECTION PASS: source=$source_commit bundle=$bundle version=$version build=$build team=$team appID=$app_id"
print "ARCHIVE_MANIFEST_SHA256 $archive_hash"
print "IPA_SHA256 $ipa_hash"
