# Core ledger

`NumaSharedCore/` is the Foundation-only Swift 6 package for shared domain types, events, money, allocation, reduction, and undo eligibility. It targets iOS 26 and later and is independent of SwiftUI, UIKit, persistence, and transport.

## Money and identifiers

- Financial values are `Int64` minor units paired with an uppercase three-letter currency code and exponent.
- `MoneyInput` normalizes Unicode decimal digits (including Arabic-Indic and fullwidth digits) to ASCII before exact conversion and keypad editing. Callers split locale separators; signs, grouping, fractions such as `½`, and other non-decimal numerals are rejected. Currency precision and overflow checks still apply. Run `swift test --package-path NumaSharedCore --filter IdentifiersAndMoneyTests` for the input/formatting contract without a Simulator.
- `MoneyFormatter` also accepts exact `Decimal` minor-unit aggregates beyond `Int64`, applying the supplied currency exponent and viewing locale without a binary floating-point conversion.
- Exponents 0 through 4 are supported. `CurrencyCatalog` selects new-pot currencies from `CurrencyAdmissionV1`, pinned to the backend's `convex/iso4217.ts` code/exponent contract. Locale supplies a region suggestion only; unsupported suggestions fall back to EUR. The creator must explicitly confirm one currency. Existing/server-delivered currency decoding remains permissive and no stored pot is migrated.
- The confirmed currency replaces only the unused provisional local configuration. Database guards reject a currency change after setup or the first ledger event, because conversion is outside v1.
- Weighted splits use one identifier-agnostic Core integer engine and put the
  residual on the final unit in caller-provided order. The typed Money adapter
  preserves its unit-specific validation errors; app-scoped draft IDs use the
  same arithmetic before persistence maps them to durable Core units.
- Pot, member, unit, record, event, and group identifiers validate as UUIDv7 at decoding and public construction boundaries.

## Event ordering and safety

`LedgerReducer.reduce(pot:events:)` canonicalizes its input before folding it. Events with a server sequence reduce first in ascending sequence order, using normalized event ID as a deterministic tie-break. Pending local events then reduce in the sequence's supplied order, so persistence must load them by stable local ordinal. A duplicate positive server sequence stops before either colliding event is applied.

The reducer stops at the first unsupported schema, unknown event kind, invalid event, or arithmetic overflow. It excludes that event and every later event, returns the projection produced by the previously committed prefix, and reports `.readOnly(issue)` so callers can display/export that last-valid state but must reject writes. Only a completely safe fold reports `.readWrite`. A successfully applied `potArchived` is a terminal domain boundary: its projection remains readable/exportable with `isArchived == true`, while any later event is rejected at that archived prefix. Financial transitions are preflighted and committed atomically, so every returned balance projection remains zero-sum. A settlement planner resource limit reports an unavailable plan without making an otherwise valid ledger read-only. Future payloads retain every sibling field beside their unknown `kind` in a semantic JSON tree and re-encode the original discriminated-object shape for lossless storage/export round trips.

Wire admission is deliberately identical on Swift and Convex boundaries. Authored text is blank only when every scalar belongs to Foundation's `CharacterSet.whitespacesAndNewlines`; JavaScript `trim()` is not equivalent. Originating time-zone identifiers follow Core's case-sensitive `IANATimeZone` contract, so aliases and case variants accepted by JavaScript `Intl` cannot be sequenced if an iOS client would reject them. Shared parity fixtures exercise both runtimes, and Convex rejects a mismatched event atomically before assigning a sequence or writing an event or text sidecar.

Convex adds an admission defense before assigning a sequence. Each pot has monotonic positive and negative contribution-capacity counters; new financial content reserves the sum of every positive per-unit contribution and the sum of every negative per-unit contribution, with expense amount also setting the positive spend-capacity floor. These counters are conservative append-only bounds, not balances or projections. Summing by sign ensures that any later settlement-group aggregation remains inside `Int64`, regardless of which units are grouped. Revisions reserve new content, lifecycle annotations reserve zero, and exact idempotent replay reserves nothing. Crossing either Int64 boundary fails the whole mutation with `POSITIVE_CONTRIBUTION_BUDGET_EXCEEDED` or `NEGATIVE_CONTRIBUTION_BUDGET_EXCEEDED`; no sequence, event, text sidecar, or counter is committed. Core's arithmetic checks remain an independent fail-closed defense for imported or corrupted history.

