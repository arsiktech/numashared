# Identity boundary

Numa Shared accepts Apple credentials only at `POST /auth/apple/exchange`.
The client sends the Apple identity token, one-time authorization code, and the
raw nonce. The server verifies Apple's RS256 signature plus the exact issuer,
bundle-id audience, expiry, issued-at time, and lowercase-hex SHA-256 nonce;
then it exchanges the code at Apple's fixed token endpoint and verifies the
returned identity token belongs to the same Apple subject.

The iOS authorization request asks only for the email scope; Numa Shared does not
request or retain Apple's full-name field. Before any newly exchanged or
refreshed session can replace the cached refresh token or publish an access
token to Convex, the client validates its normalized account ID against the
pot's persisted account binding. A wrong-account attempt therefore leaves the
previous accepted refresh credential intact and cannot list or mutate pots. A
newly issued session rejected during account validation or credential storage
is best-effort revoked. Fresh exchange rejection restores the predecessor;
rotated-refresh rejection clears the predecessor that the server invalidated.

## Pot binding and promotion

A local pot remains accountless until the user performs a sync-triggering
action. After authentication, the client discovers the account's remote pots
before deciding whether to promote local history. A clean device with an empty
local pot adopts the existing account pot; a device with immutable local events
promotes that pot, its per-pot owner display name, and its first 100 eligible
events atomically, then drains any remainder through idempotent appends. The
persisted account binding is
checked before remote listing, adoption, promotion, or mutation, so a different
Apple account cannot inherit or upload the previous account's household. A
cancelled or retrying request never discards the local pot and never replaces a
previously accepted refresh credential. Task cancellation and URL loading's
cancelled result remain `CancellationError`; the HTTP boundary never relabels
them as a retryable network outage.

## Per-pot roster and erasure

Display names live in the `potMemberProfiles` sidecar, never inside the
append-only event envelope. Structural events remain the audit source for
member and unit topology; the profile projection stores only the current
per-pot display name, role, unit binding, and pending/active/archived state.
`members:listRoster` is available to active pot members and deliberately omits
account identifiers. Owner-created pending identities are inserted atomically
with `memberAdded`: `addPendingMember` grows the unit list for a later addition,
while `bindPendingMember` attaches offline setup identities to existing,
unowned configuration units without changing their IDs. Owner and pending
bindings return the original sequence on exact request replay; a different
name or topology for the same event fails closed. An owner may erase
an unclaimed person's display name through `members:anonymizePendingMember`
without mutating history. Claimed-account erasure remains part of the P4 account
deletion transaction.

Fresh local setup collects the pot name, explicitly confirmed currency, owner and
chosen additional people in native text fields. Each person belongs to one singleton
or couple budget group, with at least two balance groups. The app remains in onboarding until the
single local transaction succeeds, then restores the completed setup on
relaunch. The transaction persists the pot name and per-pot profiles in
erasure-capable sidecar tables. It also persists one exact
`potRenamed` event plus one exact `memberAdded` binding event per configured
unit. These operations never enter the local financial outbox. Promotion sends
the stored IDs through the typed rename and role-specific binding mutations,
then records confirmation by that same ID; an ambiguous response therefore
retries the identical operation instead of minting a second identity event. New
setup then activates the full group snapshot through the typed setup path; there
is no name-only fourth participant or financial identity shared between accounts.

Numa Shared access tokens are ES256 custom JWTs for Convex with a maximum five-minute
lifetime, capped at the session's absolute refresh expiry. They contain the
exact configured issuer/audience plus `sub`, `sid`, `jti`, and
`token_use=access`. Numa Shared refresh tokens are random 256-bit values; only their
domain-separated HMAC hashes enter Convex. `POST /auth/refresh` rotates them,
and reuse of a prior token revokes that session family. The route permits the
first immediate cached restore, while source-isolated and per-token fixed windows bound
repeated attempts. Expired rotation history is deleted in bounded batches and
an account can hold at most 20 live sessions. `POST /auth/logout` is idempotent.

