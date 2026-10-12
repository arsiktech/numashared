# Development environment

Numa Shared supports iOS 26.0 and later and builds in Swift 6 mode with complete strict-concurrency checking. The app target uses MainActor default isolation; the pure core and persistence packages do not. The app, native/UI test targets, and Core/Sync package floors are all iOS 26.0. Native Liquid Glass remains available at that minimum; do not introduce a separate older-iOS visual design.

The pure ledger contract and package test command are documented in [`CORE.md`](CORE.md). The GRDB schema, queue ordering, undo recovery, and persistence test command are documented in [`PERSISTENCE.md`](PERSISTENCE.md).

## Simulator gate

The full UI gate remains on iPhone 17 Pro Max with iOS 27.0. P5 additionally runs the local expense → balance → external repayment/history journey and approved native Welcome/Create interaction on iPhone 17 Pro with iOS 26.2. The deployment floor is 26.0; 26.2 is the pinned iOS 26 runtime, not a claim of an executed 26.0 test. Missing either runtime blocks the release gate rather than substituting another OS or treating a build-only check as runtime proof.

The full native/UI invocation is in `scripts/phase-gate.sh`, using `scripts/xcodebuild-test.sh`. For focused work, use XcodeBuildMCP simulator tests with the affected `-only-testing` targets, a pinned existing compatible Simulator, and incremental DerivedData; the full matrix is for release candidates. Read session defaults and inventory once before the run. Do not reset or replace an already-booted Simulator. Runtime installation is a separately resolved prerequisite, not part of a test retry.

## P4 system-quality boundary

Launch keeps financial projections behind a static, accessible skeleton until
the local ledger bootstrap returns. `--qa-loading-skeleton` holds that state for
the UI contract test; it is compiled only into Debug builds.

`GoldenPathUITests` audits the seeded Home and Settings surfaces with
`performAccessibilityAudit()`. Its performance cases use one measured iteration
to keep the gate bounded. Cold launch records `XCTApplicationLaunchMetric` and
must finish the app's own ledger-bootstrap-to-interactive interval in under 1.5
seconds; the hard threshold excludes XCTest process-control and element-query
overhead. The approved full Add row/orb tap records CPU plus frame hitches on
the pinned iOS 27 runtime and must actually open expense entry. Its unmeasured
warm-up invocation returns Home before the measured tap. The eight-unit Home
retains the measured 59 fps minimum; launch and metric thresholds are unchanged.

The seeded Home audit hides only simulator-owned status chrome. It is
fail-closed for every reported app-bound and element-less finding; deterministic
token contrast tests supplement the rendered audit but never suppress it. The
Settings audit is also fully unfiltered. The status-bar launch seam and
launch-ready timing value are Debug only and cannot appear in a Release archive.

## Release QA boundary

QA launch arguments, the Casa Mar seed entry point, and the deterministic local
auth/sync harness are guarded by `#if DEBUG`. A Release build must not contain
their launch arguments, environment prefixes, local endpoint paths, database
names, account prefixes, or seed copy; `scripts/p1-release-check.sh` scans the
whole app bundle for that boundary.

## Backend unit gate

The deployment-free backend checks are:

```bash
npm run backend:typecheck --silent
npm run backend:test --silent
```

Generated Convex files under `convex/_generated/` are tracked. Refresh them
only through the asserted anonymous-local lifecycle used by `sync-test.sh`.
There is deliberately no plain `convex dev` package script: an unverified
environment must never select a cloud project, especially main Numa.

Backend tests also pin the append-only Int64 admission envelope: exact positive
and negative boundaries, revisions and settlements, idempotent replay, atomic
batch rollback, ordinary 501-event pagination, and authored-text erasure over
multiple pots. Contribution capacity is safety metadata only; backend code must
not derive or persist balances.

## P2 backend schema and ACL boundary

P2 persists identity and rotating-session records; pots and active membership;
immutable arithmetic events; hard-deletable authored-text sidecars and their
redaction cursor; and per-pot server sequence plus conservative contribution-
capacity metadata. Authenticated reads and appends require active membership,
and account binding is checked before discovery or mutation. P3 structural
operations such as invite, claim, ownership, group, and preset changes are
rejected at this phase's public append boundary. Convex never stores a balance
or projection: clients derive both by replaying the canonical event stream.

## Deterministic multi-account gate

`NUMA_PHASE=P3 ./scripts/sync-test.sh` runs the P3 extension against the same
asserted anonymous-local Convex lifecycle. Two clean simulator clones receive
distinct deterministic accounts. The script issues typed pot-link invites,
proves a pending claimant cannot discover, read, or append to the pot, rejects
that leaked claim, approves a fresh claim, then proves cross-account expense,
settlement, concurrent revision, contested projection, explicit append-only
resolution, and exact ordered convergence through server sequences 1...11.

The script prints no invite tokens or claim tickets and removes its cloned
devices and temporary data on exit. This local gate does not replace the signed
physical-iPhone SIWA, Universal Link, and APNs smoke required by P3.