`PotConfiguration.topology` is the structural snapshot immediately before the supplied log. Member, claim, archive, ownership, group, and preset events then fold in sequence. `knownUnitIDs` is the durable historical set used to replay and explain old records; `activeUnitIDs` is the current set for new expenses, opening balances, and presets. Each member permanently owns a unique personal unit. `groupUnitIDsByGroupID` permanently binds every known group identity to one distinct non-personal unit, including dissolved groups, so later structural events cannot relabel historical money. Populated topology has exactly one non-archived owner. In schema 1, archived members cannot remain in a current group, and empty topology remains valid before local setup. Owner-directed archival requires an earlier transfer; voluntary owner leave atomically appends that transfer before the archive.

Raw financial contributions always remain keyed to the unit IDs recorded on their immutable events. The schema-1 public balance projection reversibly maps each active, non-archived member's personal-unit contribution into their current settlement group and emits that shadowed personal unit as zero. Moving or dissolving a group therefore reprojects untouched personal history; financial records created against a group unit remain on that persistent historical unit. Archived members keep individual unresolved balances. Settlement planning and settlement eligibility consume the same projected map, so current group members can never receive an internal transfer. A nonzero historical unit remains settleable, while a zero historical unit is ineligible. Group, archive, and financial transitions preflight projected aggregation through `Int128`; a non-exact `Int64` result rejects the event and preserves the last-valid prefix.

Voluntary leave is a typed, retry-safe server mutation. A member appends their own `memberArchived`; an owner first appends `ownershipTransferred` to the longest-standing active claimed member in the same atomic mutation. A sole active owner cannot leave until another member is active. The archived membership stores the archive sequence as its final read boundary, so the departing device can persist a frozen exportable snapshot while later pot events remain inaccessible. Voluntary leave retains the member's name; only account deletion performs identity erasure.

Repeating a past expense appends a new independent `expenseAdded` record from the source record's current uncontested, non-voided content. It preserves the exact integer amount, payer, category, and allocations; it does not mutate or link financial history. The new event receives the normal six-second unsent undo window.

The v1 event vocabulary intentionally omits `refundAdded`, `adjustmentAdded`, `currencyConverted`, and `templateChanged`.

## Budget groups: opt-in schema 2 (ARS-113)

Schema 1 remains the default reader/authoring version and replays with its original
financial outcomes. `maximumSupportedSchemaVersion` is 2; Core callers can explicitly
pass that capability to `LedgerReducer(supportedSchemaVersion:)`. Enable the
`budgetGroupSchemaVersion` only after the complete reader, writer, persistence,
transport, and presentation path is ready. ARS-113 does not enable those integrations;
its only Sync production change handles the new no-event-ID reduction issue in an
existing exhaustive switch. This keeps current app balances and Activity on the
same schema-1 boundary rather than partially interpreting a schema-2 household.

The first accepted schema-2 event sets the structural `minimumSchemaVersion` to 2.
Later schema-1 events fail closed, including stale offline structural writes; they
must not be silently upgraded. Future schemas/kinds remain opaque/read-only.
A schema-1-only reducer stops before a schema-2 event. A topology checkpoint carries
both this monotonic minimum and `hasFinancialHistory`, so checkpointing, voiding,
or settling to zero never unlocks financially active groups. Serialized schema-2
topology uses `budgetGroupMembers` instead of the legacy required `members` key:
old snapshot decoders fail with a missing-key error rather than silently ignoring
the new semantics. New decoders reject unknown topology versions. Legacy decoded
checkpoints without the history marker conservatively lock new coupling; only
replay from a known pre-history configuration can establish that setup is still
empty. This does not change schema-1 event replay or transfer money. Readers must
retain this versioned topology or the original full event log; rebuilding it from
only a roster or current balances loses the compatibility/history boundary.

A person's original unit is their implicit single-person budget group; couples
use existing stable group/unit IDs. New changed groups have one or two members and
default weight 1. Equal allocation passes the selected group units, once each,
to the existing allocator with weight 1; exact allocations remain explicit integer
amounts. No second ledger or intra-couple liability is introduced. `personal` means
paid for exactly one other group; repayment records money moved outside Numa Shared.

