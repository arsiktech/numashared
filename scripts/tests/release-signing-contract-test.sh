#!/bin/zsh

set -euo pipefail

repo_root=${0:A:h:h:h}
source "$repo_root/scripts/release-signing.sh"

fingerprint=A8881DD71420EE4E9088E021673A84A5A9C28394
matching=$'  1) A8881DD71420EE4E9088E021673A84A5A9C28394 "Apple Distribution: Numa (794UJ787LZ)"\n     1 valid identities found'
fingerprint_then_distribution=$'  1) A8881DD71420EE4E9088E021673A84A5A9C28394 "Apple Development: Other"\n  2) BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB "Apple Distribution: Other"'
distribution_then_fingerprint=$'  1) BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB "Apple Distribution: Other"\n  2) A8881DD71420EE4E9088E021673A84A5A9C28394 "Apple Development: Other"'

codesigning_identity_matches "$fingerprint" "$matching" || {
  print -u2 'Matching distribution identity was rejected'
  exit 1
}
if codesigning_identity_matches "$fingerprint" "$fingerprint_then_distribution"; then
  print -u2 'Fingerprint and later distribution label crossed identity rows'
  exit 1
fi
if codesigning_identity_matches "$fingerprint" "$distribution_then_fingerprint"; then
  print -u2 'Distribution label and later fingerprint crossed identity rows'
  exit 1
fi

print 'release signing contract PASS: fingerprint and distribution label share one identity row'
