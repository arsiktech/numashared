#!/bin/zsh

codesigning_identity_matches() {
  local fingerprint=$1
  local inventory=$2
  local identity

  while IFS= read -r identity; do
    if [[ $identity == *$fingerprint* && $identity == *'"Apple Distribution:'* ]]; then
      return 0
    fi
  done <<< "$inventory"
  return 1
}