Group topology can change before financial activity. Once any financial record
exists (including opening balances, repayments, and subsequently voided expenses),
a changed group snapshot is rejected. Existing valid schema-1 groups, weights,
and balances are not rewritten or retroactively rejected at activation. In
particular, financially active legacy singleton ledgers cannot be merged, and
legacy archive/group effects remain intact up to that boundary. There is no
implicit migration of old money or invented group identity.

After activation, member archive/departure retains the historical member-to-group
binding and group definition, including when both partners leave. Archived people
are inactive, but existing group debt stays on its original unit, remains
explainable, and can be settled or corrected. Identity/name erasure is a separate
sidecar operation and must not delete/reassign these arithmetic identities.

`ExpenseContent.payerMemberID` is optional schema-2 actual-payer attribution,
separate from `actorMemberID` (the author). Nil means unknown, including legacy
history: never infer it from the author. New purchases require a known active payer
in the stated payer group when attribution is supplied. Historical corrections
may retain a departed payer and that record's original personal payer unit. Both
expense and revision wire adapters preserve attribution through text redaction;
no display name or account credential enters the financial payload. Schema-1
attribution is rejected at decoding, encoding, and reduction boundaries.

All financial edits still use visible append-only revisions/voids/restores or
bounded repayment reversals. The existing zero-sum, exact-money, duplicate, and
overflow checks continue to apply. Server admission, account isolation, promotion,
outbox conflict recovery, and app/export presentation require ARS-114/115 work;
Core tests do not certify those paths or enable a schema-2 production writer.

## Settlement planning

The planner searches for the exact minimum-transfer plan with deterministic tie-breaking. Because exact account balancing has exponential worst cases, it first bounds nonzero active-unit count before allocating sorted search state, then applies fixed cross-device limits for expanded states, inspected branches, and recursion depth. It never returns a best-so-far or greedy substitute. `SettlementPlanOutcome.exact([])` means everyone is even; a resource-limit result is explicitly `unavailable` while the ledger remains writable and manual settlement remains possible. Event replay sorts by server sequence and is not described as linear-time.

## Revisions and undo

Expenses and opening balances are revisable and voidable through appended events. A revision may preserve inactive units already used by that record, but it cannot introduce an unrelated inactive unit. Settlements are immutable and may receive a flag annotation. A flagged settlement can then be corrected only by a new opposite-direction `settlementRecorded` event carrying its exact `reversalOfRecordID`; partial links may accumulate but never exceed the original amount. The original and every correction remain visible, and known historical units stay eligible for this bounded correction even after membership topology changes. Convex independently verifies the flagged target, direction, and indexed cumulative amount before sequencing. Concurrent revision heads remain contested, the highest-sequenced head applies provisionally, and a resolution explicitly names both heads. Record detail projects the complete revision history, compares active expense heads with their exact balance effect, and resolves more than two heads pairwise without mutating history.

Activity filters only the local timeline projection: free-text search covers titles, categories, notes, authors, people, and revision history; kind and week/month/year periods compose with an optional participant filter. These filters never alter continuous balances. An ordinary expense edit appends `expenseRevised` against the applied head and previews every changed unit balance before save. Amount edits preserve the existing beneficiaries and reallocate integer minor units proportionally with remainder-to-last; metadata-only edits preserve every allocation byte-for-byte. Void confirmation requires user-entered nonblank reason text, and the reducer projects the trimmed reason while voided so Activity can show it without mutating the original record.

The app projection exposes every opening balance as a zero-amount record whose
signed per-unit entries and complete revision history remain visible. Local
creation enters the same held-event/undo path as every other financial record;
Core rejects a non-zero-sum entry set before it can become writable history.
During setup, each member amount is parsed directly into the confirmed pot
currency's minor units with that currency's 0–4 digit exponent. The household entry is the exact negated member total,
so imported starting balances cannot introduce rounding drift or a non-zero sum.

Undo is eligible only while the local event is held, has never entered dispatch, the UI opportunity is active, and elapsed time is in the half-open interval `[0, 6 seconds)`. The GRDB store owns the eventual transactional delete-versus-dispatch decision.

## Verification

Run the package suite from the repository root:

```bash
swift test --package-path NumaSharedCore
```

In a managed sandbox that blocks SwiftPM's caches and nested sandbox, point both module caches at `/tmp` and add `--disable-sandbox`; this is an execution-environment workaround, not the canonical developer command.
