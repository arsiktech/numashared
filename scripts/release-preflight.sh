#!/bin/zsh

set -euo pipefail

repo_root=${0:A:h:h}
cd "$repo_root"
source "$repo_root/scripts/release-signing.sh"

fail() { print -u2 "RELEASE PREFLIGHT FAIL: $1"; exit 1 }
required_env=(ASC_KEY_ID ASC_ISSUER_ID ASC_KEY_PATH APPLE_TEAM_ID \
  NUMA_SHARED_CONVEX_URL NUMA_SHARED_SITE_URL NUMA_SHARED_APP_STORE_URL \
  NUMA_SHARED_SUPPORT_EMAIL NUMA_SHARED_APP_IDENTIFIER)
for name in $required_env; do
  [[ -n ${(P)name:-} ]] || fail "missing env name $name"
done
[[ $APPLE_TEAM_ID == 794UJ787LZ ]] || fail "unexpected Apple team"
[[ -f $ASC_KEY_PATH ]] || fail "ASC key path is unavailable"
[[ $(stat -f '%Lp' "$ASC_KEY_PATH") == 600 ]] || fail "ASC key mode must be 600"
for name in NUMA_SHARED_CONVEX_URL NUMA_SHARED_SITE_URL NUMA_SHARED_APP_STORE_URL; do
  value=${(P)name}
  [[ $value == https://* && $value != *[[:space:]]* ]] || fail "$name must be nonempty HTTPS"
  host=${value#https://}
  host=${host%%/*}
  [[ $host != localhost && $host != 127.* && $host != *.localhost && $host != *.invalid ]] \
    || fail "$name must use a public production host"
done
site_host=${NUMA_SHARED_SITE_URL#https://}
[[ $site_host != */* && -n $site_host ]] || fail "site URL must be an HTTPS origin without a path"
[[ $NUMA_SHARED_SITE_URL == https://adept-camel-457.convex.site ]] \
  || fail "site URL must equal the approved Numa Shared release origin"
[[ $NUMA_SHARED_CONVEX_URL == https://adept-camel-457.convex.cloud ]] \
  || fail "Convex URL must equal the approved Numa Shared production deployment"
[[ $NUMA_SHARED_APP_STORE_URL == https://apps.apple.com/*/id6790012321 \
  || $NUMA_SHARED_APP_STORE_URL == https://apps.apple.com/app/id6790012321 ]] \
  || fail "App Store URL must target Apple ID 6790012321"
[[ $NUMA_SHARED_SUPPORT_EMAIL == *@*.* && $NUMA_SHARED_SUPPORT_EMAIL != *[[:space:]]* ]] \
  || fail "support email is invalid"
support_domain=${NUMA_SHARED_SUPPORT_EMAIL##*@}
[[ $support_domain != localhost && $support_domain != *.localhost && $support_domain != *.invalid ]] \
  || fail "support email must use a production domain"
[[ ${NUMA_SHARED_APP_IDENTIFIER#*.} == tech.arsik.numashared ]] \
  || fail "application identifier must target tech.arsik.numashared"
node scripts/release-web-preflight.mjs \
  "$NUMA_SHARED_SITE_URL" "$NUMA_SHARED_CONVEX_URL" \
  "$NUMA_SHARED_APP_IDENTIFIER"

[[ -z $(git status --short) ]] || fail "worktree must be clean"
[[ $(git branch --show-current) == v1-ship ]] || fail "candidate must be on v1-ship"
git diff --check main...HEAD

project=ios/NumaShared/NumaShared.xcodeproj/project.pbxproj
version=$(sed -n 's/^[[:space:]]*MARKETING_VERSION = \([^;]*\);/\1/p' "$project" | head -n 1)
build=$(sed -n 's/^[[:space:]]*CURRENT_PROJECT_VERSION = \([^;]*\);/\1/p' "$project" | head -n 1)
[[ -n $version && $build == <-> ]] || fail "version/build settings are invalid"

icon=ios/NumaShared/NumaShared/Assets.xcassets/AppIcon.appiconset/AppIcon.png
[[ -f $icon ]] || fail "default AppIcon is missing"
icon_info=$(sips -g pixelWidth -g pixelHeight -g hasAlpha "$icon")
[[ $icon_info == *"pixelWidth: 1024"* && $icon_info == *"pixelHeight: 1024"* \
  && $icon_info == *"hasAlpha: no"* ]] || fail "AppIcon must be opaque 1024x1024"

screenshots=(app-store/screenshots/en-US/6.9-inch/*.(jpg|jpeg|png)(N))
(( ${#screenshots} == 5 )) || fail "expected exactly five 6.9-inch App Store screenshots"
for screenshot in $screenshots; do
  screenshot_info=$(sips -g pixelWidth -g pixelHeight -g hasAlpha "$screenshot")
  [[ $screenshot_info == *"pixelWidth: 1320"* \
    && $screenshot_info == *"pixelHeight: 2868"* \
    && $screenshot_info == *"hasAlpha: no"* ]] \
    || fail "$screenshot must be opaque 1320x2868"
done
(cd app-store/screenshots/en-US/6.9-inch && shasum -a 256 -c SHA256SUMS) \
  || fail "App Store screenshot hashes do not match the frozen Release captures"
[[ $(/usr/libexec/PlistBuddy -c 'Print :aps-environment' \
  ios/NumaShared/NumaShared/NumaSharedRelease.entitlements) == production ]] \
  || fail "Release APNs entitlement must be production"

for plist in config/ExportOptions-AppStore.plist config/ExportOptions-Upload.plist; do
  plutil -lint "$plist" >/dev/null
  [[ $(/usr/libexec/PlistBuddy -c 'Print :method' "$plist") == app-store-connect ]] \
    || fail "$plist method"
  [[ $(/usr/libexec/PlistBuddy -c 'Print :manageAppVersionAndBuildNumber' "$plist") == false ]] \
    || fail "$plist automatic build numbering"
  [[ $(/usr/libexec/PlistBuddy -c 'Print :testFlightInternalTestingOnly' "$plist") == false ]] \
    || fail "$plist internal-only setting"
  [[ $(/usr/libexec/PlistBuddy -c 'Print :signingStyle' "$plist") == manual ]] \
    || fail "$plist signing style"
  [[ $(/usr/libexec/PlistBuddy -c \
    'Print :provisioningProfiles:tech.arsik.numashared' "$plist") \
    == 'Numa Shared App Store 2026-07-20' ]] \
    || fail "$plist provisioning profile"
done

profile_uuid=9a3bb0bf-8da9-48fd-82a4-9a43f31a1d10
profile_path="$HOME/Library/MobileDevice/Provisioning Profiles/$profile_uuid.mobileprovision"
[[ -f $profile_path ]] || fail "approved provisioning profile is not installed"
profile_xml=$(security cms -D -i "$profile_path" 2>/dev/null) \
  || fail "approved provisioning profile could not be decoded"
profile_value() {
  print -r -- "$profile_xml" | plutil -extract "$1" raw -o - -
}
[[ $(profile_value Name) == 'Numa Shared App Store 2026-07-20' ]] \
  || fail "installed provisioning profile name"
[[ $(profile_value UUID) == $profile_uuid ]] \
  || fail "installed provisioning profile UUID"
[[ $(profile_value TeamIdentifier.0) == 794UJ787LZ ]] \
  || fail "installed provisioning profile team"
[[ $(profile_value Entitlements.application-identifier) == $NUMA_SHARED_APP_IDENTIFIER ]] \
  || fail "installed provisioning profile application identifier"
profile_certificate_sha1=$(
  print -r -- "$profile_xml" \
    | plutil -extract DeveloperCertificates.0 raw -o - - \
    | base64 -D \
    | openssl x509 -inform der -noout -fingerprint -sha1 \
    | sed 's/^.*=//; s/://g'
)
[[ ${#profile_certificate_sha1} == 40 && $profile_certificate_sha1 != *[^[:xdigit:]]* ]] \
  || fail "approved profile certificate fingerprint"
codesigning_identities=$(security find-identity -v -p codesigning 2>/dev/null) \
  || fail "code-signing identities are unavailable"
codesigning_identity_matches "$profile_certificate_sha1" "$codesigning_identities" \
  || fail "matching Apple Distribution identity is not installed"

xcodebuild -version
asc_inventory=$(node scripts/asc-readonly.mjs)
print -r -- "$asc_inventory"
print -r -- "$asc_inventory" | node scripts/assert-build-floor.mjs "$build"
print "RELEASE PREFLIGHT PASS: commit=$(git rev-parse HEAD) version=$version build=$build"
