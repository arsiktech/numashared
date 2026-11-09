# Agent access (read-only MCP)

A person can let an AI agent (Claude, ChatGPT, Cursor, any MCP client) read their
households. This is **read only**: an agent cannot add, change or delete anything, and
Numa Shared never moves money.

## How a person connects an agent

The normal way takes one step and no secrets:

1. Settings, AI agents: **Add to Claude**, **Add to ChatGPT** or **Add to Cursor**.
   - Claude and ChatGPT: the app copies the address `https://shared.numaworth.com/mcp` and
     opens the agent's connector settings, where the person pastes it as a custom connector.
   - Cursor: the app opens a `cursor://anysphere.cursor-deeplink/mcp/install` link that
     carries the address, and Cursor offers to install it.
   - Any other agent: copy the address from the same screen.
2. The agent opens the **Connect to Numa Shared** page (`/connect` in the web app). The page
   names the agent and the address it returns to. It warns when that address is on the
   person's own computer.
3. The signed-in person picks **All my households** or **Only** one household, then
   **Connect** or **Don’t connect**. The browser goes back to the agent.
4. The agent appears under **Connected** with its scope and when it was last used.
   **Disconnect** stops it on its next call.

Approving the same agent again reuses its connection and updates what it may read.

### Terminal agents (secret link)

Under **Advanced: terminal agents**, a person can still make a secret link for an agent that
cannot open a sign-in page. The phone makes the secret (`nsag_` plus 32 random bytes) and
sends only its SHA-256 to `agentAccess:connect`. The link `https://<site>/mcp/<secret>` is
shown once. Clients that support headers can send `Authorization: Bearer <secret>` to `/mcp`
instead, which keeps the secret out of logs.

At most 5 agents can be connected per account. An agent may make 60 calls per minute.

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

- **Scope**: one scope, `shared:read`. The household choice is made on the consent page.
- **Resource indicators** (RFC 8707): tokens are bound to `<origin>/mcp`. The server accepts
  only its own addresses: the site URL and each origin in `NUMA_SHARED_WEB_ORIGINS`.
- **First call**: `/mcp` without a valid token answers `401` with
  `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp", scope="shared:read"`.
  An expired or revoked token adds `error="invalid_token"`.
- **Redirects**: must match a registered address exactly. Loopback `http` addresses may use
  any port (RFC 8252). Allowed schemes are https, loopback http and app schemes such as
  `cursor://`. A mismatch shows an error page and never redirects. The authorization
  response carries `iss` (RFC 9207).
- **Lifetimes**: codes last 5 minutes and work once. Using a code again closes the connection
  it opened. Access tokens last 1 hour. Refresh tokens last 30 days and rotate on every use.
  A used refresh token presented again closes the connection (reuse detection).
- **Stored**: only SHA-256 hashes of codes, tokens, client secrets and consent request ids.
- **No app sessions for agents**: an agent only ever holds these tokens. The consent page
  uses the person's normal session (`requireSession`).
- **Every call** checks the token or secret, the connection (not disconnected), the account
  (not being deleted, Apple authorization not revoked), the household scope, and
  `requireActiveMembership`.

The MCP endpoint answers both protocol eras. Clients that send `initialize` (2025-11-25 and
earlier) get the handshake. Clients on 2026-07-28 send the version in `_meta`, get
`server/discover`, and have `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` checked
against the body. There are no sessions.

### Addresses

The issuer is the deployment's site URL (`CONVEX_SITE_URL`), so agents reach metadata,
registration and tokens there directly. `https://shared.numaworth.com/mcp` and its metadata are
passed through by the web host Worker (`tools/web-host/worker.js`), which names its origin in
`x-numa-public-origin`. A redirect would drop the `Authorization` header. The consent page
lives at `NUMA_SHARED_WEB_APP_URL/connect`. Loopback `http` is accepted only on the anonymous
local test deployment.

## What the agent can read

`POST /mcp` speaks MCP over Streamable HTTP with JSON answers. Tools, all read-only:

| Tool | Returns |
| --- | --- |
| `list_households` | Households the person belongs to, with currency and role. |
| `list_members` | The people in one household. |
| `get_balances` | Net balance per person or group. Positive means owed money. The amounts add up to zero. |
| `list_records` | Expenses, repayments and opening balances, newest first, with payer and split. Pages with `before_sequence`. |

Each call runs as the connection's account and passes the same membership checks the app
does. A connection limited to one household cannot read another. Archived members,
households being deleted and accounts being deleted are refused. Amounts are returned as
`minorUnits` (integer cents) plus a decimal string. Balances are computed on the server from
the same financial-record state that admits writes (`convex/lib/financialRecordState.ts`).
A household with more than 6,000 financial events is refused as too large for an agent.

## What is stored

- `agentConnections`: account, name, optional household, timestamps, call counter. A secret
  link adds its key hash and the first 9 characters of the secret. An OAuth grant adds its
  client id.
- `agentActivity`: connection, tool name, answered or refused, timestamp. No amounts, names or
  error text. Entries older than 90 days are dropped.
- `oauthClients`: registered and metadata-document clients (name, redirect addresses). No
  personal data. Registrations nobody approved are dropped after 30 days.
- `oauthRequests`: consent requests waiting on the page, for 10 minutes. No account.
- `oauthCodes`, `oauthTokens`: hashes, with the account, connection, resource and expiry.

Account deletion (`convex/accountDeletion.ts`) erases tokens, codes, connections and activity.
It also erases each registered client that only the departing account had connected.

## Before this ships

- Production Convex deploy (new tables and routes; the schema change is additive).
- Deploy the web host Worker so `shared.numaworth.com/mcp` and its metadata reach the backend.
- Check that `NUMA_SHARED_WEB_APP_URL` is set on production. The consent page needs it.
- Update `PRIVACY.md`, the privacy policy page and App Privacy answers: data the person
  chooses to hand to a third-party agent leaves Numa Shared at their instruction.
- Check Settings, AI agents and the consent page on a device, and connect real Claude,
  ChatGPT and Cursor clients against production.
- Writes through reviewed proposals, and Shared balances into Numa Pro, are separate work.
