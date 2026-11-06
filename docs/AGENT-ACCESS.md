# Agent access (read-only MCP)

A person can let an AI agent (Claude, ChatGPT, Cursor, any MCP client) read their
households. This is phase 1: **read only**. An agent cannot add, change or delete
anything, and Numa Shared never moves money.

## How a person connects an agent

1. Settings, AI agents, Connect an agent. The person names the agent and picks
   "All my households" or "Only <this household>".
2. The phone makes a random secret (`nsag_` plus 32 random bytes, base64url) and
   sends only its SHA-256 to `agentAccess:connect`. The server never sees the secret.
3. The phone shows the link `https://<site>/mcp/<secret>` once. The person pastes it
   into their agent as an MCP server. Clients that support headers can instead call
   `/mcp` with `Authorization: Bearer <secret>`, which keeps the secret out of logs.
4. Disconnect in the same screen. The secret stops working on the next call.

At most 5 agents can be connected per account. An agent may make 60 calls per minute.

## What the agent can read

`POST /mcp` speaks MCP over Streamable HTTP with JSON answers. Tools, all read-only:

| Tool | Returns |
| --- | --- |
| `list_households` | Households the person belongs to, with currency and role. |
| `list_members` | The people in one household. |
| `get_balances` | Net balance per person or group. Positive means owed money. The amounts add up to zero. |
| `list_records` | Expenses, repayments and opening balances, newest first, with payer and split. Pages with `before_sequence`. |

Each call runs as the connection's account and passes the same membership checks the
app does. A connection limited to one household cannot read another. Archived members,
households being deleted and accounts being deleted are refused. Amounts are returned
as `minorUnits` (integer cents) plus a decimal string. Balances are computed on the
server from the same financial-record state that admits writes
(`convex/lib/financialRecordState.ts`), so voided and revised records are handled the
same way. A household with more than 6,000 financial events is refused as too large
for an agent.

## What is stored

- `agentConnections`: account, name, key hash, first 9 characters of the secret (to
  tell agents apart), optional household, timestamps, call counter.
- `agentActivity`: connection, tool name, ok or refused, timestamp. No amounts or
  names. Entries older than 90 days are dropped.

Both tables are erased by account deletion (`accountSweep` in
`convex/accountDeletion.ts`).

## Before this ships

- Production Convex deploy (the tables and routes are new; the schema change is additive).
- Update `PRIVACY.md`, the privacy policy page and App Privacy answers: data the
  person chooses to hand to a third-party agent leaves Numa Shared at their instruction.
- Physical-device check of the Settings screen and a real MCP client session.
- Phase 2 (writes through reviewed proposals with idempotent request ids) and
  phase 3 (Shared balances into Numa Pro capital) are separate work.
