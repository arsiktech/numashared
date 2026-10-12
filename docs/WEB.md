# Web entry and typed invites

The dedicated production Convex HTTP-actions host owns the complete public web
contract. The operator's 2026-08-23 decision supersedes the earlier custom-host
decision: the release origin is `https://adept-camel-457.convex.site`. Marketing,
invite, legal, AASA, and app-config responses are served directly on that origin;
none may redirect through the old custom host.

## Routes

- `GET /` — self-contained Numa Shared marketing page with inline CSS and no script, media, font, or custom-domain dependency.
- `GET /.well-known/apple-app-site-association` — direct JSON AASA response for `/join/*` only.
- `GET /join/<credential>` — generic, non-indexed Open Graph page. It performs no invite lookup, so crawlers receive no pot, member, status, or financial detail.
- `POST /join/<credential>` — deliberate reveal. Browser requests receive a limited HTML result with the human-typable code; clients requesting JSON receive invite status and, only while active, pot name, invite kind, expiry, and a ten-minute signed claim ticket.
- `GET /privacy` — configured controller/privacy notice.
- `GET /support` — configured support address and factual FAQ.
- `GET /app-config` — no-store public configuration containing the optional minimum supported iOS build.

The canonical shared URL is `/join/<long-token>?code=<six-character-code>`. The URL-safe 32–512 character token is the high-entropy link/QR credential; the paired query value lets the no-app page display the independent typed fallback without storing its plaintext. A mismatched or missing pair does not resolve. The code-only `/join/<code>` path remains the guaranteed in-app fallback.

Invite codes are exactly six canonical uppercase ASCII letters/digits when issued. Human entry may contain lowercase, spaces, or hyphens and normalizes before lookup. Tokens are stored as SHA-256 digests; low-entropy codes use a domain-separated HMAC under the deployment secret so a database leak cannot enumerate them offline. Both are globally unique, invite IDs are UUIDv7, and one pending identity can have only one unexpired active per-member invite. Successful issuance is limited to 100 invites/account/day. Preview traffic consumes atomic HMAC buckets: 20 requests/source/minute and 10 requests/credential/minute. Missing trusted request metadata fails closed outside disposable anonymous-local tests.

The short-lived ticket is an HMAC-authenticated bearer proof that the caller presented a valid link or code. It contains no member or financial data and has ten minutes of freshness for creating state. Claim still rechecks kind, active/revoked/consumed state, invite expiry, membership, and owner-approval rules. After freshness or invite expiry, a valid signature can authenticate only a strict same-account replay of an already-stored event or pending claim; it cannot create or change state. Per-member claims accept only event UUID/time/schema metadata; the server supplies the private pot/member identity and returns the stored sequence on an exact retry. A conflicting retry is rejected. A pot-link ticket creates only a pending claim, and an exact retry reuses that pending row.

The release web preflight probes the marketing root and a generic GET invite
without resolving a credential. Deliberate invite POST consumes a privacy-safe
rate-limit bucket, so it belongs to the separately approved production-QA smoke.
On 2026-07-26 the direct production Convex POST probe returned HTTP 503; that
operational route is not release-proven.

## Native join client

The iPhone app accepts the same code-only and long-token URL shapes, but only from the exact HTTPS origin in `NUMA_SHARED_SITE_URL`. It rejects userinfo, ports, fragments, extra path segments, duplicate query values, and foreign hosts. Typed entry normalizes ASCII case, spaces, and hyphens before requiring exactly six letters or digits. Preview is a deliberate no-store JSON `POST`; the claim ticket remains private to the join state machine and is never published into SwiftUI state or error copy.

An active invite is the first point that presents Sign in with Apple. Authentication does not promote the current local pot: the app claims first, verifies that the claimed pot/member appears in the authenticated remote-pot list, then switches and syncs. A per-member retry reuses its client event metadata after an ambiguous server success. A pot-link response remains pending and grants no pot access until owner approval.

The associated-domain entitlement is intentionally not populated while both
Xcode URL settings are blank. The placeholder test host used by unit tests is
not a deployment. For release, set `NUMA_SHARED_SITE_URL` and the exact
`applinks:<selected-host>` entitlement together only after
`scripts/release-web-preflight.mjs` passes on that origin, then prove the signed
installed-app path on a physical iPhone. Do not infer the host from an unrelated
deployment or from test fixtures.

## Fail-closed deployment values

Backend mutations are allowed only on the asserted anonymous-local harness or
when every production marker matches the dedicated target: product
`numa-shared`, class `cloud`, name `adept-camel-457`, cloud URL
`https://adept-camel-457.convex.cloud`, and site URL
`https://adept-camel-457.convex.site`. Missing, mixed, or merely Convex-valid
values fail with `DEPLOYMENT_NOT_APPROVED`. The source contract does not itself
authorize a deployment or production smoke. Every accepted boundary emits one
constant, secret-free project/class receipt before the write. The assertion
also covers internal APNs delivery and invalid-token cleanup, not only
client-callable mutations.

These are public configuration, not credentials, but the final values require the named human/legal decisions before a public deployment:

- `NUMA_SHARED_APP_IDENTIFIER` — exact signed `application-identifier` (`<App ID prefix>.tech.arsik.numashared`), verified from the candidate entitlements rather than inferred from a team label.
- `NUMA_SHARED_APP_STORE_URL` — final `https://apps.apple.com/...` listing URL.
- `NUMA_SHARED_CONTROLLER_NAME`
- `NUMA_SHARED_CONTROLLER_ADDRESS`
- `NUMA_SHARED_PRIVACY_EMAIL`
- `NUMA_SHARED_SUPPORT_EMAIL`
- `NUMA_SHARED_TRANSFER_MECHANISM` — wording approved after the Convex DPA/transfer review.

`NUMA_SHARED_TOKEN_HASH_SECRET` remains a deployment secret and also signs claim tickets and privacy-safe abuse buckets. Missing or malformed configuration returns a sanitized `503`; no placeholder controller, address, email, App Store ID, or transfer mechanism is published.

The iOS target carries the same approved public App Store URL and support email
through `NUMA_SHARED_APP_STORE_URL` and `NUMA_SHARED_SUPPORT_EMAIL`. When the
email is configured, Settings creates a pre-filled message containing only the
app version/build, iOS version, and a new anonymous diagnostic UUID; otherwise
it falls back to the configured HTTPS `/support` page. Unresolved build-setting
placeholders are treated as absent.

The deployment-owned `appConfiguration` document defaults to no build floor.
Its internal, deployment-guarded mutation accepts only positive integer builds.
The client reads `/app-config` without authentication or caching. A floor above
the installed `CFBundleVersion` replaces every app surface with the calm update
screen; the per-pot schema ceiling remains a separate read-only safeguard.

The privacy text implements the data-flow facts frozen in the product contract, but it is not launch-approved until the controller/entity, DSA posture, Convex DPA transfer mechanism, public contacts, and legal wording receive the required human/legal review.

## Local verification

```bash
npm run backend:typecheck
npm run backend:test -- --run
./scripts/convex-local.sh dev --start '/usr/bin/true'
```

Local tests prove the self-contained root, direct AASA shape, generic crawler output, independent long-token and code-only paths, paired-code validation, limited deliberate reveal, expiry/revocation/consumption states, source/credential rate limits, ticket tamper/expiry, idempotent claim retries, both claim forms, the required support FAQ, and fail-closed public-page configuration. The release web preflight additionally checks the exact public origin. An installed-app Universal Link still requires that exact host in the signed entitlement plus the human-operated device smoke.
