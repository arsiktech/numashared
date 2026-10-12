#!/bin/zsh

set -euo pipefail
umask 077

source_root=${0:A:h:h:h}
guard_source="$source_root/scripts/convex-local.sh"
e2e_env_source="$source_root/scripts/local-e2e-env.mjs"
temp_root=$(mktemp -d /tmp/NumaShared-convex-local-test.XXXXXX)
temp_root=${temp_root:A}
server_pid=''
cleanup() {
  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid"
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf -- "$temp_root"
}
trap cleanup EXIT

repo="$temp_root/repo"
guard="$repo/scripts/convex-local.sh"
config="$repo/.convex/local/default/config.json"
mkdir -p "$repo/scripts" "$repo/.convex/local/default"
cp "$guard_source" "$guard"
cp "$e2e_env_source" "$repo/scripts/local-e2e-env.mjs"
chmod +x "$guard"

cat > "$config" <<'EOF'
{
  "deploymentName": "anonymous-contract",
  "cloudProjectId": null,
  "ports": { "cloud": 3210, "site": 3211 }
}
EOF

output=$(
  cd "$repo"
  "$guard" preflight
)
if [[ "$output" != 'anonymous-local Convex preflight passed: deployment=anonymous-contract url=http://127.0.0.1:3210' ]]; then
  print -u2 "Unexpected preflight receipt: $output"
  exit 1
fi

expect_failure() {
  local label=$1
  local expected=$2
  shift 2
  local output_file="$temp_root/${label}.out"
  if "$@" > "$output_file" 2>&1; then
    print -u2 "$label unexpectedly passed"
    exit 1
  fi
  if [[ "$(<"$output_file")" != *"$expected"* ]]; then
    print -u2 "$label did not report the expected failure"
    print -u2 -r -- "$(<"$output_file")"
    exit 1
  fi
}

chmod 644 "$config"
expect_failure config-mode 'must be owner-only' "$guard" preflight
chmod 600 "$config"

cat > "$config" <<'EOF'
{
  "deploymentName": "anonymous-cloud-linked",
  "cloudProjectId": 42,
  "ports": { "cloud": 3210, "site": 3211 }
}
EOF
expect_failure cloud-config 'cloudProjectId must be null or absent' \
  "$guard" preflight

cat > "$config" <<'EOF'
{
  "deploymentName": "main-numa",
  "cloudProjectId": null,
  "ports": { "cloud": 3210, "site": 3211 }
}
EOF
expect_failure main-config 'deploymentName must match anonymous-*' \
  "$guard" preflight

cat > "$config" <<'EOF'
{
  "ports": { "cloud": 3210, "site": 3211 }
}
EOF
expect_failure unknown-config 'deploymentName must match anonymous-*' \
  "$guard" preflight

cat > "$config" <<'EOF'
{
  "deploymentName": "anonymous-without-cloud-id",
  "ports": { "cloud": 3210, "site": 3211 }
}
EOF
"$guard" preflight > /dev/null

endpoint_root="$temp_root/endpoint"
port_file="$temp_root/endpoint.port"
mkdir -p "$endpoint_root"
print -n 'anonymous-live' > "$endpoint_root/instance_name"
/usr/bin/python3 -u - "$endpoint_root" "$port_file" > /dev/null 2>&1 <<'PY' &
import functools
import http.server
import pathlib
import sys

root = sys.argv[1]
port_file = pathlib.Path(sys.argv[2])
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=root)
server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
port_file.write_text(str(server.server_port), encoding="utf-8")
server.serve_forever()
PY
server_pid=$!

for _ in {1..100}; do
  [[ -s "$port_file" ]] && break
  if ! kill -0 "$server_pid" 2>/dev/null; then
    print -u2 'Loopback endpoint stub exited before becoming ready'
    exit 1
  fi
  sleep 0.02
done
if [[ ! -s "$port_file" ]]; then
  print -u2 'Loopback endpoint stub did not become ready'
  exit 1
fi
port=$(<"$port_file")
site_port=$(( port == 65535 ? port - 1 : port + 1 ))
url="http://127.0.0.1:$port"

