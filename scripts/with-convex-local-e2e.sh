#!/bin/zsh

set -euo pipefail
umask 077

if (( $# != 1 )) || [[ -z "$1" ]]; then
  print -u2 'Usage: with-convex-local-e2e.sh <child-command>'
  exit 64
fi

script_path=${0:A}
repo_root=${script_path:h:h}
child_command=$1
operator_config="$repo_root/.convex/local/default/config.json"
"$repo_root/scripts/convex-toolchain-check.sh"
if [[ ! -f "$operator_config" || -L "$operator_config" ]]; then
  print -u2 'Pinned anonymous local backend config is missing or unsafe'
  exit 66
fi
operator_config_mode=$(/usr/bin/stat -f '%Lp' "$operator_config")
if [[ "$operator_config_mode" != '600' && "$operator_config_mode" != '400' ]]; then
  print -u2 'Pinned anonymous local backend config must be owner-only'
  exit 66
fi
backend_version=$(node --input-type=module - \
  "$repo_root/scripts/convex-toolchain.json" \
  "$repo_root/.convex/local/default/config.json" <<'NODE'
import { readFileSync } from "node:fs";
const pin = JSON.parse(readFileSync(process.argv[2], "utf8"));
const operator = JSON.parse(readFileSync(process.argv[3], "utf8"));
if (typeof pin.backendVersion !== "string" || pin.backendVersion.length === 0) {
  process.stderr.write("Tracked anonymous local backend version is missing\n");
  process.exit(66);
}
if (operator.backendVersion !== pin.backendVersion) {
  process.stderr.write("Operator anonymous backend does not match the tracked version\n");
  process.exit(66);
}
process.stdout.write(pin.backendVersion);
NODE
)
temp_root=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/NumaShared-local-e2e.XXXXXX")
temp_root=${temp_root:A}
run_suffix="$(/bin/date +%s)-$$-$RANDOM"
ephemeral_project="$temp_root/numa-e2e-$run_suffix"
ephemeral_home="$temp_root/home"

cleanup() {
  /bin/rm -rf -- "$temp_root"
}
trap cleanup EXIT

# Convex's anonymous backend normally persists under the current project's
# `.convex/local/default`. A deterministic gate must inherit neither credentials,
# ports, deployment identity, nor data from an operator instance. The pinned CLI
# creates a new anonymous deployment with fresh credentials and available ports
# inside this owner-only temporary project; all state disappears at cleanup.
/bin/mkdir -p \
  "$ephemeral_home/.cache/convex" \
  "$ephemeral_project/NumaSharedCore/Tests/NumaSharedCoreTests" \
  "$ephemeral_project/ios/NumaShared/NumaSharedTests"
if [[ ! -d "$HOME/.cache/convex/binaries" ]]; then
  print -u2 'Verified Convex backend cache is missing'
  exit 66
fi
# Agent mode intentionally uses the fixed deployment name `anonymous-agent`.
# A temporary HOME prevents the CLI from resolving that name through an
# operator's legacy ~/.convex state. Only the already-verified backend binary
# cache is shared read-only by path; deployment identity and data stay under
# this run's owner-only temporary root.
/bin/ln -s "$HOME/.cache/convex/binaries" \
  "$ephemeral_home/.cache/convex/binaries"
backend_binary="$ephemeral_home/.cache/convex/binaries/$backend_version/convex-local-backend"
if [[ ! -x "$backend_binary" || -L "$backend_binary" ]]; then
  print -u2 'Verified Convex backend executable is missing or unsafe'
  exit 66
fi
deployment_name='anonymous-agent'
instance_secret=$(node --input-type=module - <<'NODE'
import { randomBytes } from "node:crypto";
process.stdout.write(randomBytes(32).toString("hex"));
NODE
)
admin_key=$(
  "$backend_binary" keygen admin-key \
    --instance-name "$deployment_name" \
    --instance-secret "$instance_secret"
)
if [[ -z "$admin_key" ]]; then
  print -u2 'Pinned Convex backend returned an empty admin key'
  exit 66
fi
ephemeral_config="$ephemeral_project/.convex/local/default/config.json"
/bin/mkdir -p "${ephemeral_config:h}"
node --input-type=module - \
  "$ephemeral_config" "$backend_version" "$deployment_name" \
  "$admin_key" "$instance_secret" <<'NODE'
import { writeFileSync } from "node:fs";

const [path, backendVersion, deploymentName, adminKey, instanceSecret] = process.argv.slice(2);
writeFileSync(path, JSON.stringify({
  backendVersion,
  deploymentName,
  cloudProjectId: null,
  ports: { cloud: 3210, site: 3211 },
  adminKey,
  instanceSecret,
}));
NODE
/bin/chmod 600 "$ephemeral_config"
/bin/cp -R "$repo_root/scripts/fixtures/local-convex-bootstrap/convex" \
  "$ephemeral_project/convex"
/bin/cp -R "$repo_root/NumaSharedCore/Tests/NumaSharedCoreTests/Fixtures" \
  "$ephemeral_project/NumaSharedCore/Tests/NumaSharedCoreTests/Fixtures"
/bin/cp -R "$repo_root/ios/NumaShared/NumaSharedTests/Fixtures" \
  "$ephemeral_project/ios/NumaShared/NumaSharedTests/Fixtures"
/bin/cp "$repo_root/package.json" "$repo_root/package-lock.json" \
  "$ephemeral_project/"
/bin/ln -s "$repo_root/node_modules" "$ephemeral_project/node_modules"
cd "$ephemeral_project"

process_env="$temp_root/process.zsh"
runtime_env="$temp_root/runtime.env"
convex_dev=(
  /usr/bin/env
  HOME="$ephemeral_home"
  CONVEX_AGENT_MODE=anonymous
  CONVEX_ALLOW_ANONYMOUS=true
  CONVEX_DEPLOYMENT=
  CONVEX_DEPLOY_KEY=
  CONVEX_DEPLOYMENT_TOKEN=
  CONVEX_SELF_HOSTED_URL=
  CONVEX_SELF_HOSTED_ADMIN_KEY=
  CONVEX_OVERRIDE_ACCESS_TOKEN=
  CONVEX_PROVISION_HOST=
  "$repo_root/node_modules/.bin/convex" dev
  --once
  --tail-logs disable
  --local-backend-version "$backend_version"
)

"${convex_dev[@]}" --typecheck disable --codegen disable
/usr/bin/env HOME="$ephemeral_home" \
  "$repo_root/scripts/local-e2e-start.sh" configure \
  "$process_env" "$runtime_env" "$operator_config"
/bin/cp -R "$repo_root/convex" "$ephemeral_project/"

child_status_file="$temp_root/child.status"
start_command="${(q)repo_root}/scripts/local-e2e-start.sh run ${(q)process_env} ${(q)runtime_env} ${(q)child_status_file} ${(q)child_command}"
"${convex_dev[@]}" \
    --typecheck enable \
    --codegen enable \
    --start "$start_command"

if [[ ! -f "$child_status_file" || -L "$child_status_file" ]]; then
  print -u2 'Anonymous-local child status receipt is missing or unsafe'
  exit 65
fi
child_status=$(< "$child_status_file")
if [[ ! "$child_status" =~ '^[0-9]+$' ]] || (( child_status < 0 || child_status > 255 )); then
  print -u2 'Anonymous-local child status receipt is invalid'
  exit 65
fi
if (( child_status != 0 )); then
  print -u2 "Anonymous-local child failed with status $child_status"
  exit "$child_status"
fi
