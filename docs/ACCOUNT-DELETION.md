# Account deletion

Settings reaches deletion in two actions: load the server preview, then confirm.
The preview names every solo pot that will be deleted and every owner succession.
It also warns about unsynced records that exist only on the current iPhone.

`POST /auth/account/deletion-preview` accepts the cached refresh token and returns
pot outcomes without changing state. `POST /auth/account/delete` accepts that
token, an RFC 9562 UUIDv7 request id, and an iOS-v1 IANA time zone. Both endpoints
are no-store, source-rate-limited, and keep credentials in the JSON body.

Deletion is fail-closed and bounded:

1. Mark the account as deleting so access tokens, refresh, and new Apple sessions
   cannot add data during erasure, including writes using an existing card-sync key.
2. Revoke the encrypted Apple refresh token and record that revocation locally.
3. Delete authored-text sidecars in batches, advancing redaction revisions.
4. Process one membership at a time. Shared pots append an auditable ownership
   transfer when required, append archival, remove the account binding, and retain
   a name-free archived profile. Clients render it as localized `Former member`.
   Pots with no other active member are hard-deleted in dependency-safe batches.
5. Delete sessions/history, relay identity, Apple subject and notifications,
   authorizations, push tokens, quotas, invites/claims, mutes, and the account row.
   The final transaction writes only a 30-day random request receipt, allowing a
   lost HTTP response to retry successfully without retaining an account link.

Before the server call, the app atomically stores the UUIDv7 request id and IANA
time zone in Application Support. It deliberately retains the Keychain refresh
token until the server receipt is durable and every local pot/cache/setup/export
artifact has been purged. A crash before the server-complete marker retries the
same receipt-capable request; a crash after it skips the server and resumes only
local cleanup. After the purge the app clears the credential, removes the
recovery file, creates a fresh accountless identity, and returns to Welcome.
Expo keeps its pending request with the initiating account ID in secure storage.
Recovery refuses a different signed-in account rather than attaching its credential
to saved consent. A same-account rotated credential can retry, and a signed-out
retry can recover an existing server receipt. Local cleanup removes only the
initiating account and never clears a replacement account session. Archived Expo
readers continue applying authorized text erasures even when the active-only
roster rejects them.

Prepared CSV files are invalidated whenever a newer ledger or text revision
arrives, so a stale in-app share link cannot outlive redaction.
