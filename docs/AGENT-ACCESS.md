# Agent access (MCP)

A person can let an AI agent (Claude Code, Codex, Cursor, Hermes, Claude, ChatGPT, any MCP
client) act as them in their households. Reading is always allowed. Three switches per
connection decide what else the agent may do:

| Switch (Settings, AI agents) | Tools |
| --- | --- |
| Add expenses and repayments | `add_expense`, `add_repayment` |
| Edit and void records | `edit_record`, `void_record` |
| Manage the household | `rename_household`, `add_person`, `update_groups`, `create_invite` |

New connections start with all three on; the person turns any off at any time, and the server
checks the switch on the agent's next call. Numa Shared never moves money.

**Never available to agents**, whatever the switches say: deleting an account, deleting a
household, leaving a household, removing or archiving a member, transferring ownership. There is
no tool for these and no other path: the write mutation's validator admits only the eight tools
above (`convex/agentWrites.test.ts` checks the list).

## How a person connects an agent

### Copy setup prompt (any agent that takes MCP)

1. Settings, AI agents: **Copy setup prompt**. There is nothing to choose. One tap:
   - makes a secret on the device or in the browser (`nsag_` plus 32 random bytes) and sends
     only its SHA-256 to `agentAccess:connect`, for all households, named `Agent, <date>`, with
     all three switches on (`permissions`). The server makes a connection without `permissions`
     read-only: an app from before writes told the person the access was read-only;
   - copies a plain-text prompt for the agent. A toast confirms it. On a phone the share sheet
     opens instead, which offers Copy.
2. The person pastes the prompt into their agent. The prompt holds the link
   `https://shared.numaworth.com/mcp/<secret>` and one setup line for each harness: Claude
   Code, Codex CLI, Cursor, Hermes Agent and any client that supports Streamable HTTP. It names
   every tool under the switch that allows it, explains minor units and `request_id`, says changes
   show as the person's "via" the agent, tells the agent to keep the link out of its replies and
   in its MCP config only, and to call `list_households` to confirm.
3. The agent appears in Settings, AI agents with its three switches, when it was connected and
   when it was last used. **Disconnect** stops it on its next call. A setup-prompt connection is
   named `Agent, <date>` until the agent's first MCP `initialize`, when it takes the client's
   name (`claude-code` becomes "Claude Code"), once. That name is what the history shows.

The prompt is built in `app/src/features/agents/setupPrompt.ts`, which also records where each
setup line's syntax was checked. On the web the clipboard write starts inside the tap, with the
prompt still on its way, because Safari allows clipboard writes only there. If the clipboard
refuses, the screen shows the prompt once, with **Copy** (web) or **Share** (phone).

For Codex the prompt edits `~/.codex/config.toml` instead of running `codex mcp add --url`.
Codex 0.167 `mcp add` sees that the server also offers OAuth and waits for a browser sign-in,
which a secret link doesn't need.

Clients that can send headers may use `Authorization: Bearer <secret>` on `/mcp` instead, which
keeps the secret out of logs. The path accepts only `nsag_` secrets; OAuth access tokens work
only in the `Authorization` header.

### Add to Claude, Add to ChatGPT (chat apps)

Claude and ChatGPT can't add a connector from a prompt, so they sign in instead:

1. Settings, AI agents, Chat apps: **Add to Claude** or **Add to ChatGPT**. The app copies the
   address `https://shared.numaworth.com/mcp` and opens the app's connector settings, where the
   person pastes it as a custom connector.
2. The agent opens the **Connect to Numa Shared** page (`/connect` in the web app). The page
   names the agent, the households it can read and the address it returns to. It warns when
   that address is on the person's own computer.
3. The signed-in person chooses **Connect** or **Don’t connect**. Connecting covers all their
   households and turns the three switches on (the page says so), whatever scope the agent asked
   for. The browser goes back to the agent.

Each approval is its own connection, with its own tokens and its own **Disconnect**, even for
the same agent. Approving Claude on a second computer never changes what the first one may
read. When the account is at the limit, OAuth connections that can never be used again (code
expired, no live refresh token) are closed to make room.

Connections made by earlier app versions may be limited to one household. They keep working,
and Settings shows **Only <household>** for them. The server still accepts a household on
`agentAccess:connect` and `agentOAuth:approve`; the app no longer sends one.