cat > "$config" <<EOF
{
  "deploymentName": "anonymous-live",
  "cloudProjectId": null,
  "ports": { "cloud": $port, "site": $site_port }
}
EOF

if [[ "$("$guard" url)" != "$url" ]]; then
  print -u2 'URL command did not return the config-derived loopback URL'
  exit 1
fi
if [[ "$("$guard" name)" != 'anonymous-live' ]]; then
  print -u2 'Name command did not return the asserted anonymous deployment'
  exit 1
fi
if [[ "$("$guard" site-url)" != "http://127.0.0.1:$site_port" ]]; then
  print -u2 'Site URL command did not return the config-derived loopback URL'
  exit 1
fi
live_output=$("$guard" assert "$url")
if [[ "$live_output" != "anonymous-local Convex live assertion passed: deployment=anonymous-live url=$url" ]]; then
  print -u2 "Unexpected live assertion receipt: $live_output"
  exit 1
fi

expect_failure url-mismatch 'URL must equal the config-derived loopback URL' \
  "$guard" assert 'https://convex.example.invalid'

print -n 'anonymous-other' > "$endpoint_root/instance_name"
expect_failure instance-mismatch 'Local Convex instance mismatch' \
  "$guard" assert "$url"

mkdir -p "$repo/node_modules/.bin" "$temp_root/bin"
cat > "$repo/.env.local" <<'EOF'
CONVEX_DEPLOYMENT=prod:main-numa-sentinel
CONVEX_DEPLOY_KEY=cloud-file-sentinel
EOF
stub_log="$temp_root/convex-stub.log"
start_marker="$temp_root/start-marker"
cat > "$repo/node_modules/.bin/convex" <<'EOF'
#!/bin/zsh
set -euo pipefail

for variable_name in \
  CONVEX_DEPLOY_KEY \
  CONVEX_DEPLOYMENT_TOKEN \
  CONVEX_SELF_HOSTED_URL \
  CONVEX_SELF_HOSTED_ADMIN_KEY \
  CONVEX_OVERRIDE_ACCESS_TOKEN \
  CONVEX_PROVISION_HOST; do
  if [[ -n "${(P)variable_name}" ]]; then
    print -u2 "unsafe Convex override reached pinned CLI: $variable_name"
    exit 90
  fi
done
if [[ "${CONVEX_AGENT_MODE:-}" != 'anonymous' || "${CONVEX_ALLOW_ANONYMOUS:-}" != 'true' ]]; then
  print -u2 'anonymous Convex process guard was not set'
  exit 90
fi