In-app sign-out first stops automatic polling, unregisters the known APNs token,
and clears the Keychain refresh credential through the authenticated client. It
then performs the local purge described in `docs/PERSISTENCE.md` and returns to
fresh accountless onboarding. A failed local purge remains retryable even though
the remote session has already been revoked; the old account binding is never
restored from disk.
Apple's refresh token is AES-256-GCM encrypted because deletion must later send
it to Apple's revocation endpoint; it is never stored in clear.
Rate-limit responses are marked retryable: clients must retain the current
refresh token and retry later because no rotation occurred.

Apple key fetch, code exchange, and revocation calls have a five-second abort
timeout and use only Apple's fixed HTTPS endpoints. Apple exchange is bounded
before required-field checks, signing-key validation, or those calls by 30
requests/source/minute, then by five requests per code/token per ten minutes.
Refresh and logout are each bounded at 120 requests/source/minute and ten
requests/token/minute. Every public identity route consumes its trusted-source
bucket before JSON parsing, request-field validation, credential hashing, key
validation, or external cryptography. The source is Convex's trusted request-metadata IP;
missing metadata fails closed outside disposable anonymous-local tests. Source
and credential bucket keys are domain-separated HMACs, never raw IP, Apple, or
Numa Shared refresh material.
Malformed JSON therefore cannot bypass the source quota. Apple token-endpoint 429 and 5xx responses remain retryable upstream failures;
only terminal exchange failures are reported as bad credentials.

`POST /auth/apple/notifications` accepts Apple's `{ "payload": "<JWT>" }`
server-to-server envelope. It verifies Apple's RS256 signature, exact issuer
and bundle-id audience, issued-at window, optional expiry, JWT id, and bounded
event claims. Before required-field checks, signing-key validation, or JWKS
work, it charges 30 requests/source/minute. Bounded JWT shape and key id are
then checked, followed by five requests per source-plus-payload fingerprint per
ten minutes. The 120/minute deployment-wide notification quota is charged only
after Apple signature and claim verification, so unverified traffic from one
source cannot lock out a valid revocation from another. `email-enabled` and
`email-disabled` are recorded.
`consent-revoked` and `account-delete` atomically mark the Apple authorization
revoked and revoke active Numa Shared sessions in bounded batches. Event receipts are
idempotent by signed JWT id plus event index; unknown signed event types persist
one idempotent no-op receipt but do not mutate identity state. Push cleanup belongs to P3 and
full account deletion plus outbound Apple revocation belongs to P4.

## Budget-group admission (ARS-114)

`members:changeBudgetGroups` is the owner-authorized schema-2 setup/activation
operation. The caller supplies a full `groupChanged` event and the observed
`expectedTopologyRevision` from `members:getBudgetGroupTopology`. The owner must
first bind their personal unit. Other participants may be unclaimed placeholders;
grouping never claims an identity, inserts account membership, or bypasses invite
approval. Active account ACLs remain person-specific. Generic `events:appendEvents`
still rejects all structural event kinds and cannot activate schema 2.

An authenticated active original actor can recover an exact setup receipt even
after transferring ownership. The retry returns the original sequence/revision
before checking current ownership, topology revision, or the financial-history
freeze; it does not change quotas, topology, or sequences. Another actor, an
outsider/unapproved account, or an archived original actor cannot recover it.
New setup always requires the current owner. Its stored `groupExpectedRevision` is
part of request identity; reusing the event ID with changed event content or expected
revision fails. New requests with a stale revision fail atomically. Convex mutations
sequence the event, append new durable group units, update the topology projection,
and raise `minimumReaderSchemaVersion` together. No names enter group events.
`potMemberProfiles.unitId` remains the personal unit; schema-2 roster responses add
`budgetUnitId` without changing person/account identifiers.

`pots.budgetGroupTopology` is rebuildable admission metadata: current and historical
person/unit bindings, group/unit registry, latest structural sequence as revision,
minimum schema, and a monotonic financial-history lock. It stores no balances.
Schema-2 departures and account erasure retain group bindings while revoking the
person's participation/access. The deletion worker uses the pot's schema for its
server-authored transfer/archive events. Legacy schema-1 history keeps its prior
group/archive semantics; activation never reassigns past money or infers a payer.
Once any financial record exists, changed group snapshots fail, even after void or
repayment. An unchanged grandfathered snapshot remains valid.

