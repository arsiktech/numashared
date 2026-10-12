# Local event store

`NumaSharedSync/` is the Swift 6 persistence, outbound-queue, and transport package. It targets iOS 26 and later, pins GRDB 7.11.1 and the official `ConvexMobile` SDK 0.8.1, and depends on `NumaSharedCore` for event and projection types.

## Storage contract

- `ledger_events` contains immutable arithmetic-only `WireEventV1` envelopes (or metadata-only compatibility barriers for unknown future kinds) and query metadata. Its update trigger prevents history mutation; the six-second undo transaction is the only deletion path. The `v2_erasure_sidecars` migration transactionally rewrites every legacy domain envelope before normal reads resume, without changing delivery state or local order. The client submits migrated pre-v2 event IDs only through the one-time `legacyMigrationEventIds` promotion boundary; Convex verifies that every ID belongs to the atomic promotion and stores server-authorized provenance. Ordinary append callers cannot waive current text validation, and a blank void reason is always rejected before any write.
- `event_text_sidecars` stores authored `title`, `category`, `note`, and `reason` values by event/field. Values cannot be updated, but rows can be hard-deleted. The immutable wire manifest makes a missing row hydrate explicitly as `[redacted]`; an idempotent replay compares retained values and never recreates a missing sidecar.
- Unknown future-kind JSON is retained losslessly in the separately purgeable `event_opaque_sidecars` table, while immutable future text-field/state JSON is retained in `event_future_text_sidecars`. Recognized `title`/`category`/`note`/`reason` values are still independently exposed through `event_text_sidecars`; one unknown future field or state cannot hide the recognized entries. Redaction rewrites only matching recognized future states to `redacted`, purge deletes both future sidecars, and replay cannot resurrect either. The metadata-only compatibility barrier remains in `ledger_events` without retaining unclassified future content.
- `event_delivery` contains mutable transport state separately from immutable event content. A composite foreign key guarantees that its pot matches the event's pot.
- `pot_configurations` stores an immutable starting configuration. Re-registration compares decoded configurations, so a semantically identical legacy encoding remains idempotent while a real configuration change is rejected. `pot_sync_state` stores the highest contiguous server sequence, never merely the highest sequence seen.
- Event origin is immutable. Compatible remote events above a sequence gap are buffered. A future-schema or unknown-kind event above a gap is instead placed immediately after the contiguous server prefix so Core makes the pot read-only before applying any local optimistic tail. Future-schema decoding reads the stable header and schema version before strict v1 time-zone or payload interpretation, so an unknown future time-zone remains opaque instead of invalidating the barrier. Path-backed relaunch preserves the raw manifest, text states, time zone, and incompatible/additive payload byte-semantically.
- Terminally rejected rows remain available for error UI and export, count as unsynced, and are excluded from authoritative balances.

Balances are never stored authoritatively. The store rebuilds a `NumaSharedCore` projection from immutable events; the 10,000-event sanity test proves a complete replay without imposing a machine-dependent timing threshold.

`LedgerStore.textStates(for:)` exposes present-versus-redacted hydration explicitly for current and unknown future kinds. `redactAuthoredText(for:fields:)` hard-deletes selected authored values and updates matching recognized future states to the redacted sentinel; `purgeErasureSidecars(for:)` removes all current/future text plus any opaque future payload for an event. Neither API mutates the arithmetic envelope. Remote hydrated replay can delete newly redacted fields, but never restores a value once its local sidecar is absent.

Archived members continue privacy-only polling. The opt-in
`events:listTextChangesWithSkippedRevisions` query bounds each page to 500 raw
revisions before applying the membership cutoff. Inaccessible changes disclose
only their revision numbers. Visible changes and explicit skips must together
account for every consecutive revision; the store applies the complete page and
cursor atomically. Deploy this endpoint before distributing its client. An
explicitly missing endpoint permits the legacy query, whose response shape is
unchanged; malformed pages and unexplained revision gaps still fail closed.

