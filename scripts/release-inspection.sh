#!/bin/zsh

extract_ipa_app() {
  local ipa=$1
  local destination=$2
  local apps

  [[ -f $ipa && -d $destination ]] || return 1
  /usr/bin/ditto -x -k "$ipa" "$destination" || return 1
  apps=("$destination"/Payload/*.app(N))
  (( ${#apps} == 1 )) || return 1
  print -r -- "$apps[1]"
}

decode_signed_entitlements() {
  local app=$1
  local output=$2
  local codesign_bin=${CODESIGN_BIN:-/usr/bin/codesign}

  "$codesign_bin" -d --entitlements :- "$app" > "$output" 2>/dev/null
}

verify_code_signature() {
  local app=$1
  local codesign_bin=${CODESIGN_BIN:-/usr/bin/codesign}

  "$codesign_bin" --verify --deep --strict --verbose=2 "$app" >/dev/null 2>&1
}

describe_code_signature() {
  local app=$1
  local output=$2
  local codesign_bin=${CODESIGN_BIN:-/usr/bin/codesign}

  "$codesign_bin" -d --verbose=4 "$app" > "$output" 2>&1
}

verify_app_runtime_dependencies() {
  local app=$1
  local otool_bin=${OTOOL_BIN:-/usr/bin/otool}
  local info="$app/Info.plist"
  local executable
  local framework
  local framework_executable
  local binary
  local dependency
  local dependency_output
  local resolved
  local bundled_count=0
  local binaries

  [[ -d $app && -f $info ]] || return 1
  executable=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$info" 2>/dev/null) \
    || return 1
  [[ -f "$app/$executable" ]] || return 1
  binaries=("$app/$executable")

  for framework in "$app"/Frameworks/*.framework(N); do
    framework_executable=$(/usr/libexec/PlistBuddy \
      -c 'Print :CFBundleExecutable' "$framework/Info.plist" 2>/dev/null) \
      || return 1
    [[ -f "$framework/$framework_executable" ]] || return 1
    binaries+=("$framework/$framework_executable")
  done
  binaries+=("$app"/Frameworks/*.dylib(N))

  for binary in $binaries; do
    dependency_output=$("$otool_bin" -L "$binary") || {
      print -u2 "Runtime dependency inspection failed: ${binary:t}"
      return 1
    }
    [[ ${dependency_output%%$'\n'*} == "$binary:" ]] || {
      print -u2 "Runtime dependency inspection malformed: ${binary:t}"
      return 1
    }
    dependency_output=$(/usr/bin/sed -n \
      '2,$s/^[[:space:]]*\([^[:space:]]*\).*/\1/p' \
      <<< "$dependency_output") || {
      print -u2 "Runtime dependency parsing failed: ${binary:t}"
      return 1
    }
    for dependency in "${(@f)dependency_output}"; do
      case $dependency in
        @rpath/*)
          resolved="$app/Frameworks/${dependency#@rpath/}"
          ;;
        @executable_path/*)
          resolved="$app/${dependency#@executable_path/}"
          ;;
        @loader_path/*)
          resolved="${binary:h}/${dependency#@loader_path/}"
          ;;
        /System/*|/usr/lib/*)
          continue
          ;;
        *)
          print -u2 "Unsupported runtime dependency: ${binary:t} -> $dependency"
          return 1
          ;;
      esac
      [[ -f $resolved ]] || {
        print -u2 "Runtime dependency missing: ${binary:t} -> $dependency"
        return 1
      }
      (( bundled_count += 1 ))
    done
  done

  print "Runtime dependency closure passed: binaries=${#binaries} bundled=$bundled_count"
}

release_qa_markers() {
  print -r -- '--qa-home'
  print -r -- '--qa-seeded-home'
  print -r -- '--qa-long-balance-layout'
  print -r -- '--numa-shared-e2e'
  print -r -- 'NUMA_SHARED_E2E'
  print -r -- 'NUMA_SHARED_E2E_DIAGNOSTIC_V1'
  print -r -- 'auth/e2e/bootstrap'
  print -r -- 'ledger-e2e-'
  print -r -- 'p2-single-account-'
  print -r -- 'p3-two-account-'
  print -r -- "Skip ahead — load July's six records"
  print -r -- 'Pharmacy — for Leo'
  print -r -- 'Sam paid your household'
  print -r -- 'Leo paid your household'
}

scan_release_qa_markers() {
  local app=$1
  local marker
  local rg_status
  local count=0

  [[ -d $app ]] || return 1
  while IFS= read -r marker; do
    if rg -a -F --quiet -- "$marker" "$app"; then
      print -u2 "Release QA marker present: $marker"
      return 1
    else
      rg_status=$?
      if (( rg_status != 1 )); then
        print -u2 "Release QA scan failed for '$marker' with rg exit $rg_status"
        return "$rg_status"
      fi
    fi
    (( count += 1 ))
    print "Release QA marker absent: $marker"
  done < <(release_qa_markers)
  print "Release QA scan passed: $count markers absent"
}

archive_manifest_sha256() {
  local archive=$1

  [[ -d $archive ]] || return 1
  (
    local mode
    cd "$archive"
    /usr/bin/find . \( -type d -o -type f -o -type l \) -print \
      | LC_ALL=C /usr/bin/sort \
      | while IFS= read -r entry; do
          mode=$(/usr/bin/stat -f '%Lp' "$entry") || exit 1
          if [[ -L $entry ]]; then
            print -r -- "link $mode $(/usr/bin/readlink "$entry") $entry"
          elif [[ -d $entry ]]; then
            print -r -- "dir $mode $entry"
          else
            print -r -- "file $mode $(/usr/bin/shasum -a 256 "$entry" | /usr/bin/cut -d' ' -f1) $entry"
          fi
        done
  ) | /usr/bin/shasum -a 256 | /usr/bin/cut -d' ' -f1
}

candidate_upload_approval_token() {
  local output=$1
  local source_commit=$2
  local version=$3
  local build=$4
  local archive="$output/NumaShared.xcarchive"
  local ipa=("$output"/export/*.ipa(N))
  local archive_hash
  local ipa_hash

  (( ${#ipa} == 1 )) || return 1
  archive_hash=$(archive_manifest_sha256 "$archive") || return 1
  ipa_hash=$(/usr/bin/shasum -a 256 "$ipa[1]" | /usr/bin/cut -d' ' -f1) || return 1
  [[ ${#archive_hash} == 64 && $archive_hash != *[^0-9a-f]* ]] || return 1
  [[ ${#ipa_hash} == 64 && $ipa_hash != *[^0-9a-f]* ]] || return 1
  print -r -- "$source_commit:$version:$build:$archive_hash:$ipa_hash"
}

require_candidate_upload_approval() {
  local output=$1
  local source_commit=$2
  local version=$3
  local build=$4
  local expected

  expected=$(candidate_upload_approval_token "$output" "$source_commit" "$version" "$build") \
    || return 66
  [[ ${NUMA_ASC_UPLOAD_APPROVED:-} == $expected ]] || {
    print -u2 "Upload blocked: set NUMA_ASC_UPLOAD_APPROVED=$expected only after exact operator approval"
    return 65
  }
}
