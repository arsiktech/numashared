#!/bin/zsh

set -euo pipefail
umask 077

source_root=${0:A:h:h:h}
temp_root=$(/usr/bin/mktemp -d /tmp/NumaShared-e2e-wrapper-contract.XXXXXX)
trap '/bin/rm -rf -- "$temp_root"' EXIT

repo="$temp_root/repo"
/bin/mkdir -p \
  "$repo/scripts/fixtures/local-convex-bootstrap/convex" \
  "$repo/NumaSharedCore/Tests/NumaSharedCoreTests/Fixtures" \
  "$repo/ios/NumaShared/NumaSharedTests/Fixtures" \
  "$repo/.convex/local/default" \
  "$repo/node_modules/.bin" \
  "$repo/convex"
/bin/cp "$source_root/scripts/with-convex-local-e2e.sh" "$repo/scripts/"
/bin/cp "$source_root/scripts/convex-toolchain.json" "$repo/scripts/"
/bin/cp "$source_root/package.json" "$source_root/package-lock.json" "$repo/"
print 'export const bootstrap = true;' > "$repo/scripts/fixtures/local-convex-bootstrap/convex/bootstrap.ts"
print 'export const real = true;' > "$repo/convex/real.ts"
print '{}' > "$repo/NumaSharedCore/Tests/NumaSharedCoreTests/Fixtures/core.json"
print '{}' > "$repo/ios/NumaShared/NumaSharedTests/Fixtures/ios.json"
cat > "$repo/.convex/local/default/config.json" <<'EOF'
{"backendVersion":"precompiled-2026-07-06-44f7aa7","deploymentName":"anonymous-operator","cloudProjectId":null,"ports":{"cloud":3998,"site":3999}}
EOF
/bin/chmod 600 "$repo/.convex/local/default/config.json"

cat > "$repo/scripts/convex-toolchain-check.sh" <<'EOF'
#!/bin/zsh
print 'toolchain-checked' >> "$NUMA_WRAPPER_LOG"
EOF
cat > "$repo/scripts/local-e2e-start.sh" <<'EOF'
#!/bin/zsh
set -euo pipefail
case "$1" in
  configure)
    print 'export NUMA_WRAPPER_CONFIGURED=1' > "$2"
    print 'SAFE=1' > "$3"
    ;;
  run)
    /bin/zsh -c "$5"
    child_status=$?
    print -r -- "$child_status" > "$4"
    exit "$child_status"
    ;;
  *) exit 64 ;;
esac
EOF
/bin/chmod +x \
  "$repo/scripts/with-convex-local-e2e.sh" \
  "$repo/scripts/convex-toolchain-check.sh" \
  "$repo/scripts/local-e2e-start.sh"

cat > "$repo/node_modules/.bin/convex" <<'EOF'
#!/bin/zsh
set -euo pipefail
[[ -t 0 ]] || { print -u2 'hostile pseudo-TTY was not preserved'; exit 90; }
[[ "${CONVEX_AGENT_MODE:-}" == anonymous ]] || { print -u2 'agent mode was not forced anonymous'; exit 90; }
[[ "${CONVEX_ALLOW_ANONYMOUS:-}" == true ]] || exit 90
[[ "${CONVEX_ACCESS_TOKEN:-}" == hostile-logged-in-token ]] || exit 90
[[ "$HOME" != "$NUMA_HOSTILE_HOME" ]] || { print -u2 'operator HOME was inherited'; exit 90; }
[[ "$HOME" == *'/NumaShared-local-e2e.'*'/home' ]] || { print -u2 'HOME was not run-scoped'; exit 90; }
for variable_name in CONVEX_DEPLOYMENT CONVEX_DEPLOY_KEY CONVEX_DEPLOYMENT_TOKEN CONVEX_SELF_HOSTED_URL CONVEX_SELF_HOSTED_ADMIN_KEY CONVEX_OVERRIDE_ACCESS_TOKEN CONVEX_PROVISION_HOST; do
  [[ -z "${(P)variable_name}" ]] || { print -u2 "unsafe override: $variable_name"; exit 90; }
