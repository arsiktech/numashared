#!/bin/zsh

set -euo pipefail

if (( $# < 3 || $# > 5 )); then
  print -u2 'Usage: local-e2e-start.sh configure <process-env-file> <runtime-env-file> <operator-config> | run <process-env-file> <runtime-env-file> <status-file> <child-command>'
  exit 64
fi

script_path=${0:A}
repo_root=${script_path:h:h}
mode=$1
process_env=$2
runtime_env=$3
config_path="$PWD/.convex/local/default/config.json"

if [[ ! -f "$config_path" || -L "$config_path" ]]; then
  print -u2 'Fresh anonymous local Convex config was not created'
  exit 66
fi
config_mode=$(/usr/bin/stat -f '%Lp' "$config_path")
if [[ "$config_mode" != '600' && "$config_mode" != '400' ]]; then
  print -u2 'Fresh anonymous local Convex config is not owner-only'
  exit 66
fi
parsed=$(node --input-type=module - "$config_path" <<'NODE'
import { readFileSync } from "node:fs";
const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const name = config.deploymentName;
const cloud = config.ports?.cloud;
const site = config.ports?.site;
const cloudProjectId = config.cloudProjectId;
if (!/^anonymous-[a-z0-9][a-z0-9-]*$/u.test(name ?? "")
    || (cloudProjectId !== undefined && cloudProjectId !== null)
    || !Number.isInteger(cloud) || !Number.isInteger(site) || cloud === site) {
  process.stderr.write("Fresh anonymous local Convex config is invalid\n");
  process.exit(66);
}
process.stdout.write(`${name}\t${cloud}\t${site}`);
NODE
)
IFS=$'\t' read -r deployment_name cloud_port site_port <<< "$parsed"
cloud_url="http://127.0.0.1:$cloud_port"
site_url="http://127.0.0.1:$site_port"

case "$mode" in
  configure)
    (( $# == 4 )) || exit 64
    operator_config=$4
    [[ -f "$operator_config" && ! -L "$operator_config" ]] || exit 66
    node --input-type=module - "$config_path" "$operator_config" <<'NODE'
import { readFileSync } from "node:fs";
const fresh = JSON.parse(readFileSync(process.argv[2], "utf8"));
const operator = JSON.parse(readFileSync(process.argv[3], "utf8"));
if (fresh.adminKey === operator.adminKey
    || fresh.instanceSecret === operator.instanceSecret) {
  process.stderr.write("Fresh anonymous local Convex credentials reused operator state\n");
  process.exit(66);
}
if (fresh.deploymentName === operator.deploymentName
    && fresh.deploymentName !== "anonymous-agent") {
  process.stderr.write("Fresh anonymous local Convex name reused operator state\n");
  process.exit(66);
}
NODE
    node "$repo_root/scripts/local-e2e-env.mjs" generate \
      "$process_env" "$runtime_env" "$deployment_name"
    /usr/bin/env \
      CONVEX_AGENT_MODE=anonymous \
      CONVEX_ALLOW_ANONYMOUS=true \
      "CONVEX_DEPLOYMENT=anonymous:$deployment_name" \
      CONVEX_DEPLOY_KEY= \
      CONVEX_DEPLOYMENT_TOKEN= \
      CONVEX_SELF_HOSTED_URL= \
      CONVEX_SELF_HOSTED_ADMIN_KEY= \
      CONVEX_OVERRIDE_ACCESS_TOKEN= \
      CONVEX_PROVISION_HOST= \
      "$repo_root/node_modules/.bin/convex" env set \
        --from-file "$runtime_env" --force
    ;;
  run)
    (( $# == 5 )) || exit 64
    instance_name=$(/usr/bin/curl --silent --show-error --fail --noproxy '*' \
      --proto '=http' --connect-timeout 1 --max-time 2 --max-filesize 256 \
      "$cloud_url/instance_name")
    [[ "$instance_name" == "$deployment_name" ]] || {
      print -u2 'Fresh anonymous local Convex instance identity mismatch'
      exit 65
    }
    source "$process_env"
    export NUMA_SHARED_LOCAL_CLOUD_URL="$cloud_url"
    export NUMA_SHARED_LOCAL_SITE_URL="$site_url"
    set +e
    /bin/zsh -c "$5"
    child_status=$?
    set -e
    print -r -- "$child_status" > "$4"
    exit "$child_status"
    ;;
  *)
    exit 64
    ;;
esac
