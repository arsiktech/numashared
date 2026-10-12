#!/bin/zsh

set -euo pipefail
umask 077

repo_root=${0:A:h:h:h}
temp_root=$(/usr/bin/mktemp -d /tmp/NumaShared-toolchain-contract.XXXXXX)
trap '/bin/rm -rf -- "$temp_root"' EXIT

fixture="$temp_root/fixture"
/bin/mkdir -p "$fixture/node_modules/.bin" "$fixture/backend"
/bin/cp "$repo_root/scripts/convex-toolchain.json" "$fixture/pin.json"
/bin/cp "$repo_root/package.json" "$fixture/package.json"
/bin/cp "$repo_root/package-lock.json" "$fixture/package-lock.json"
/bin/mkdir -p "$fixture/node_modules/@esbuild"
for package_name in convex esbuild prettier ws; do
  /bin/cp -R "$repo_root/node_modules/$package_name" \
    "$fixture/node_modules/$package_name"
done
/bin/cp -R "$repo_root/node_modules/@esbuild/darwin-arm64" \
  "$fixture/node_modules/@esbuild/darwin-arm64"
/bin/ln -s ../convex/bin/main.js "$fixture/node_modules/.bin/convex"
backend_source="${XDG_CACHE_HOME:-$HOME/.cache}/convex/binaries/precompiled-2026-07-06-44f7aa7/convex-local-backend"
/bin/cp "$backend_source" "$fixture/backend/convex-local-backend"
/bin/chmod +x "$fixture/backend/convex-local-backend"

verify=(
  node "$repo_root/scripts/convex-toolchain-verify.mjs"
  "$fixture/pin.json"
  "$fixture/package.json"
  "$fixture/package-lock.json"
  "$fixture/node_modules/convex/package.json"
  "$fixture/node_modules/.bin/convex"
  "$fixture/backend/convex-local-backend"
)
"${verify[@]}" > "$temp_root/pass.out"
rg -F --quiet 'convex-runtime-package-convex-sha256=' "$temp_root/pass.out"
rg -F --quiet 'convex-backend-executable-sha256=' "$temp_root/pass.out"

expect_failure() {
  local label=$1
  local expected=$2
  if "${verify[@]}" > "$temp_root/$label.out" 2>&1; then
    print -u2 "$label tampering unexpectedly passed"
    exit 1
  fi
  rg -F --quiet "$expected" "$temp_root/$label.out"
}

print -r -- '// tampered' >> "$fixture/node_modules/convex/bin/main.js"
expect_failure cli-bytes 'runtime package convex tree hash'
/bin/cp "$repo_root/node_modules/convex/bin/main.js" \
  "$fixture/node_modules/convex/bin/main.js"

/bin/rm "$fixture/node_modules/.bin/convex"
/bin/ln -s ../convex/package.json "$fixture/node_modules/.bin/convex"
expect_failure cli-symlink 'canonical package entry point'
/bin/rm "$fixture/node_modules/.bin/convex"
/bin/ln -s ../convex/bin/main.js "$fixture/node_modules/.bin/convex"

print -n 'tampered' >> "$fixture/backend/convex-local-backend"
expect_failure backend-bytes 'Convex backend hash'

print 'convex toolchain contract PASS: CLI tree, entrypoint, backend bytes, and tampering'