`LedgerStore` never persists a derived reducer projection or checkpoint. Each rebuild decodes the immutable starting `PotConfiguration` and replays reduction-eligible immutable event envelopes in canonical order, so historical settlement-group bindings are reconstructed from their `groupChanged` events. The legacy `StructuralProjection` decode fallback applies only to pre-field starting configurations and derives bindings for groups active at that starting boundary. A future import or checkpoint format must persist the complete historical group registry explicitly.

### Explicit budget-group capability

The store and repository retain a default reader ceiling of 1; the app explicitly
selects 2 for its group-first presentation. Ordering, reduction, snapshots and
runtime update barriers use that same ceiling. Completing new person/group setup
activates schema 2; existing schema-1 ledgers are not automatically converted.
Financial appends use the accepted
structural schema, not the highest available reader version, and never upgrade an
already queued event. Actual `payerMemberId` is independent of the recording actor
and owning unit; expense revisions retain it. Display names are resolved from
erasable profiles, never inferred from the author. An authoritative erased roster
name also clears its local-setup fallback, preventing revival after cache replacement
or relaunch. CSV continues to hydrate the immutable log from erasure-safe sidecars.

Migration v8 adds the local activation identity, queued topology operation's original
expected revision, roster budget-unit mapping, and durable write-pause code. Setup on
an empty ledger atomically stores the original rename/person prerequisites followed
by schema-2 activation. Dependent money retains its event IDs and append ordinals.
Invalid setup or a conflicting topology write does not leave partial local rows.

## App integration

The iOS app links both local packages. `AppLedgerRepository` is an actor that owns the synchronous `LedgerStore`, opens `Application Support/NumaShared/ledger.sqlite` for normal launches, and uses an isolated in-memory store only for DEBUG QA journeys. `AppModel` publishes rebuilt snapshots after persistence returns; it does not mutate balances or records independently. Archive state is carried in the rebuilt snapshot. Both the repository preflight and the app model reject new writes for an archived pot, while its last valid records remain readable.

The local pot registry is validated and written atomically; malformed JSON,
missing active entries, duplicate IDs/database names, and unmanaged filenames
are errors rather than an empty first launch. A bootstrap failure replaces the
unverified app state with a blocking Retry screen. A later ambiguous write
freezes further writes and offers a reload-only Retry banner: recovery rebuilds
the stored snapshot and never repeats a non-idempotent ledger command.

`LedgerStore.reductionOrderedEvents(for:reducer:)` is the single public ordering API for reduction and activity adapters: contiguous acknowledged server prefix, earliest compatibility barrier above a gap, then local-origin optimistic events by stable append ordinal. A future schema or unsupported event keeps Core's last valid projection visible, exposes the pot as read-only with “Please update,” and blocks new ledger writes.

## Undo and outbound ordering

A local append writes the event and a `held` delivery row in one transaction, so it affects the local projection immediately. Undo may delete it only while the UI opportunity is active, before the half-open six-second boundary, and before dispatch has ever begun.

When the deadline expires, `held` becomes `ready`. Relaunch ends every in-memory undo opportunity, so startup releases all persisted held rows immediately. Dispatch is single-flight per pot: only the earliest nonterminal, unacknowledged local event may move to `dispatching`. Held, in-flight, and retry-delayed predecessors block later events; acknowledgement or terminal rejection releases the head. Process-death recovery returns `dispatching` to `ready` without restoring undo eligibility.

Retryable transport failures keep the immutable local record in the optimistic projection and persist a retry deadline; an explicit Retry only clears that delay. Only the tracked exhaustive validation, unsupported-wire, and contribution-capacity taxonomy terminalizes an attempt, releases the queue head, and permits polling and later valid writes. The rejected event is excluded from money reduction but remains locally persisted and visible in Activity after relaunch with truthful, redaction-safe reason copy. Access loss and every other pot-level failure preserve all held/ready/in-flight rows; the in-flight head returns to `ready`. Unknown, malformed, or conflicting acknowledgements pause as `INVALID_SERVER_RESPONSE` with an explicit same-process Retry. The two capacity codes are `POSITIVE_CONTRIBUTION_BUDGET_EXCEEDED` and `NEGATIVE_CONTRIBUTION_BUDGET_EXCEEDED`; neither permits a Retry because repeating the same append cannot change the result.

