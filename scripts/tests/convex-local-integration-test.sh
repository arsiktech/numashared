#!/bin/zsh

set -euo pipefail

script_path=${0:A}
repo_root=${script_path:h:h:h}

"$repo_root/scripts/with-convex-local-e2e.sh" \
  "node ${(q)repo_root}/scripts/local-e2e-smoke.mjs"