Missing topology is reconstructed using the indexed structural kinds and three
financial-root existence probes, not a full financial ingestion. At most 1,024
structural rows are replayed; an oversized history returns `TOPOLOGY_REBUILD_LIMIT`
without a partial projection. The new `events.by_pot_kind` index reads existing
payload discriminators and does not require rewriting old event rows. A future or
inconsistent cached schema returns `TOPOLOGY_PROJECTION_INCOMPATIBLE`.

After explicit activation, new schema-1 writes fail with `SCHEMA_DOWNGRADE`, while
exact historical schema-1 retries still return their original sequences. New
expenses/opening balances must use active budget units. Revisions may retain units
already present in that record's revision history; optional `payerMemberId` follows
Core's separate-author/actual-payer and historical-correction rules. Schema-1 payer
attribution and unknown event schema versions are rejected. Existing text sidecar,
redaction, revision, reversal, and conservative Int64 capacity defenses remain.

Ordinary repayment of an inactive historical unit requires proof that its projected
contribution is nonzero. This rare admission path reads at most 2,048 event rows,
reuses the existing financial record-state/revision helper, and evaluates only the
requested inactive units after the durable topology mapping. The transaction-local
states include prior same-batch changes; they are never stored or returned as
balances. An inactive zero unit fails `INACTIVE_UNIT`. An oversized history fails
`HISTORICAL_SETTLEMENT_VALIDATION_LIMIT` rather than guessing zero/nonzero. Flagged
opposite-direction reversals retain their existing record-indexed direction and
cumulative-cap validation; they do not use this full-history predicate. All limits
fail before sequencing, leaving drafts/outbox records available for recovery.

### Budget-group promotion and client handoff

ARS-115 adds an optional typed `budgetGroupPromotion` to `pots:promoteLocalPot`.
Its bounded ordered prefix carries the original owner-binding event ID, expected
starting sequence and erasable member profile inputs. Initial promotion requires
the original person bindings and group activation before dependent money. The
whole mutation rolls back on invalid prerequisites or financial admission. Exact
receipts retain original sequences and do not repeat quota consumption or profile
writes; new structural and financial writes still require current authority. Typed
retries must match the stored initial unit baseline exactly; missing server baseline
metadata is an explicit recovery error, not permission to accept a different prefix.

New pots retain `initialOrderedUnitIds` separately from the append-only known-unit
registry returned by discovery. This is the pre-log reducer configuration, not a
current topology snapshot. Existing local baselines are validated and retained;
fresh schema-2 clients without an explicit baseline fail closed. Do not backfill
this field by copying an already expanded current registry.

Do not enable a schema-2 client writer until reader, local promotion, persistence,
outbox ordering, and presentation support are complete. Upload prerequisite person
bindings before owner group activation, then dependent financial events. Persist
and refresh the topology revision; preserve actual-payer attribution and the Core
schema/history markers. Do not automatically relabel or upgrade stale queued writes.
Handle `TOPOLOGY_REVISION_CONFLICT`, `SCHEMA_DOWNGRADE`, `BUDGET_GROUPS_LOCKED`,
`BUDGET_GROUP_ACTIVATION_REQUIRED`, `OWNER_UNIT_NOT_BOUND`, `INACTIVE_UNIT`, and
`INVALID_PAYER_MEMBER` as explicit reconciliation/entry errors. Preserve queued work
on `TOPOLOGY_REBUILD_LIMIT`, `TOPOLOGY_PROJECTION_INCOMPATIBLE`, and
`HISTORICAL_SETTLEMENT_VALIDATION_LIMIT`; do not busy-retry or pretend a balance is
zero. Larger missing-projection or retired-unit histories need a separately scoped
bounded recovery design, not a hidden unbounded read. These are local source changes:
no deployment, live schema operation, or client release is implied. The app now
explicitly reads through schema 2 and activates it only through completed new
person/group setup. Existing schema-1 ledgers keep their accepted write version.
Group setup uses typed operations; expenses select the actual paying person and
benefiting groups separately. Financial labels use budget-unit ownership while
profile unit IDs and invitation claims remain person-specific. Authorized privacy
refresh continues while a durable write conflict waits for reconciliation.