done
print 'cli anonymous tty account-ignored' >> "$NUMA_WRAPPER_LOG"
[[ -f .convex/local/default/config.json ]] || {
  print -u2 'run-scoped Convex config was not seeded before CLI startup'
  exit 90
}
node --input-type=module - .convex/local/default/config.json <<'NODE'
import { readFileSync } from "node:fs";
const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (config.backendVersion !== "precompiled-2026-07-06-44f7aa7"
    || config.deploymentName !== "anonymous-agent"
    || config.cloudProjectId !== null
    || config.adminKey !== "fresh-admin"
    || !/^[a-f0-9]{64}$/u.test(config.instanceSecret)) {
  process.stderr.write("run-scoped Convex config is not pinned and fresh\n");
  process.exit(90);
}
NODE
args=("$@")
for (( index = 1; index <= $#; index++ )); do
  if [[ "${args[$index]}" == '--start' ]]; then
    /bin/zsh -c "${args[$(( index + 1 ))]}"
  fi
done
EOF
/bin/chmod +x "$repo/node_modules/.bin/convex"

wrapper_log="$temp_root/wrapper.log"
/bin/mkdir -p \
  "$temp_root/hostile-home/.cache/convex/binaries/precompiled-2026-07-06-44f7aa7"
cat > "$temp_root/hostile-home/.cache/convex/binaries/precompiled-2026-07-06-44f7aa7/convex-local-backend" <<'EOF'
#!/bin/zsh
set -euo pipefail
[[ "${1:-}" == keygen && "${2:-}" == admin-key \
  && "${3:-}" == --instance-name && "${4:-}" == anonymous-agent \
  && "${5:-}" == --instance-secret && "${6:-}" =~ '^[a-f0-9]{64}$' ]] || exit 93
print 'pinned backend generated fresh credentials' >> "$NUMA_WRAPPER_LOG"
print -n 'fresh-admin'
EOF
/bin/chmod +x \
  "$temp_root/hostile-home/.cache/convex/binaries/precompiled-2026-07-06-44f7aa7/convex-local-backend"
/usr/bin/script -q /dev/null /usr/bin/env \
  NUMA_WRAPPER_LOG="$wrapper_log" \
  NUMA_HOSTILE_HOME="$temp_root/hostile-home" \
  HOME="$temp_root/hostile-home" \
  CONVEX_ACCESS_TOKEN='hostile-logged-in-token' \
  CONVEX_DEPLOYMENT='prod:main-numa-sentinel' \
  CONVEX_DEPLOY_KEY='cloud-sentinel' \
  CONVEX_PROVISION_HOST='https://provision.example.invalid' \
  "$repo/scripts/with-convex-local-e2e.sh" '/usr/bin/true' \
  > "$temp_root/wrapper.out"

[[ "$(rg -c '^cli anonymous tty account-ignored$' "$wrapper_log")" == 2 ]]
[[ "$(rg -c '^pinned backend generated fresh credentials$' "$wrapper_log")" == 1 ]]
[[ "$(rg -c '^toolchain-checked$' "$wrapper_log")" == 1 ]]
if rg -F --quiet 'project' "$wrapper_log"; then
  print -u2 'Hostile wrapper contract entered a project path'
  exit 1
fi

identity_repo="$temp_root/identity-repo"
/bin/mkdir -p \
  "$identity_repo/.convex/local/default" \
  "$identity_repo/scripts" \
  "$identity_repo/node_modules/.bin"
/bin/cp "$source_root/scripts/local-e2e-start.sh" \
  "$source_root/scripts/local-e2e-env.mjs" \
  "$identity_repo/scripts/"
cat > "$identity_repo/node_modules/.bin/convex" <<'EOF'
#!/bin/zsh
[[ "$*" == env\ set\ --from-file\ *\ --force ]] || exit 92
EOF
/bin/chmod +x "$identity_repo/node_modules/.bin/convex"
operator_identity="$temp_root/operator-identity.json"
cat > "$operator_identity" <<'EOF'
{"deploymentName":"anonymous-agent","adminKey":"operator-admin","instanceSecret":"operator-secret"}
EOF
/bin/chmod 600 "$operator_identity"
cat > "$identity_repo/.convex/local/default/config.json" <<'EOF'
{"deploymentName":"anonymous-agent","adminKey":"fresh-admin","instanceSecret":"fresh-secret","cloudProjectId":null,"ports":{"cloud":3210,"site":3211}}
EOF
/bin/chmod 600 "$identity_repo/.convex/local/default/config.json"
(
  cd "$identity_repo"
  ./scripts/local-e2e-start.sh configure \
    "$temp_root/identity-process.zsh" \
    "$temp_root/identity-runtime.env" \
    "$operator_identity"
)

cat > "$identity_repo/.convex/local/default/config.json" <<'EOF'
{"deploymentName":"anonymous-agent","adminKey":"operator-admin","instanceSecret":"fresh-secret","cloudProjectId":null,"ports":{"cloud":3210,"site":3211}}
EOF
if (
  cd "$identity_repo"
  ./scripts/local-e2e-start.sh configure \
    "$temp_root/reused-process.zsh" \
    "$temp_root/reused-runtime.env" \
    "$operator_identity"
) > "$temp_root/reused-identity.out" 2>&1; then
  print -u2 'Anonymous wrapper accepted reused operator credentials'
  exit 1
fi
if [[ "$(<"$temp_root/reused-identity.out")" != *'credentials reused operator state'* ]]; then
  print -u2 'Credential-reuse guard did not report the expected failure'
  exit 1
fi
print 'convex E2E wrapper contract PASS: forced anonymous under logged-in pseudo-TTY'
