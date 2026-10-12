#!/bin/zsh

set -euo pipefail

repo_root=${0:A:h:h:h}
temp_root=$(mktemp -d /tmp/NumaShared-auth-contract.XXXXXX)
trap 'rm -rf -- "$temp_root"' EXIT

rg -o 'fail\("AUTH_[A-Z_]+"' "$repo_root/convex/lib/access.ts" \
  | sed -e 's/^fail("//' -e 's/"$//' \
  | LC_ALL=C sort -u > "$temp_root/backend"
rg -o '"AUTH_[A-Z_]+"' \
  "$repo_root/NumaSharedSync/Sources/NumaSharedSync/SyncTransport.swift" \
  | tr -d '"' \
  | LC_ALL=C sort -u > "$temp_root/client"

if ! cmp -s "$temp_root/backend" "$temp_root/client"; then
  print -u2 'Backend authentication codes and the Swift recovery contract differ.'
  diff -u "$temp_root/backend" "$temp_root/client" >&2 || true
  exit 1
fi

if [[ ! -s "$temp_root/backend" ]]; then
  print -u2 'Authentication error contract unexpectedly contains no codes.'
  exit 1
fi

print "auth-error contract test passed: $(wc -l < "$temp_root/backend" | tr -d ' ') codes mapped"
