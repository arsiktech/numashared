# Device privacy

`Hide amounts` is a device-local preference stored in the app's standard user
defaults under `privacy.hideAmounts`. It is never written to the ledger or sync
transport. Every rendered financial value flows through the app formatter and
uses the fixed currency placeholder when the preference is enabled.

The root surface and every app-owned sheet or full-screen cover install the
same scene-phase shield. When the scene is inactive or backgrounded, the shield
replaces financial content with a neutral Numa Shared surface before iOS takes
the app-switcher snapshot. It does not add Face ID or another authentication
boundary; those remain outside v1 scope.

Account deletion is separate from this device-only display preference. Its
server and local erasure boundaries, retained shared arithmetic, attribution
anonymization, and retry behavior are specified in `ACCOUNT-DELETION.md`.

# AI agent access

The privacy policy (`privacyHTML` in `convex/lib/webContent.ts`, served at
`/privacy`) has a section, "AI agents you connect". It must match the code.
`AGENT-ACCESS.md` has the technical detail. The policy says:

- **Who decides**: the person connects an agent. They approve it on the consent
  page (`app/src/app/connect.tsx`) or copy a setup prompt (a secret link) in
  Settings, AI agents. A new connection covers all their households, resolved
  on every call, so it includes households joined later (`convex/agentData.ts`,
  `households`).
- **What the agent reads** (`convex/agentData.ts`): household names and
  currency, member names and roles, balances, and records. Records include
  titles, categories, notes, void reasons, amounts, dates, payer and split.
- **What the agent changes** (`convex/agentWrites.ts`, tools in
  `convex/lib/agentTools.ts`): under three switches the person controls, it adds
  expenses and repayments, edits and voids records, and manages the household
  (rename, add a person, groups, invite codes). Every new connection starts with
  all three on, whatever OAuth scope the agent asked for. Connections made
  before writes existed have no switches stored and stay read-only until
  switched on. No tool deletes the account, deletes or leaves a household, or
  removes a member. Numa Shared never moves money.
- **Acts as the person**: writes go through the app's write path as the person,
  with their membership and ownership checks. Each event stores the agent's
  name in `events.via`; the Expo app shows "<name> via <agent>" to every member.
  Swift build 11 and push notifications show only the name, so the consent text
  and the policy say "recent versions of the Numa Shared app".
- **Who receives it**: the provider of the agent the person chose, at the
  person's instruction. That provider is not a Numa Shared processor; its own
  terms apply. Records include other members' text, so the policy asks people
  to connect only households whose records they are entitled to share.
- **What Numa Shared keeps** (`convex/schema.ts`):
  - `agentConnections`: name, switches, timestamps and call counters. A secret
    link adds its hash and first 9 characters.
  - `oauthCodes` and `oauthTokens`: hashes only.
  - `oauthClients`: the agent's registered name and return addresses.
  - `agentActivity`: the tool name, answered or refused, and the time. No
    amounts, names or results.
  - `agentRequests`: the agent's request id, the tool, a hash of the input and
    the answer, for at most 24 hours. The answer can hold an amount, a split or a name,
    so the policy says so.
- **Retention**: codes last 5 minutes, access tokens 1 hour and refresh tokens
  30 days. Activity older than 90 days is removed lazily: each new call deletes
  at most the account's oldest entry if it is past 90 days
  (`agentAccess.record`). The policy says "as your agents make new calls" for
  that reason. Do not change it to a fixed deadline unless a scheduled purge is
  added. Request rows stop answering retries after 23 hours, and an hourly
  scheduled purge (`convex/crons.ts`) deletes them within the next hour, so
  none is kept longer than 24 hours; the policy says "for at most 24 hours". Disconnect (`agentAccess.disconnect`) marks the connection closed and
  deletes its OAuth tokens. The connection row stays until account deletion.
- **Deletion**: account deletion (`convex/accountDeletion.ts`) erases
  connections, tokens, codes, activity, request rows, and each registered client
  only that account used. `events.via` stays on the shared history; it names the
  agent, not the person. Numa Shared cannot erase what a provider already
  received.

When an agent tool, a switch, a stored field or a lifetime changes, update the
policy, its date and the assertions in `convex/web.test.ts` in the same change.
Store label guidance is in `PRIVACY-LABELS.md`.
