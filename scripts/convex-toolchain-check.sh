#!/bin/zsh

set -euo pipefail

repo_root=${0:A:h:h}
pin_path="$repo_root/scripts/convex-toolchain.json"
backend_version=$(node --input-type=module - "$pin_path" <<'NODE'
import { readFileSync } from "node:fs";
const pin = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (typeof pin.backendVersion !== "string" || pin.backendVersion.length === 0) {
  throw new Error("Tracked Convex backend version is missing");
}
process.stdout.write(pin.backendVersion);
NODE
)
backend_root=${XDG_CACHE_HOME:-$HOME/.cache}
backend_path="$backend_root/convex/binaries/$backend_version/convex-local-backend"

node "$repo_root/scripts/convex-toolchain-verify.mjs" \
  "$pin_path" \
  "$repo_root/package.json" \
  "$repo_root/package-lock.json" \
  "$repo_root/node_modules/convex/package.json" \
  "$repo_root/node_modules/.bin/convex" \
  "$backend_path"