At most 5 agents can be connected per account. An agent may make 60 calls per minute, of which
at most 20 may change something.

## Authorization (MCP spec revision 2026-07-28)

Numa Shared is both the MCP server (resource server) and its OAuth 2.1 authorization server.
The code is in `convex/agentOAuth.ts` and `convex/lib/oauth.ts`.

| What | Where |
| --- | --- |
| Protected resource metadata (RFC 9728) | `GET /.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` |
| Authorization server metadata (RFC 8414) | `GET /.well-known/oauth-authorization-server` on the deployment's site URL (the issuer) |
| Client registration | Client ID Metadata Documents (an https `client_id` whose JSON we fetch, cache and check) and Dynamic Client Registration, `POST /oauth/register` (RFC 7591) |
| Authorization | `GET /oauth/authorize`: authorization code with PKCE `S256` only. The request is checked, stored and handed to the web app's `/connect` page. |
| Tokens | `POST /oauth/token`: `authorization_code` and `refresh_token` grants |
| Revocation | `POST /oauth/revoke` (RFC 7009). Revoking a refresh token closes the connection. |

- **Scopes**: `shared:read` and `shared:write`. Every approval is granted both, whatever the
  client asked for (a request for `shared:read` alone included), and the token response's
  `scope` says so (RFC 6749 section 3.3). Every new connection starts with every switch on. The
  switches, not the token's scope, decide each call, so the person can turn writes off or on for
  any connection. Tokens and refreshes keep the scope they were granted, so a connection made
  before writes existed keeps `shared:read` and stays read-only until the person switches one
  on. After that, its tokens still say `shared:read` but can write what the switches allow: the
  stored scope records what the agent was granted at approval, not what it may do now. `/mcp`
  does not check the token's scope; only the person can turn a switch on, so this is not an
  escalation. An approval covers all the person's households.
- **Resource indicators** (RFC 8707): tokens are bound to `<origin>/mcp`. The server accepts
  only its own addresses: the site URL and each origin in `NUMA_SHARED_WEB_ORIGINS`.
- **First call**: `/mcp` without a valid token answers `401` with
  `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp", scope="shared:read shared:write"`.
  An expired or revoked token adds `error="invalid_token"`.
- **Redirects**: must match a registered address exactly. Loopback `http` addresses may use
  any port (RFC 8252). Allowed (an allowlist): https, loopback http, `cursor://`, and
  reverse-DNS private-use schemes such as `com.example.app:` (RFC 8252 section 7.1). Other
  schemes, such as `search-ms:` or `ms-msdt:`, are refused. A mismatch shows an error page and
  never redirects.
- **No redirect before consent**: any client can register a redirect address, so every error
  in `/oauth/authorize` (response type, PKCE, scope, resource, state) shows an error page.
  Only the consent page's **Connect** or **Don’t connect** sends the browser back to the
  agent. The authorization response carries `iss` (RFC 9207).
- **Framing**: the web app (`/app/*`, including `/connect`) and the authorization error pages
  send `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`.
- **Lifetimes**: codes last 5 minutes and work once. Using a code again closes the connection
  it opened. Expired codes are deleted when new ones are made. Access tokens last 1 hour.
  Refresh tokens last 30 days and rotate on every use. A used refresh token presented again
  closes the connection (reuse detection). The one exception: a retry of the latest rotation
  within 30 seconds gets the same new pair (RFC 9700). The new pair is derived from the
  presented token with an HMAC under `NUMA_SHARED_TOKEN_HASH_SECRET`, so no plaintext token is
  stored.
- **Stored**: only SHA-256 hashes of codes, tokens, client secrets and consent request ids.
- **No app sessions for agents**: an agent only ever holds these tokens. The consent page
  uses the person's normal session (`requireSession`).
- **Every call** checks the token or secret, the connection (not disconnected), the account
  (not being deleted, Apple authorization not revoked), the household scope, and
  `requireActiveMembership`.

The MCP endpoint answers both protocol eras. Clients that send `initialize` (2025-11-25 and
earlier) get the handshake. Clients on 2026-07-28 send the version in `_meta`, get
`server/discover`, and have `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` checked
against the body. There are no sessions. Each POST carries one JSON-RPC message: batches
(removed from MCP in 2025-06-18) get `400` with error `-32600`, so every tool call counts
against the per-minute limit.