Legacy accountless promotion atomically creates the remote pot with at most the server's 100-event ordered prefix. The complete response must be the exact request IDs at sequences `1...n`, and all local delivery transitions commit in one SQLite transaction. Records beyond 100 then drain through the ordinary idempotent single-event queue. If the server atomically rejects a promotion batch for an event-terminal reason, the store atomically marks every attempted row failed and persists an `emptyPromotionRequired` recovery marker. The marker survives relaunch and clears only after an empty promotion succeeds; only then does the unattempted remainder drain through ordinary append.

Budget-group promotion uses a separate typed, atomic prefix with the original owner
binding anchor and expected starting sequence. The first prefix contains activation;
the server sequences prerequisites before financial events. An ambiguous retry
requests the original receipts, without recreating profiles or restoring old names.
An initial prefix still inside its undo window waits locally without promotion or
remote reads; its readiness deadline is not reported as a network failure.
Later queued topology changes use the typed member operation and their persisted
expected revision, never generic append. A rejected group bootstrap preserves every
queued row and pauses; it does not use the legacy terminal-batch/empty-pot fallback.

Remote discovery distinguishes the immutable initial unit baseline from the growing
known-unit registry. A same-pot adoption validates and retains the local baseline;
a fresh device uses the server's explicit initial baseline. A schema-2 pot with
neither baseline fails `BOOTSTRAP_BASELINE_UNAVAILABLE`, rather than predeclaring
group units or guessing a configuration that changes replay.

Durable reconciliation pauses block promotion and outbox dispatch, not authorized
history, text-erasure or roster refresh. Runtime polling resumes only for the explicit
permitted durable-pause set. Archived membership permits privacy-only polling;
other membership, authentication and update failures stay stopped. Malformed
acknowledgements keep the existing explicit Retry boundary.
Reconciliation may clear a write pause to retry the unchanged request; it never
rewrites or discards money to make a conflict disappear.

Every sync run pulls and reduces the server prefix before touching the outbox. A future schema, unknown kind, or invalid sequenced event pauses the pot with `READER_UPDATE_REQUIRED` before any pending local event can upload. Convex SDK calls also share one FIFO boundary with authentication; timeout and caller cancellation keep that gate until an already-started SDK mutation has actually returned, preventing cooperative cancellation from creating overlapping client calls.

The store exposes two intentionally different delivery counts. `unsyncedEventCount` includes pending and terminally rejected local rows; it protects sign-out and other loss guards until the user has resolved or exported every unsynced attempt. `pendingDeliveryEventCount` excludes acknowledged and terminal rows and alone drives the “Syncing” count. “Synced” is truthful only when the whole pot has zero pending deliveries, regardless of the current Activity filter or projected-record subset; when terminal local attempts remain, Activity says they are only on this iPhone instead of claiming shared history. Stopping the polling task is intentional control flow, so cancellation must preserve the last trusted state and must not publish a false network outage.

Confirmed account exit replaces account-bound identity metadata before clearing
SQLite, then removes every event, delivery row, text/opaque sidecar, sync cursor,
roster, setup row, and pot configuration in one `secure_delete` transaction. It
also resets the local event ordinal, removes prepared CSV files, and registers a
fresh accountless identity. A count-bearing confirmation is mandatory when
`unsyncedEventCount` is nonzero; Sync now is offered before the explicit lossy
choice.

## File protection

Path-backed stores explicitly use WAL mode and default to `completeUntilFirstUserAuthentication`. The main database and SQLite `-wal`, `-shm`, and `-journal` auxiliaries receive the selected iOS file-protection class before and after initialization. The injected `DatabaseQueue` initializer is internal and exists for package tests; the public in-memory store has no files to protect.

## Verification

Run from the repository root:

```bash
swift test --package-path NumaSharedSync
```

The hosted `NumaSharedTests` target covers the app adapter's ordering, read-only, relaunch, expiry, overflow, attribution, and locale boundaries. It runs with the shared scheme; use `docs/DEVELOPMENT.md` for focused native checks and `scripts/phase-gate.sh` for the full release matrix.