case "${1:-}" in
  codegen)
    [[ "${CONVEX_DEPLOYMENT:-}" == 'anonymous:anonymous-live' ]] || exit 91
    [[ "$*" == 'codegen --typecheck enable' ]] || exit 91
    print 'command=codegen selection=anonymous-local overrides=blank' > "$NUMA_CONVEX_STUB_LOG"
    ;;
  env)
    [[ "${CONVEX_DEPLOYMENT:-}" == 'anonymous:anonymous-live' ]] || exit 91
    [[ "${2:-}" == 'set' && "${3:-}" == '--from-file' ]] || exit 91
    [[ -f "${4:-}" && "${5:-}" == '--force' ]] || exit 91
    [[ "$(<"$4")" != *'CONVEX_DEPLOYMENT'* ]] || exit 91
    print 'command=env-set selection=anonymous-local overrides=blank' > "$NUMA_CONVEX_STUB_LOG"
    ;;
  dev)
    [[ -z "${CONVEX_DEPLOYMENT:-}" ]] || exit 92
    args=("$@")
    env_file=''
    start_command=''
    for (( index = 1; index <= $#; index++ )); do
      if [[ "${args[$index]}" == '--env-file' ]]; then
        env_file=${args[$(( index + 1 ))]}
      elif [[ "${args[$index]}" == '--start' ]]; then
        start_command=${args[$(( index + 1 ))]}
      fi
    done
    [[ -n "$env_file" && -f "$env_file" ]] || exit 92
    [[ "$(<"$env_file")" == 'CONVEX_DEPLOYMENT=anonymous:anonymous-live' ]] || exit 92
    [[ " $* " == *' --once '* ]] || exit 92
    [[ " $* " == *' --typecheck enable '* ]] || exit 92
    [[ " $* " == *' --codegen enable '* ]] || exit 92
    [[ " $* " == *' --tail-logs disable '* ]] || exit 92
    [[ -n "$start_command" ]] || exit 92
    print 'command=dev selection=anonymous-local overrides=blank ready-guard=present' > "$NUMA_CONVEX_STUB_LOG"
    /bin/zsh -c "$start_command"
    ;;
  *)
    exit 93
    ;;
esac
EOF
chmod +x "$repo/node_modules/.bin/convex"

cat > "$temp_root/bin/npx" <<'EOF'
#!/bin/zsh
print -u2 'npx must not be invoked'
exit 99
EOF
chmod +x "$temp_root/bin/npx"

assert_launcher_rejects_before_cli() {
  local label=$1
  local expected=$2
  rm -f "$stub_log"
  expect_failure "$label" "$expected" env \
    NUMA_CONVEX_STUB_LOG="$stub_log" \
    PATH="$temp_root/bin:$PATH" \
    "$guard" dev --start '/usr/bin/true'
  if [[ -e "$stub_log" ]]; then
    print -u2 "$label reached the pinned CLI before rejecting its target"
    exit 1
  fi
}

cat > "$config" <<EOF
{
  "deploymentName": "anonymous-cloud-linked",
  "cloudProjectId": 42,
  "ports": { "cloud": $port, "site": $site_port }
}
EOF
assert_launcher_rejects_before_cli launcher-cloud 'cloudProjectId must be null or absent'

cat > "$config" <<EOF
{
  "deploymentName": "main-numa",
  "cloudProjectId": null,
  "ports": { "cloud": $port, "site": $site_port }
}
EOF
assert_launcher_rejects_before_cli launcher-main 'deploymentName must match anonymous-*'

cat > "$config" <<EOF
{
  "deploymentName": "local-unknown",
  "ports": { "cloud": $port, "site": $site_port }
}
EOF
assert_launcher_rejects_before_cli launcher-unknown 'deploymentName must match anonymous-*'

cat > "$config" <<EOF
{
  "deploymentName": "anonymous-live",
  "cloudProjectId": null,
  "ports": { "cloud": $port, "site": $site_port }
}
EOF
print -n 'anonymous-live' > "$endpoint_root/instance_name"
rm -f "$stub_log" "$start_marker"
if env \
  NUMA_CONVEX_STUB_LOG="$stub_log" \
  CONVEX_DEPLOYMENT='prod:main-sentinel' \
  CONVEX_DEPLOY_KEY='cloud-sentinel' \
  CONVEX_DEPLOYMENT_TOKEN='token-sentinel' \
  CONVEX_SELF_HOSTED_URL='https://self-hosted.example.invalid' \
  CONVEX_SELF_HOSTED_ADMIN_KEY='self-hosted-sentinel' \
  CONVEX_OVERRIDE_ACCESS_TOKEN='access-sentinel' \
  CONVEX_PROVISION_HOST='https://provision.example.invalid' \
  PATH="$temp_root/bin:$PATH" \
  "$guard" dev --start "/usr/bin/touch ${(q)start_marker}" \
  > "$temp_root/dev.out" 2>&1; then
  :
else
  print -u2 'Guarded dev launcher failed unexpectedly'
  print -u2 -r -- "$(<"$temp_root/dev.out")"
  exit 1
fi
if [[ ! -e "$start_marker" ]]; then
  print -u2 'Guarded dev launcher did not run its child after the live assertion'
  exit 1
fi
if [[ "$(<"$stub_log")" != 'command=dev selection=anonymous-local overrides=blank ready-guard=present' ]]; then
  print -u2 'Guarded dev launcher did not preserve the pinned safe contract'
  exit 1
fi
if [[ "$(<"$temp_root/dev.out")" == *'sentinel'* ]]; then
  print -u2 'Guarded dev launcher leaked a scrubbed override'
  exit 1
fi

if env \
  NUMA_CONVEX_STUB_LOG="$stub_log" \
  PATH="$temp_root/bin:$PATH" \
  "$guard" dev --start '/usr/bin/false' \
  > "$temp_root/dev-child-failure.out" 2>&1; then
  print -u2 'Guarded dev launcher hid a failing child exit'
  exit 1
fi

print -n 'anonymous-other' > "$endpoint_root/instance_name"
blocked_marker="$temp_root/blocked-start-marker"
expect_failure launcher-instance-mismatch 'Local Convex instance mismatch' env \
  NUMA_CONVEX_STUB_LOG="$stub_log" \
  PATH="$temp_root/bin:$PATH" \
  "$guard" dev --start "/usr/bin/touch ${(q)blocked_marker}"
if [[ -e "$blocked_marker" ]]; then
  print -u2 'Guarded dev launcher ran its child after instance mismatch'
  exit 1
fi
print -n 'anonymous-live' > "$endpoint_root/instance_name"

rm -f "$stub_log"
env \
  NUMA_CONVEX_STUB_LOG="$stub_log" \
  CONVEX_DEPLOYMENT='prod:main-sentinel' \
  CONVEX_DEPLOY_KEY='cloud-sentinel' \
  CONVEX_DEPLOYMENT_TOKEN='token-sentinel' \
  CONVEX_SELF_HOSTED_URL='https://self-hosted.example.invalid' \
  CONVEX_SELF_HOSTED_ADMIN_KEY='self-hosted-sentinel' \
  CONVEX_OVERRIDE_ACCESS_TOKEN='access-sentinel' \
  CONVEX_PROVISION_HOST='https://provision.example.invalid' \
  PATH="$temp_root/bin:$PATH" \
  "$guard" codegen
if [[ "$(<"$stub_log")" != 'command=codegen selection=anonymous-local overrides=blank' ]]; then
  print -u2 'Guarded codegen launcher did not use the pinned safe contract'
  exit 1
fi

runtime_env="$temp_root/runtime.env"
process_env="$temp_root/process.zsh"
node "$repo/scripts/local-e2e-env.mjs" generate \
  "$process_env" "$runtime_env" anonymous-live
rm -f "$stub_log"
env \
  NUMA_CONVEX_STUB_LOG="$stub_log" \
  CONVEX_DEPLOYMENT='prod:main-sentinel' \
  CONVEX_DEPLOY_KEY='cloud-sentinel' \
  PATH="$temp_root/bin:$PATH" \
  "$guard" env-bootstrap-local "$runtime_env"
if [[ "$(<"$stub_log")" != 'command=env-set selection=anonymous-local overrides=blank' ]]; then
  print -u2 'Guarded local env bootstrap did not preserve the pinned safe contract'
  exit 1
fi
rm -f "$stub_log"
env \
  NUMA_CONVEX_STUB_LOG="$stub_log" \
  CONVEX_DEPLOYMENT='prod:main-sentinel' \
  CONVEX_DEPLOY_KEY='cloud-sentinel' \
  PATH="$temp_root/bin:$PATH" \
  "$guard" env-set-local "$runtime_env"
if [[ "$(<"$stub_log")" != 'command=env-set selection=anonymous-local overrides=blank' ]]; then
  print -u2 'Guarded local env installer did not preserve the pinned safe contract'
  exit 1
fi

chmod 644 "$runtime_env"
rm -f "$stub_log"
expect_failure env-mode 'must be owner-only' env \
  NUMA_CONVEX_STUB_LOG="$stub_log" \
  PATH="$temp_root/bin:$PATH" \
  "$guard" env-set-local "$runtime_env"
if [[ -e "$stub_log" ]]; then
  print -u2 'Unsafe local env reached the pinned CLI'
  exit 1
fi

print 'convex local guard contract test passed: fail-closed target, URL, instance, dev, codegen, and env guards'
