#!/bin/zsh

set -euo pipefail

repo_root=${0:A:h:h:h}
assertion="$repo_root/scripts/assert-build-floor.mjs"

pass_output=$(print 'ASC_BUILD_FLOOR 1' | node "$assertion" 2)
[[ $pass_output == 'ASC_BUILD_NUMBER PASS: candidate=2 floor=1' ]] || {
  print -u2 'A fresh build number did not produce the expected receipt'
  exit 1
}

if print 'ASC_BUILD_FLOOR 1' | node "$assertion" 1 >/dev/null 2>&1; then
  print -u2 'A reused build number unexpectedly passed'
  exit 1
fi
if print 'ASC_APP present' | node "$assertion" 2 >/dev/null 2>&1; then
  print -u2 'Missing build-floor evidence unexpectedly passed'
  exit 1
fi
if print $'ASC_BUILD_FLOOR 0\nASC_BUILD_FLOOR 1' | node "$assertion" 2 >/dev/null 2>&1; then
  print -u2 'Ambiguous build-floor evidence unexpectedly passed'
  exit 1
fi
if print 'ASC_BUILD_FLOOR 1' | node "$assertion" 2.1 >/dev/null 2>&1; then
  print -u2 'A non-integer candidate build unexpectedly passed'
  exit 1
fi

print 'release build-floor contract test passed: only one fresh positive-integer candidate is accepted'