### Addresses

The issuer is the deployment's site URL (`CONVEX_SITE_URL`), so agents reach metadata,
registration and tokens there directly. `https://shared.numaworth.com/mcp` and its metadata are
passed through by the web host Worker (`tools/web-host/worker.js`), which names its origin in
`x-numa-public-origin`. A redirect would drop the `Authorization` header. The consent page
lives at `NUMA_SHARED_WEB_APP_URL/connect`. Loopback `http` is accepted only on the anonymous
local test deployment.

## What the agent can read

`POST /mcp` speaks MCP over Streamable HTTP with JSON answers. Reading tools:

| Tool | Returns |
| --- | --- |
| `list_households` | Households the person belongs to, with currency and role. |
| `list_members` | The people in one household. |
| `get_balances` | Net balance per person or group. Positive means owed money. The amounts add up to zero. |
| `list_records` | Expenses, repayments and opening balances, newest first, with payer and split, the `revision` to pass to `edit_record` and `addedVia` (the agent that added it, if any). Pages with `before_sequence`. |

Each call runs as the connection's account and passes the same membership checks the app
does. A connection limited to one household cannot read another. Archived members,
households being deleted and accounts being deleted are refused. Amounts are returned as
`minorUnits` (integer cents) plus a decimal string. Balances are computed on the server from
the same financial-record state that admits writes (`convex/lib/financialRecordState.ts`).
A household with more than 6,000 financial events is refused as too large for an agent.

## What the agent can change

Writing tools (`convex/agentWrites.ts`, definitions in `convex/lib/agentTools.ts`):

| Tool | Changes | Rules on top of the app's own |
| --- | --- | --- |
| `add_expense` | Adds an expense: amount, payer, split (`equal` between everyone or some, optionally per person; or `exact` shares), title, category, note, date. | Payer must be a person. Shares must add up to the amount. |
| `add_repayment` | Records that one person or group paid another back elsewhere, with method and note. | The two sides must differ. |
| `edit_record` | Changes an expense; only the fields given change. | Needs the `revision` from `list_records`; refused if someone changed the record since, if it is voided, contested, a repayment or an opening balance. A new amount on an unequal split needs the new split. |
| `void_record` | Voids an expense or opening balance, with a reason everyone sees. | Not for repayments or already voided records. |
| `rename_household` | Renames the household. | Owner only (as in the app). |
| `add_person` | Adds someone who hasn't joined yet. | Owner only. |
| `update_groups` | Sets who pays as one group. | Owner only, before any money is recorded, group size by client contract. |
| `create_invite` | Makes a 6-character code and link for one person who hasn't joined, valid 29 days. | Owner only. Refused when that person has a live code unless `replace_existing` is true, which revokes it. |

**Same write path as the app.** Each tool builds the wire events the app builds
(`app/src/sync/mapping.ts`, `engine.ts`) and passes them to the same server functions:
`appendEventsToPot` for money, and the bodies of `members:renamePot`, `addPendingMember`,
`changeBudgetGroups` and `issueInvite`/`revokeInvite` for the household. So event validation, the
text manifest, the currency lock, group limits, revision rules and the
client contract (`lib/clientContract.ts`) apply unchanged, and pushes are queued exactly as for
`events:appendEvents`. The account's hourly write quota (`lib/accountWriteQuota.ts`) applies
where the app's own path applies it: money events, `update_groups` and `create_invite`.
`rename_household` and `add_person` have no account quota, as in the app; for an agent they are
held by the write limit of 20 a minute per connection, at most 5 connections. A refused write
does not count toward that limit (it rolls back with the rest of the call), so an agent retrying
refused writes is held by the general limit of 60 calls a minute. While production still serves Swift build 11, a note, repayment method or
edit reason is not saved, and the tool's answer says so in `warnings`.

**Input.** Amounts are whole minor units (`amount_minor_units: 1250` for 12.50) plus a
`currency` that must be the household's; 12.5, strings with decimals and other currencies are
refused. Unknown arguments are refused. People are `member_id`s (groups may also be `unitId`s)
from `list_members`.

