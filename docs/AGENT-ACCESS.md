# Agent access (read-only MCP)

A person can let an AI agent (Claude Code, Codex, Cursor, Hermes, Claude, ChatGPT, any MCP
client) read their households. This is **read only**: an agent cannot add, change or delete anything, and
Numa Shared never moves money.

## How a person connects an agent

### Copy setup prompt (any agent that takes MCP)

1. Settings, AI agents: **Copy setup prompt**. There is nothing to choose. One tap:
   - makes a secret on the device or in the browser (`nsag_` plus 32 random bytes) and sends
     only its SHA-256 to `agentAccess:connect`, for all households, named `Agent, <date>`;
   - copies a plain-text prompt for the agent. A toast confirms it. On a phone the share sheet
     opens instead, which offers Copy.
2. The person pastes the prompt into their agent. The prompt holds the link
   `https://shared.numaworth.com/mcp/<secret>` and one setup line for each harness: Claude
   Code, Codex CLI, Cursor, Hermes Agent and any client that supports Streamable HTTP. It names
   the four tools, says the access is read-only, tells the agent to keep the link out of its
   replies and in its MCP config only, and to call `list_households` to confirm.
3. The agent appears under **Connected** with when it was connected and when it was last used.
   **Disconnect** stops it on its next call.

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
   households. The browser goes back to the agent.

Each approval is its own connection, with its own tokens and its own **Disconnect**, even for
the same agent. Approving Claude on a second computer never changes what the first one may
read. When the account is at the limit, OAuth connections that can never be used again (code
expired, no live refresh token) are closed to make room.

Connections made by earlier app versions may be limited to one household. They keep working,
and Settings shows **Only <household>** for them. The server still accepts a household on
`agentAccess:connect` and `agentOAuth:approve`; the app no longer sends one.

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

- **Scope**: one scope, `shared:read`. An approval covers all the person's households.
- **Resource indicators** (RFC 8707): tokens are bound to `<origin>/mcp`. The server accepts
  only its own addresses: the site URL and each origin in `NUMA_SHARED_WEB_ORIGINS`.
- **First call**: `/mcp` without a valid token answers `401` with
  `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp", scope="shared:read"`.
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
  ChatGPT, Claude Code, Codex, Cursor and Hermes clients against production.
- The setup prompt's link uses `shared.numaworth.com/mcp/<secret>`, so it needs the web host
  Worker deployed first.
- Writes through reviewed proposals, and Shared balances into Numa Pro, are separate work.
