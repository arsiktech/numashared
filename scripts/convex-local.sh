#!/bin/zsh

set -euo pipefail

usage() {
  print -u2 'Usage: ./scripts/convex-local.sh preflight|name|url|site-url|ready|assert <url>|dev --start <command>|codegen|env-bootstrap-local <owner-only-env-file>|env-set-local <owner-only-env-file>'
}

script_path=${0:A}
repo_root=${script_path:h:h}
config_path="$repo_root/.convex/local/default/config.json"

load_config() {
  if [[ ! -f "$config_path" || -L "$config_path" ]]; then
    print -u2 "Anonymous local Convex config missing or unsafe: $config_path"
    exit 66
  fi
  local config_mode
  config_mode=$(/usr/bin/stat -f '%Lp' "$config_path")
  if [[ "$config_mode" != '600' && "$config_mode" != '400' ]]; then
    print -u2 "Anonymous local Convex config must be owner-only (0600 or 0400): $config_path"
    exit 66
  fi

  local parsed
  if parsed=$(node --input-type=module - "$config_path" <<'NODE'
import fs from "node:fs";

const path = process.argv[2];
const fail = (reason) => {
  process.stderr.write(`Invalid anonymous local Convex config: ${reason}\n`);
  process.exit(66);
};

let config;
try {
  config = JSON.parse(fs.readFileSync(path, "utf8"));
} catch {
  fail("expected valid JSON");
}

if (config === null || typeof config !== "object" || Array.isArray(config)) {
  fail("expected a JSON object");
}

const deploymentName = config.deploymentName;
if (
  typeof deploymentName !== "string" ||
  !/^anonymous-[a-z0-9][a-z0-9-]*$/.test(deploymentName)
) {
  fail("deploymentName must match anonymous-*");
}

if (
  Object.hasOwn(config, "cloudProjectId") &&
  config.cloudProjectId !== null &&
  config.cloudProjectId !== undefined
) {
  fail("cloudProjectId must be null or absent");
}

const cloudPort = config.ports?.cloud;
const sitePort = config.ports?.site;
const validPort = (value) => Number.isInteger(value) && value >= 1 && value <= 65535;
if (!validPort(cloudPort) || !validPort(sitePort) || cloudPort === sitePort) {
  fail("ports.cloud and ports.site must be distinct TCP ports");
}

process.stdout.write(
  `${deploymentName}\t${cloudPort}\t${sitePort}\thttp://127.0.0.1:${cloudPort}`,
);
NODE
  ); then
    :
  else
    local parse_status=$?
    exit "$parse_status"
  fi

  typeset -g deployment_name cloud_port site_port deployment_url
  IFS=$'\t' read -r deployment_name cloud_port site_port deployment_url <<< "$parsed"
}

assert_live() {
  local candidate_url=$1
  if [[ "$candidate_url" != "$deployment_url" ]]; then
    print -u2 "Convex URL must equal the config-derived loopback URL: $deployment_url"
    exit 65
  fi

  local instance_name
  if instance_name=$(
    /usr/bin/curl \
      --silent \
      --show-error \
      --fail \
      --connect-timeout 1 \
      --max-time 2 \
      --max-filesize 256 \
      --noproxy '*' \
      --proto '=http' \
      "$candidate_url/instance_name"
  ); then
    :
  else
    local curl_status=$?
    print -u2 "Unable to verify anonymous local Convex at $candidate_url"
    exit "$curl_status"
  fi

  if [[ "$instance_name" != "$deployment_name" ]]; then
    print -u2 "Local Convex instance mismatch at $candidate_url"
    exit 65
  fi

  print "anonymous-local Convex live assertion passed: deployment=$deployment_name url=$deployment_url"
}

require_pinned_cli() {
  typeset -g convex_bin="$repo_root/node_modules/.bin/convex"
  if [[ ! -x "$convex_bin" ]]; then
    print -u2 "Pinned Convex CLI missing or not executable: $convex_bin"
    exit 66
  fi

  local resolved_bin=${convex_bin:A}
  if [[ "$resolved_bin" != "$repo_root/node_modules/"* ]]; then
    print -u2 'Pinned Convex CLI resolves outside this repository'
    exit 66
  fi
}