**Idempotency.** Every write takes a `request_id` (8 to 100 characters). A retry with the same
id and the same input answers the first result with `replayed: true` and changes nothing; the
same id with other input is refused. A retry is recognised for 23 hours. An hourly purge
(`convex/crons.ts`, `agentWrites.purgeExpiredRequests`, in batches of 200 that reschedule while
rows are left) deletes each `agentRequests` row within the next hour, so none is older than 24
hours. After that the same id counts as new.
An invite's secrets are not stored: they are derived with an HMAC under
`NUMA_SHARED_TOKEN_HASH_SECRET` from the connection, the request id and the new invite's id (kept
in the stored answer), so a retry shows the same code, and an id used again after 24 hours makes
a new one.

**Dates.** A `date` is placed at noon that day in the resolved zone: the call's `time_zone`, else
the zone of the person's latest phone (push registration), else UTC. That is what the app does in
the phone's zone (`occurredAtFor`), and the event records the same zone as
`originatingTimeZone`. A viewer in that zone sees the date asked for, including UTC+13, UTC+14 and
UTC−11. An edit's new `date` uses the record's own zone.

**Attribution.** The events are appended as the connection's person (their `actorMemberId`, their
account for text authorship and quotas). Each also gets `events.via`, the connection's name at
that moment. `events:listEvents` returns it next to `recordedAtMillis`, outside the event
envelope, so it is not part of the text manifest or replay comparison, and older readers (Swift
build 11 decodes `HydratedWireEventV1` with fixed keys) ignore it, as they ignore
`recordedAtMillis`. The Expo app shows "Ana via Claude" in history lines, bubbles, repayment cards, the
record detail and the CSV export. Swift build 11 and push notifications show only the person's
name; the consent page and the privacy policy say "recent versions of the app" for that reason.

**Refusals** come back as tool errors (`isError: true`) with a sentence the agent can act on. A
switch that is off is named: `Refused: the "Add expenses and repayments" switch is off for this
agent.` The activity list records the tool and answered or refused, nothing else.

**Safety is on the server.** Tool descriptions mention what each changes and that Numa Shared
never moves money, and the instructions tell the agent to change only what the person asked
for. None of that is relied on: switches, scope, membership, ownership and the never-list are
enforced in `agentWrites.write` on every call.

## What is stored

- `agentConnections`: account, name, optional household, the three switches (absent on
  connections made before writes, which stay read-only until switched), timestamps, call and write
  counters. A secret link adds its key hash and the first 9 characters of the secret. An OAuth
  grant adds its client id.
- `agentRequests`: per write, the connection, the agent's `request_id`, the tool, a hash of the
  input and the answer, so a retry gets the same answer. The answer holds ids and can hold what
  the write recorded: an expense's amount and split, a new household name, a new person's name.
  Deleted by the hourly purge, at most 24 hours after the write. No invite secrets.
- `events.via`: the connection name on events an agent appended. It stays with the household's
  history.
- `agentActivity`: connection, tool name, answered or refused, timestamp. No amounts, names or
  error text. Entries older than 90 days are dropped.
- `oauthClients`: registered and metadata-document clients (name, redirect addresses). No
  personal data. Registrations nobody approved are dropped after 30 days.
- `oauthRequests`: consent requests waiting on the page, for 10 minutes. No account.
- `oauthCodes`, `oauthTokens`: hashes, with the account, connection, resource and expiry.

Account deletion (`convex/accountDeletion.ts`) erases tokens, codes, connections, activity and
agent requests. `events.via` stays on the household's history, like the event itself; it names
the agent, not the person.
It also erases each registered client that only the departing account had connected.

## Before this ships

- Production Convex deploy (new tables and routes; the schema change is additive).
- Deploy the web host Worker so `shared.numaworth.com/mcp` and its metadata reach the backend.
- Check that `NUMA_SHARED_WEB_APP_URL` is set on production. The consent page needs it.
- The privacy policy page and `PRIVACY.md` describe agent access, writes included. The page
  goes live with the next production Convex deploy. Recommended App Store and Google Play
  answers are in `PRIVACY-LABELS.md`; they are not submitted.
- Check Settings, AI agents and the consent page on a device, and connect real Claude,
  ChatGPT, Claude Code, Codex, Cursor and Hermes clients against production.
- The setup prompt's link uses `shared.numaworth.com/mcp/<secret>`, so it needs the web host
  Worker deployed first.
- Shared balances into Numa Pro is separate work.
