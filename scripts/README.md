# Scripts

The phase gates below target the legacy SwiftUI app in `ios/NumaShared/`.
They are Swift compatibility checks, not the current Expo release gate.
Use [the verification map](../docs/CI.md) for `app/` checks and coverage gaps.

`phase-gate.sh P2|P3|P4|P5` is the only phase-gate entry point. It prints the
full `main` base, candidate head, and candidate tree. It requires a clean frozen
worktree, rejects a head not descended from current `main` or an empty phase
range, rejects whitespace errors across that frozen range, validates the tracked
Convex CLI/backend pin plus lock integrity, and runs Core, Sync, backend
type/unit/ACL/redaction tests, the complete iOS 27 Xcode/UI suite, the Release
boundary, and deterministic local sync. It reports only a local matrix result;
review depth and delivery decisions follow `docs/REVIEW-GATE.md`. It fails closed if a required
gate executable is absent, or if the worktree, base, head, or tree changes while
the matrix is running.
P2 selects the P2 sync journey; P3, P4, and P5 select the latest P3
multi-account sync journey while retaining their own phase identity in the
frozen matrix receipt.
P5 additionally requires the local expense/balance/repayment/history journey and
approved native Welcome/Create interaction on the pinned iPhone 17 Pro / iOS 26.2 runtime.
This is genuine iOS 26 family coverage for the iOS 26.0 deployment floor, not
executed 26.0 proof. The existing complete 27.0, Release-boundary and sync lanes
are unchanged; an unavailable 26.2 runtime fails rather than being skipped.

`convex-toolchain-check.sh` binds the gate to `scripts/convex-toolchain.json`,
the exact root/lock/installed CLI version, the npm lock integrity, the full
installed Convex package tree and canonical CLI entry point, and the exact
platform backend executable. Its sanitized receipt prints both versions and
SHA-256 hashes for every executed toolchain surface, the pin, and the lockfile.
The phase gate rejects same-version byte or symlink tampering and also runs its own mocked matrix
contract, deterministic-sync contract, anonymous-local guard contract, and the
sorted Swift/backend event-terminal taxonomy contract before product tests. The
auth-error contract also requires the exact six backend `AUTH_*` failures to
have an explicit Swift recovery classification.

`xcodebuild-test.sh` is the gate's bounded Xcode test entry point. It forwards
the requested build unchanged and watches only for Xcode 26.5's exact sleeping
`clang -v -E -dM ... -c /dev/null` metadata probe under `SWBBuildService`. If
that known probe remains present across two ten-second samples, the wrapper
terminates only that child so Xcode can continue, then returns the real
`xcodebuild` status. Its contract test proves
argument and exit-status preservation; no build compiler process matches the
watchdog signature.

`p1-release-check.sh` builds the iOS 27 simulator app in Release and fails if
any debug-only QA, seed, or local-auth/sync marker remains anywhere in the app
bundle. It also fails if the bundle scan cannot complete or any hard-linked
non-system runtime dependency is absent from the finished app bundle.

`release-preflight.sh` validates the frozen release inputs before archiving. Its
read-only App Store Connect inventory checks both processed builds and build
uploads, because an upload can reserve a build number before it appears in the
processed builds collection. `assert-build-floor.mjs` then requires the Xcode
candidate build to be a positive integer strictly above that combined floor.
`tests/release-build-floor-contract-test.sh` proves the fresh-number, missing
receipt, ambiguous receipt, and invalid-number boundaries without contacting
Apple. `tests/asc-build-floor-contract-test.mjs` separately proves that
processing and complete uploads reserve their numbers, failed uploads remain
reusable, and processed builds share the same maximum floor.

The same preflight runs `release-web-preflight.mjs` against the exact release
origin. It requires direct HTTP 200 responses for the marketing root, generic
invite landing, privacy, support, AASA, and app-config routes; validates their
content types and payload contracts;
requires the exact signed application identifier to expose `/join/*` only; and
rejects redirects. The signed-candidate inspection rechecks that identifier,
the associated-domain host, full archive payload manifest, and the live web
contract. It verifies strict signature validity and runtime dependency closure
for the main executable and every embedded framework before accepting hashes.
`archive-release.sh` never allows provisioning updates;
`upload-release.sh` is the candidate-specific, archive/IPA-hash-bound,
approval-gated Xcode 27 upload entry point. The mocked web contract test performs no network writes or
configuration changes. Under the recorded release decision, the marketing root
and app routes must pass on one origin; a split origin requires a new decision.

