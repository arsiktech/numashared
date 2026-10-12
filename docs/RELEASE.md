# Numa Shared release procedure

This runbook prepares and delivers one inspected candidate for the audience
requested by the user. Verification details below protect candidate integrity.

## Scope and authorization

Use the user's request and authorization already granted in the conversation.
A request to prepare or deliver a candidate covers the routine local work needed
for that outcome. If it also authorizes upload, a deployment, or a specified
tester audience, carry out those steps without asking for the same permission
again. A reviewer's job title or an old receipt does not create another handoff.

For a consequential operation outside that scope, prepare the candidate/action
first, then ask once for the missing authority. Related external steps may be
approved together with a clear target, audience, and data scope. Account/legal
decisions, credentials, paid services, and real household data require explicit
owner authority. Final App Store submission and public release remain human
actions; a specifically authorized public TestFlight rollout is a distinct beta
operation.

## Candidate inputs

- Xcode 27.0; scheme `NumaShared`; bundle `tech.arsik.numashared`; team `794UJ787LZ`.
- Version/build come from Xcode settings. The build must exceed the read-only
  `ASC_BUILD_FLOOR` printed by `scripts/asc-readonly.mjs`.
- Release requires nonempty HTTPS `NUMA_SHARED_CONVEX_URL`,
  `NUMA_SHARED_SITE_URL`, `NUMA_SHARED_APP_STORE_URL`, and an approved
  `NUMA_SHARED_SUPPORT_EMAIL`. It also requires the exact signed
  `NUMA_SHARED_APP_IDENTIFIER`; never infer its prefix from the Team ID.
- The release URLs are fixed to `https://adept-camel-457.convex.cloud` and
  `https://adept-camel-457.convex.site`. Preflight rejects another Convex
  deployment, custom domain, or merely content-compatible origin.
- Use the recorded export-classification confirmation while its underlying facts
  remain unchanged. The current plist declares no non-exempt encryption. Ask for
  a new determination only if needed; the plist itself is not the legal decision.
- Final app name/icon rights, publishing entity, DSA status, privacy/support
  contacts, production-QA identity/data/cleanup, and updated Apple terms remain
  human interlocks.

## Read-only preflight

Load the release environment file (kept outside the repository) without printing it, export the five
public Release values above, then run:

```bash
./scripts/release-preflight.sh
```

The check verifies clean Git state, the combined ASC processed-build and
build-upload floor, capabilities, icon dimensions/alpha, export options,
version/build, frozen-range whitespace, toolchain, signing inputs, and production public values. It also
requires direct HTTP 200 release-origin responses for the marketing root,
generic private invite landing, privacy, support, AASA, and app-config. AASA
must expose `/join/*` only for the exact application identifier. The preflight
uses GET requests only and changes no Apple, Convex, or repository state. The
approved production smoke separately proves deliberate invite POST because
that endpoint consumes an abuse-control bucket.

## Archive and local export

Using the export-classification confirmation, set
`NUMA_EXPORT_COMPLIANCE_APPROVED=yes` and run:

```bash
./scripts/archive-release.sh /tmp/NumaShared-P5
./scripts/inspect-release.sh /tmp/NumaShared-P5
```

The archive uses the already-installed signing assets. Export is manual and
pins the installed `Numa Shared App Store 2026-07-20` profile because Xcode's
automatic exporter otherwise selects a team-managed profile that does not
contain the installed distribution certificate. It exports with
`method=app-store-connect`, `destination=export`,
`manageAppVersionAndBuildNumber=false`, and
`testFlightInternalTestingOnly=false`. It never passes
`-allowProvisioningUpdates`; missing local signing assets stop for a separate
approval instead of changing Apple configuration. Record the commit, full
archive-manifest/IPA hashes,
Info.plist, entitlements, provisioning team, exact application identifier,
matching associated-domain origin, and sanitized output in the P5
review artifact. Never upload a binary that differs from the inspected archive.