Active invitation previews expose a bounded, validated minimum reader version.
Per-person claims use that verified target schema; existing pending claim retries
retain their original metadata. Pot-link requests do not author a membership event.
Owner approval and member-administration events use the accepted structural schema,
not the global legacy default, and exact retries retain their original envelopes.

## Runtime configuration names

The shared session boundary requires:

- `NUMA_SHARED_SESSION_ISSUER` — exact HTTPS issuer.
- `NUMA_SHARED_SESSION_AUDIENCE` — exactly `tech.arsik.numashared`.
- `NUMA_SHARED_AUTH_KEY_ID` and `NUMA_SHARED_AUTH_PRIVATE_KEY_PKCS8_PEM` —
  dedicated ES256 signing key, not an Apple key.
- `NUMA_SHARED_AUTH_JWKS_URI` — HTTPS JWKS or a public-only JSON data URI used
  by `auth.config.ts`; never include a private `d` value.
- `NUMA_SHARED_TOKEN_HASH_SECRET` — random secret of at least 32 characters.

The iOS target also defines `NUMA_SHARED_CONVEX_URL` and
`NUMA_SHARED_SITE_URL`. Both build settings are blank by default in P2. The
deterministic scripts inject loopback values only into a Debug test build; the
E2E auth seam and its launch handling are compiled out of Release.

Real Apple exchange additionally requires `SIWA_CLIENT_ID` (the bundle id),
`APPLE_TEAM_ID`, `SIWA_KEY_ID`, `SIWA_PRIVATE_KEY_PKCS8_PEM`,
`NUMA_SHARED_APPLE_REFRESH_ENCRYPTION_KEY` (base64url 32 bytes), and
`NUMA_SHARED_APPLE_REFRESH_ENCRYPTION_KEY_VERSION`. These values belong only in
the approved deployment environment. They are not needed by local sync tests.

## Local deterministic seam

`POST /auth/e2e/bootstrap` exists only when all fail-closed local deployment
markers pass, both Convex runtime URLs are HTTP loopback URLs,
`NUMA_SHARED_E2E_AUTH_ENABLED=1`, and the request's secret matches the
32+-character `NUMA_SHARED_E2E_BOOTSTRAP_SECRET`. It creates a real local
account/session and returns normal access/refresh tokens. Reusing an
`accountKey` creates another session for the same local account. Ephemeral
local setup generates the ES256 key/JWKS, HMAC secret, and bootstrap secret;
it never reads or substitutes a real Sign in with Apple key. A cloud URL or a
missing marker makes the endpoint unavailable.

Account deletion is exposed through the refresh-token-authenticated preview and
delete endpoints documented in `ACCOUNT-DELETION.md`. Starting deletion locks
normal access and refresh before any erasure runs. The action then revokes the
stored Apple authorization, processes text/pots/identity in bounded mutations,
and clears the refresh credential only after the anonymous completion receipt
is durable.

Device sign-out is fail-closed: push-token removal and the idempotent server
session revocation complete before the refresh credential is cleared. A failed
step leaves the local pot and credential available for an explicit retry.
Account deletion persists its retry request before contacting the server and
keeps the refresh credential until both the anonymous server receipt and local
purge are durable. Relaunch resumes the pending request or skips directly to
cleanup from a server-complete marker. The app retires sync, clears every loaded
repository, removes every registered SQLite database and sidecar, atomically
points the registry at one fresh empty store, then clears the credential and
recovery marker.

Backend tests use signed fixtures and mocked Apple HTTP/JWKS responses to prove
cryptographic validation, rotation, replay, timeout, and failure behavior. They
do not prove a real Apple authorization ceremony. Real SIWA remains a signed
physical-device proof at the P3 human interlock.