P2 adds the two-simulator `sync-test.sh` gate. It runs only through the asserted
anonymous-local Convex lifecycle, clones the pinned iOS 27 simulator twice,
persists local setup and creates one real expense on A before first authentication,
proves that the accountless expense is promoted as sequence 1, that four setup
events reconcile as sequences 2...5, and that all five are adopted by B. It then
measures a distinct post-auth A-to-B write below five seconds and queues 20 more writes while A's
Convex transport points at a proven-closed loopback endpoint, restores the
transport, and requires both replicas to hold 26 unique events with contiguous
ordered `(serverSequence, eventID)` pairs `1...26` and no pending writes. It
compares those exact pairs across A and B after promotion, the post-auth write,
and the final replay. Its JSON artifact verifier rejects stale stage artifacts,
duplicate IDs, gaps, pair/identity disagreement, replica reordering, and
cosmetic connectivity; the offline checkpoint must report the real `offline`
state rather than `paused`.

`convex-local.sh` is the only allowed local Convex entry point. It validates an
owner-only anonymous configuration, exact loopback URL, live instance name,
and pinned CLI. The `with-convex-local-e2e.sh` wrapper creates an ephemeral
P-256 signing key and random local-only secrets. It bootstraps the exact
allowlisted environment against the statically verified anonymous selection,
starts that selected instance, reasserts its live name and loopback URL, and
reapplies the environment before running the child. Temporary source files are
deleted on exit. It never uses Apple credentials or a cloud project.
The wrapper also rejects any operator backend-version mismatch, scrubs
`CONVEX_PROVISION_HOST` with every other deployment override, and rejects a
fresh anonymous config containing `cloudProjectId`. Every CLI invocation forces
anonymous agent mode even inside a logged-in interactive terminal. Because that
mode uses Convex's fixed `anonymous-agent` name, the wrapper also gives every
run a private temporary HOME and exposes only the already-verified backend
binary cache; legacy operator deployment credentials and data cannot be
resolved. The fixed `anonymous-agent` display name may match another isolated
run, so the guard compares the actual admin key and instance secret and rejects
any reuse. Before the CLI starts, the wrapper uses that verified pinned binary
to generate fresh run-scoped credentials and seeds the ephemeral local config.
This avoids Convex CLI's otherwise mandatory latest-backend lookup while
keeping the gate independent of the network and operator state.
`tests/convex-local-integration-test.sh` proves a real authenticated promotion
and read-own-write against that instance.

Convex applies account-scoped write quotas transactionally: up to 2,000 newly
sequenced events per rolling hour and 20 newly created pots per rolling day,
with at most 100 active pots. Exact idempotent replay is free, rejected batches
roll back quota consumption, and one account cannot consume another account's
budget. The 500-event offline drain remains inside the reviewed event budget.

`tests/phase-gate-test.sh` validates the orchestrator with mocked commands; it
does not run or configure Convex, Xcode, Apple, or any network target.
`tests/sync-test-contract-test.sh` validates the deterministic harness and its
artifact rejection contract without starting Convex or Simulator services.
`tests/event-terminal-contract-test.sh` requires the tracked sorted code list
to equal both the backend emission surface and Swift terminal allowlist.

## Approved interface comparison

`compare-interface-frame.py` compares an approved frame with an actual full-resolution
Simulator PNG. Use Python with Pillow (the Codex bundled workspace runtime provides
it); no dependency reinstall is required. Example, after capturing matching data:

```sh
python3 scripts/compare-interface-frame.py \
  outputs/design/interface-v2/09-home.png \
  outputs/validation/ars-117-fidelity/home-native.png \
  outputs/validation/ars-117-fidelity/home-comparison --state home \
  --reference-profile "/System/Library/ColorSync/Profiles/Display P3.icc"
```

The native image must match 1179×2556 for the 393×852 logical reference at 3×;
a documented one-pixel XCTest raster-rounding difference is reported, not stretched. The
exact-model fidelity lane is separate from mandated iOS 26/27 release tests. Reuse
its task-owned device; preserve other Simulators. The tool converts embedded color
profiles to sRGB, normalizes only reference raster scale, and emits side-by-side,
50% overlay, amplified pixel difference and hashed JSON metrics. It never returns
a visual PASS: matching fixture/locale/type/date/state, layout fidelity and
platform-rasterization differences require inspection. Both full-frame and
app-region metrics are reported; no app-layout defects are masked or warped away.
All 60 frame coverage is tracked in the current task's ignored validation ledger.

The original interface-v2 browser exports are untagged Display P3: live computed
Home butter is sRGB(244,222,138), while the export stores(241,223,149); Apple's
sRGB→Display P3 transform predicts(240,223,149), within one quantization step.
The explicit reference-profile option accounts for that evidenced capture pipeline
without modifying the approved source or native tokens. Do not apply it blindly
to new/tagged exports. The native PNG declares sRGB; unobscured butter measures
exactly(244,222,138). Record the chosen profile in every comparison receipt.