Inspection extracts and validates the distribution-resigned app inside the IPA,
not the development-signed app retained in the `.xcarchive`. It requests XML
entitlements on standard output with `codesign --entitlements :-`; Xcode 27's
output-file form emits a bracketed diagnostic format that is not a property list.
The archive manifest hashes every file and symbolic-link target in sorted order;
the implementation avoids zsh's reserved `path` variable and uses fixed system
tool paths so a missing digest command cannot silently produce a receipt.

`release-preflight.sh` decodes the installed profile and verifies its fixed
UUID, team, application identifier, and embedded certificate against an
installed Apple Distribution identity before archive work begins.

`inspect-release.sh` extracts exactly one app from the exported IPA, requires
strict deep code-signature verification, then decodes and validates the signed
entitlements. It also resolves every non-system `LC_LOAD_DYLIB` dependency in
the app and embedded frameworks and requires the referenced file inside the app
bundle. A damaged signature or missing hard-linked framework fails before
hashes are accepted. This enforces Apple's documented requirement that a linked
framework be embedded in the app bundle:
<https://developer.apple.com/documentation/xcode/addressing-missing-framework-crashes>.

## Exact upload command

When the user's authorization covers uploading this inspected candidate, bind
the source commit/version/build and both artifact hashes with the token below.
Populate it from the verified artifacts; no extra prompt is needed merely to
copy those known values into the script's integrity check.

```bash
NUMA_ASC_UPLOAD_APPROVED='<source-commit>:<version>:<build>:<archive-manifest-sha256>:<ipa-sha256>' \
  ./scripts/upload-release.sh /tmp/NumaShared-P5
```

The approval token binds the source, version, build, normalized archive
contents and modes, and exported IPA bytes. The script checks that token both
before and after re-running read-only preflight and inspection, then executes
Xcode 27 `xcodebuild -exportArchive` against the retained archive with
`config/ExportOptions-Upload.plist`, `destination=upload`, and the ASC API-key
path/ID/issuer. It does not use `altool`, rebuild the app, renumber the build, or
allow provisioning updates. This command is an external App Store Connect write
within the authorized candidate scope. The token is an integrity check, not
permission to upload a different candidate or reach a different audience.

## Approved operations

1. Complete only the production/configuration/synthetic-smoke work needed by
   the requested delivery and covered by its authorization. Reuse a working
   production deployment when the candidate does not change it.
2. Upload via the command above, then poll processing and match version/build.
   Apply the requested internal-group assignment when processing succeeds.
3. For a public beta, complete the authorized ASC draft/Beta App Review and
   tester/public-link steps when their prerequisites are ready. An internal-only
   request does not wait for unrelated public-draft work or expand the audience.

## Rollback and stop-distribution plan

- Before upload: retain the frozen archive and make no ASC change. If inspection
  fails, discard that candidate output and create a higher build from a new
  reviewed commit.
- After upload but before distribution: do not attach the bad build to the 1.0
  draft or any tester group. Upload a higher build; uploaded build identities are
  immutable and are never overwritten.
- After draft attachment: remove the build from the unsubmitted 1.0 version and
  select the replacement. Do not submit the App Store version.
- After TestFlight distribution: disable the public link, remove the build from
  tester groups, and use **Expire Build** to stop new installs. Treat an installed
  copy as reachable until Apple expiry takes effect; ship a higher fixed build.
- A production-origin or Convex rollback is a separate named external change.
  Restore only the last recorded known-good route/deployment after approval,
  then re-run web and production smoke before resuming distribution.

## Physical release smoke

An intended tester must accept, install, and cold-launch the exact build on a
physical iPhone. Record device/iOS/version/build and sanitized results for SIWA,
two-device sync, APNs deep link, installed-app Universal Link, offline retry,
and account deletion. Simulator proof cannot close this gate.

The App Store submission remains a complete draft. The final **Submit for
Review** action is human-only and outside this goal.