run_scrubbed() {
  /usr/bin/env \
    CONVEX_AGENT_MODE=anonymous \
    CONVEX_ALLOW_ANONYMOUS=true \
    CONVEX_DEPLOYMENT= \
    CONVEX_DEPLOY_KEY= \
    CONVEX_DEPLOYMENT_TOKEN= \
    CONVEX_SELF_HOSTED_URL= \
    CONVEX_SELF_HOSTED_ADMIN_KEY= \
    CONVEX_OVERRIDE_ACCESS_TOKEN= \
    CONVEX_PROVISION_HOST= \
    "$@"
}

run_selected_local() {
  run_scrubbed /usr/bin/env \
    "CONVEX_DEPLOYMENT=anonymous:$deployment_name" \
    "$@"
}

run_dev() {
  local child_command=$1
  local safe_env
  local success_marker
  local old_umask=$(umask)
  umask 077
  safe_env=$(/usr/bin/mktemp "${TMPDIR:-/tmp}/NumaShared-convex-local.XXXXXX")
  success_marker="${safe_env}.child-passed"
  umask "$old_umask"
  print -r -- "CONVEX_DEPLOYMENT=anonymous:$deployment_name" > "$safe_env"

  local ready_command="${(q)script_path} ready"
  local guarded_child="$ready_command && $child_command && /usr/bin/touch ${(q)success_marker}"
  local exit_status
  if run_scrubbed \
    "$convex_bin" dev \
      --env-file "$safe_env" \
      --once \
      --typecheck enable \
      --codegen enable \
      --tail-logs disable \
      --start "$guarded_child"; then
    exit_status=0
  else
    exit_status=$?
  fi
  if (( exit_status == 0 )) && [[ ! -f "$success_marker" ]]; then
    print -u2 'Guarded Convex child did not complete successfully'
    exit_status=1
  fi
  /bin/rm -f -- "$safe_env" "$success_marker"
  return "$exit_status"
}

validate_runtime_env() {
  runtime_env=${1:A}
  if [[ ! -f "$runtime_env" || -L "$runtime_env" ]]; then
    print -u2 "Local runtime env missing or unsafe: $runtime_env"
    exit 66
  fi
  runtime_mode=$(/usr/bin/stat -f '%Lp' "$runtime_env")
  if [[ "$runtime_mode" != '600' && "$runtime_mode" != '400' ]]; then
    print -u2 "Local runtime env must be owner-only (0600 or 0400): $runtime_env"
    exit 66
  fi
  node "$repo_root/scripts/local-e2e-env.mjs" \
    validate-runtime "$runtime_env" "$deployment_name"
}

if (( $# < 1 )); then
  usage
  exit 64
fi

case "$1" in
  preflight)
    (( $# == 1 )) || { usage; exit 64; }
    load_config
    print "anonymous-local Convex preflight passed: deployment=$deployment_name url=$deployment_url"
    ;;
  name)
    (( $# == 1 )) || { usage; exit 64; }
    load_config
    print -r -- "$deployment_name"
    ;;
  url)
    (( $# == 1 )) || { usage; exit 64; }
    load_config
    print -r -- "$deployment_url"
    ;;
  site-url)
    (( $# == 1 )) || { usage; exit 64; }
    load_config
    print -r -- "http://127.0.0.1:$site_port"
    ;;
  ready)
    (( $# == 1 )) || { usage; exit 64; }
    load_config
    assert_live "$deployment_url"
    ;;
  assert)
    (( $# == 2 )) || { usage; exit 64; }
    load_config
    assert_live "$2"
    ;;
  dev)
    if (( $# != 3 )); then
      usage
      exit 64
    fi
    if [[ "$2" != '--start' || -z "$3" ]]; then
      usage
      exit 64
    fi
    load_config
    require_pinned_cli
    run_dev "$3"
    ;;
  codegen)
    (( $# == 1 )) || { usage; exit 64; }
    load_config
    require_pinned_cli
    assert_live "$deployment_url" > /dev/null
    run_selected_local "$convex_bin" codegen --typecheck enable
    ;;
  env-bootstrap-local)
    (( $# == 2 )) || { usage; exit 64; }
    load_config
    require_pinned_cli
    validate_runtime_env "$2"
    run_selected_local "$convex_bin" env set \
      --from-file "$runtime_env" --force
    ;;
  env-set-local)
    (( $# == 2 )) || { usage; exit 64; }
    load_config
    require_pinned_cli
    validate_runtime_env "$2"
    assert_live "$deployment_url" > /dev/null
    run_selected_local "$convex_bin" env set \
      --from-file "$runtime_env" --force
    ;;
  *)
    usage
    exit 64
    ;;
esac
