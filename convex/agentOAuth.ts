// One-step agent connection: MCP authorization (OAuth 2.1 with PKCE), spec revision 2026-07-28.
//
// 1. The person pastes the MCP address (https://shared.numaworth.com/mcp) into Claude, ChatGPT or
//    Cursor. The agent's first call gets 401 with a pointer to the protected resource metadata,
//    which names this deployment as the authorization server.
// 2. The agent registers (Dynamic Client Registration) or presents an https client id whose
//    metadata document we fetch (Client ID Metadata Document), then opens /oauth/authorize.
// 3. /oauth/authorize checks the client, the exact redirect address and PKCE, stores the request
//    and sends the browser to the web app's "Connect to Numa Shared" page (/connect). A bad
//    request gets an error page: nothing redirects to the agent before the person has consented.
// 4. The signed-in person approves (or declines). Approval covers all their households; the
//    page asks nothing else. The server still accepts one household, for older app versions.
//    Each approval makes a new agentConnections row and a one-time code; the browser returns to
//    the agent.
// 5. The agent swaps the code (with its PKCE verifier) for a one-hour access token and a refresh
//    token. Refresh tokens rotate; a used one presented again closes the connection, unless it is
//    a retry of the latest rotation within 30 seconds.
//
// Agents only ever get these tokens, never an app session. Every MCP call still checks the
// connection, the account and household membership (convex/agentAccess.ts, convex/agentData.ts).
// Only hashes of codes, tokens, client secrets and request ids are stored.
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  action,
  httpAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { accountIsUsable, closeConnection, maximumAgents } from "./agentAccess";
import { fail, requireActiveMembership, requireSession } from "./lib/access";
import { requireApprovedWriteTarget } from "./lib/deployment";
import { sha256Hex } from "./lib/hash";
import { consumePrivacySafeRateLimits, trustedRequestSource } from "./lib/httpRateLimit";
import * as oauth from "./lib/oauth";

declare const process: { env: Record<string, string | undefined> };

// ---------- HTTP helpers ----------

// Metadata, registration, token and revocation are called by agents, sometimes from a browser.
// They take no cookies, so any origin may call them.
const openCors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "Authorization, Content-Type, MCP-Protocol-Version",
  "access-control-max-age": "600",
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...openCors, ...extra },
  });
}

const oauthError = (error: string, description: string, status = 400) =>
  json({ error, error_description: description }, status);

const escapeHTML = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A plain page for an authorization request that cannot be sent back to the agent. */
function page(status: number, title: string, message: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHTML(title)} · Numa Shared</title><style>body{margin:0;font:17px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#fbfaf6;color:#1e2420}
main{max-width:34rem;margin:0 auto;padding:18vh 22px 48px}h1{font-size:1.8rem;line-height:1.15;margin:0 0 .6rem}p{color:#595d56;margin:0}
@media (prefers-color-scheme:dark){body{background:#121512;color:#eef0e6}p{color:#adb1a6}}</style></head>
<body><main><h1>${escapeHTML(title)}</h1><p>${escapeHTML(message)}</p></main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy": "frame-ancestors 'none'",
      "x-frame-options": "DENY",
    },
  });
}

/**
 * Counts a call against a per-source bucket. Fails closed when the source or secret is missing.
 * Hosted agents (ChatGPT, Claude) register and swap tokens from a few shared server addresses,
 * so those limits are generous; the consent step is per person and stays tight.
 */
async function overLimit(ctx: ActionCtx, request: Request, namespace: string, limit: bigint, windowMillis: number) {
  const secret = process.env.NUMA_SHARED_TOKEN_HASH_SECRET;
  if (!secret) return true;
  let source: string;
  try { source = await trustedRequestSource(ctx, request); } catch { return true; }
  const result = await consumePrivacySafeRateLimits(ctx, secret, [{ namespace, value: source, limit, windowMillis }], Date.now());
  return !result.allowed;
}

async function readForm(request: Request): Promise<URLSearchParams | null> {
  const type = request.headers.get("content-type") ?? "";
  try {
    const text = await request.text();
    if (text.length > 8_000) return null;
    if (type.includes("application/json")) {
      const body = JSON.parse(text) as Record<string, unknown>;
      if (!body || typeof body !== "object") return null;
      return new URLSearchParams(Object.entries(body).filter(([, v]) => typeof v === "string") as Array<[string, string]>);
    }
    return new URLSearchParams(text);
  } catch {
    return null;
  }
}

/** client_secret_basic, client_secret_post or a public client id in the form. */
function clientCredentials(request: Request, form: URLSearchParams): { clientId: string; secret?: string } | null {
  const basic = request.headers.get("authorization")?.match(/^Basic\s+(\S+)$/i)?.[1];
  if (basic) {
    try {
      const [id, secret] = atob(basic).split(":").map((part) => decodeURIComponent(part));
      if (id && secret) return { clientId: id, secret };
    } catch { /* fall through */ }
    return null;
  }
  const clientId = form.get("client_id");
  if (!clientId || clientId.length > 300) return null;
  const secret = form.get("client_secret") ?? undefined;
  return secret ? { clientId, secret } : { clientId };
}

// ---------- Metadata ----------

export const preflight = httpAction(async () => new Response(null, { status: 204, headers: openCors }));

/** RFC 9728, at /.well-known/oauth-protected-resource and /.well-known/oauth-protected-resource/mcp. */
export const protectedResource = httpAction(async (_ctx, request) =>
  json(oauth.protectedResourceMetadata(process.env, oauth.requestOrigin(process.env, request)), 200, {
    "cache-control": "public, max-age=300",
    vary: oauth.PUBLIC_ORIGIN_HEADER,
  }));

/** RFC 8414, at /.well-known/oauth-authorization-server. */
export const authorizationServer = httpAction(async () =>
  json(oauth.authorizationServerMetadata(process.env), 200, { "cache-control": "public, max-age=300" }));

// ---------- Clients ----------

type ClientView = Pick<Doc<"oauthClients">, "clientId" | "kind" | "name" | "redirectUris" | "secretHash">;

export const clientById = internalQuery({
  args: { clientId: v.string() },
  handler: async (ctx, { clientId }) => await ctx.db.query("oauthClients")
    .withIndex("by_client_id", (q) => q.eq("clientId", clientId))
    .unique(),
});

/** Saves a client from Dynamic Client Registration, and drops old registrations nobody approved. */
export const storeClient = internalMutation({
  args: {
    clientId: v.string(),
    name: v.string(),
    redirectUris: v.array(v.string()),
    clientUri: v.optional(v.string()),
    secretHash: v.optional(v.string()),
    now: v.number(),
  },
  handler: async (ctx, { now, ...client }) => {
    requireApprovedWriteTarget();
    await ctx.db.insert("oauthClients", { ...client, kind: "registered", createdAt: now });
    const stale = await ctx.db.query("oauthClients")
      .withIndex("by_created", (q) => q.eq("kind", "registered").lt("createdAt", now - 30 * 24 * 3_600_000))
      .take(10);
    for (const row of stale) {
      const used = await ctx.db.query("agentConnections").withIndex("by_client", (q) => q.eq("clientId", row.clientId)).first();
      if (!used) await ctx.db.delete(row._id);
    }
    return null;
  },
});

/** Caches a client's fetched metadata document. */
export const cacheMetadataClient = internalMutation({
  args: { clientId: v.string(), name: v.string(), redirectUris: v.array(v.string()), clientUri: v.optional(v.string()), now: v.number(), expiresAt: v.number() },
  handler: async (ctx, { now, ...client }) => {
    requireApprovedWriteTarget();
    const existing = await ctx.db.query("oauthClients").withIndex("by_client_id", (q) => q.eq("clientId", client.clientId)).unique();
    if (existing) {
      if (existing.kind !== "metadata") fail("OAUTH_CLIENT_CONFLICT");
      await ctx.db.replace(existing._id, { ...client, kind: "metadata", createdAt: existing.createdAt });
    } else {
      await ctx.db.insert("oauthClients", { ...client, kind: "metadata", createdAt: now });
    }
    return null;
  },
});

/** RFC 7591 Dynamic Client Registration. Kept for agents that do not use metadata documents. */
export const register = httpAction(async (ctx, request) => {
  if (await overLimit(ctx, request, "oauth-register", 300n, 3_600_000)) {
    return oauthError("temporarily_unavailable", "Too many registrations from here. Try again later.", 429);
  }
  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > 8_000) return oauthError("invalid_client_metadata", "The registration is too large.");
    body = JSON.parse(text);
  } catch {
    return oauthError("invalid_client_metadata", "Send the client metadata as JSON.");
  }
  const parsed = oauth.parseRegistration(body);
  if (!parsed.ok) return oauthError(parsed.error, parsed.description);
  const client = parsed.value;
  const clientId = oauth.randomSecret("nsc", 18);
  const secret = client.authMethod === "none" ? undefined : oauth.randomSecret("nscs");
  const now = Date.now();
  await ctx.runMutation(internal.agentOAuth.storeClient, {
    clientId,
    name: client.name,
    redirectUris: client.redirectUris,
    ...(client.clientUri ? { clientUri: client.clientUri } : {}),
    ...(secret ? { secretHash: await sha256Hex(secret) } : {}),
    now,
  });
  return json({
    client_id: clientId,
    client_id_issued_at: Math.floor(now / 1_000),
    client_name: client.name,
    redirect_uris: client.redirectUris,
    grant_types: client.grantTypes,
    response_types: ["code"],
    token_endpoint_auth_method: client.authMethod,
    scope: oauth.OAUTH_SCOPE,
    ...(client.clientUri ? { client_uri: client.clientUri } : {}),
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
  }, 201);
});

/** A registered client, or a metadata-document client (fetched now when not cached). */
async function resolveClient(ctx: ActionCtx, clientId: string):
  Promise<{ ok: true; client: ClientView } | { ok: false; description: string }> {
  const stored = await ctx.runQuery(internal.agentOAuth.clientById, { clientId });
  if (stored && (stored.kind === "registered" || (stored.expiresAt ?? 0) > Date.now())) return { ok: true, client: stored };
  if (!oauth.isMetadataClientId(clientId)) {
    return { ok: false, description: "This agent is not registered with Numa Shared. Remove it from your agent and add it again." };
  }
  let response: Response;
  try {
    response = await fetch(clientId, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return { ok: false, description: "Numa Shared could not read this agent's details. Try again in a moment." };
  }
  if (!response.ok) return { ok: false, description: "Numa Shared could not read this agent's details." };
  let document: unknown;
  try {
    const text = await response.text();
    if (text.length > 20_000) return { ok: false, description: "This agent's details are too large." };
    document = JSON.parse(text);
  } catch {
    return { ok: false, description: "This agent's details are not valid." };
  }
  const parsed = oauth.parseClientMetadataDocument(clientId, document);
  if (!parsed.ok) return { ok: false, description: parsed.description };
  const now = Date.now();
  const client = {
    clientId,
    name: parsed.value.name,
    redirectUris: parsed.value.redirectUris,
    ...(parsed.value.clientUri ? { clientUri: parsed.value.clientUri } : {}),
  };
  await ctx.runMutation(internal.agentOAuth.cacheMetadataClient, {
    ...client,
    now,
    expiresAt: now + oauth.metadataCacheMillis(response.headers.get("cache-control")),
  });
  return { ok: true, client: { ...client, kind: "metadata", secretHash: undefined } };
}

// ---------- Authorization ----------

export const createRequest = internalMutation({
  args: {
    requestHash: v.string(),
    clientId: v.string(),
    redirectUri: v.string(),
    state: v.optional(v.string()),
    codeChallenge: v.string(),
    resource: v.string(),
    scope: v.string(),
    issuer: v.string(),
    now: v.number(),
  },
  handler: async (ctx, { now, ...request }) => {
    requireApprovedWriteTarget();
    await ctx.db.insert("oauthRequests", { ...request, createdAt: now, expiresAt: now + oauth.REQUEST_MILLIS });
    const expired = await ctx.db.query("oauthRequests").withIndex("by_expires_at", (q) => q.lt("expiresAt", now)).take(20);
    for (const row of expired) await ctx.db.delete(row._id);
    return null;
  },
});

/** GET /oauth/authorize: checks the request, then hands the person to the consent page. */
export const authorize = httpAction(async (ctx, request) => {
  const params = new URL(request.url).searchParams;
  const env = process.env;
  const issuer = oauth.issuerOf(env);
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  if (!clientId || clientId.length > 300) {
    return page(400, "This link can't connect an agent", "The agent didn't say who it is. Start again from your agent.");
  }
  if (await overLimit(ctx, request, "oauth-authorize", 30n, 60_000)) {
    return page(429, "Too many attempts", "Wait a minute, then start again from your agent.");
  }
  const resolved = await resolveClient(ctx, clientId);
  if (!resolved.ok) return page(400, "This link can't connect an agent", resolved.description);
  if (!redirectUri || !oauth.redirectUriAllowed(redirectUri) || !oauth.redirectMatches(resolved.client.redirectUris, redirectUri)) {
    return page(400, "This link can't connect an agent", "The agent asked to return to an address it didn't register. Start again from your agent.");
  }
  // Any client can register a redirect address, so nothing sends the browser there before the
  // person has seen the consent page: a bad request gets this page, never a redirect.
  const refuse = (message: string) => page(400, "This link can't connect an agent", `${message} Start again from your agent.`);
  const state = params.get("state") ?? undefined;
  if (state !== undefined && state.length > 500) return refuse("The agent's request is too long.");
  if (params.get("response_type") !== "code") return refuse("The agent asked for a kind of access Numa Shared doesn't offer.");
  const challenge = params.get("code_challenge") ?? "";
  if (params.get("code_challenge_method") !== "S256" || !oauth.validCodeChallenge(challenge)) {
    return refuse("The agent didn't send the security check (PKCE with S256) that Numa Shared requires.");
  }
  if (!oauth.scopeAccepted(params.get("scope"))) return refuse("The agent asked for access Numa Shared doesn't offer.");
  const requested = params.get("resource");
  const resource = requested ? oauth.matchResource(env, requested) : oauth.resourceOf(oauth.siteOrigin(env));
  if (!resource) return refuse("The agent asked for access to another server.");
  const web = oauth.webAppURL(env);
  if (!web) return page(503, "Connecting agents isn't available", "Try again later.");

  const requestId = oauth.randomSecret("nsar");
  await ctx.runMutation(internal.agentOAuth.createRequest, {
    requestHash: await sha256Hex(requestId),
    clientId,
    redirectUri,
    ...(state === undefined ? {} : { state }),
    codeChallenge: challenge,
    resource,
    scope: oauth.OAUTH_SCOPE,
    issuer,
    now: Date.now(),
  });
  return new Response(null, {
    status: 302,
    headers: {
      location: `${web}/connect?request=${encodeURIComponent(requestId)}`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
});

async function findRequest(ctx: QueryCtx | MutationCtx, requestId: string, now: number): Promise<Doc<"oauthRequests"> | null> {
  if (!/^nsar_[A-Za-z0-9_-]{20,80}$/.test(requestId)) return null;
  const requestHash = await sha256Hex(requestId);
  const row = await ctx.db.query("oauthRequests").withIndex("by_request_hash", (q) => q.eq("requestHash", requestHash)).unique();
  return row && row.expiresAt > now ? row : null;
}

/** What the consent page shows: which agent is asking and where the person goes back to. */
export const describeRequest = query({
  args: { request: v.string() },
  handler: async (ctx, { request }) => {
    const row = await findRequest(ctx, request, Date.now());
    if (!row) return { status: "expired" as const };
    const client = await ctx.db.query("oauthClients").withIndex("by_client_id", (q) => q.eq("clientId", row.clientId)).unique();
    if (!client) return { status: "expired" as const };
    return {
      status: "pending" as const,
      agent: client.name,
      // A metadata client's id is an https address it controls, so its host is a checked name.
      verifiedHost: client.kind === "metadata" ? oauth.hostOf(client.clientId) : null,
      returnsTo: oauth.redirectLabel(row.redirectUri),
      returnsToThisComputer: oauth.isLoopbackRedirect(row.redirectUri),
    };
  },
});

/** The households the signed-in person can let an agent read. */
export const myHouseholds = query({
  args: {},
  handler: async (ctx) => {
    const { account } = await requireSession(ctx);
    const memberships = await ctx.db.query("potMembers")
      .withIndex("by_account_status", (q) => q.eq("accountId", account._id).eq("status", "active"))
      .take(50);
    const result: Array<{ id: string; name: string | null }> = [];
    for (const membership of memberships) {
      const pot = await ctx.db.query("pots").withIndex("by_pot_id", (q) => q.eq("potId", membership.potId)).unique();
      if (pot && pot.deletingAt === undefined) result.push({ id: pot.potId, name: pot.name ?? null });
    }
    return result;
  },
});

/**
 * An OAuth connection that can never be used again: its code has expired and it holds no unused,
 * unexpired refresh token. Secret links are never abandoned.
 */
async function abandoned(ctx: MutationCtx, connection: Doc<"agentConnections">, now: number): Promise<boolean> {
  if (connection.clientId === undefined || connection.createdAt > now - oauth.CODE_MILLIS) return false;
  const live = await ctx.db.query("oauthTokens")
    .withIndex("by_connection", (q) => q.eq("connectionId", connection._id).gt("expiresAt", now))
    .filter((q) => q.and(q.eq(q.field("kind"), "refresh"), q.eq(q.field("usedAt"), undefined)))
    .first();
  return live === null;
}

export const approveRequest = internalMutation({
  args: { request: v.string(), potId: v.union(v.string(), v.null()), codeHash: v.string(), now: v.number() },
  handler: async (ctx, args) => {
    requireApprovedWriteTarget();
    const { account } = await requireSession(ctx);
    const row = await findRequest(ctx, args.request, args.now);
    if (!row) fail("AGENT_REQUEST_EXPIRED");
    const client = await ctx.db.query("oauthClients").withIndex("by_client_id", (q) => q.eq("clientId", row.clientId)).unique();
    if (!client) fail("AGENT_REQUEST_EXPIRED");
    if (args.potId !== null) await requireActiveMembership(ctx, args.potId, account._id);

    // Each approval is its own connection, with its own tokens and its own Disconnect. A metadata
    // client id is shared by every installation of an agent, so approving Claude on a second
    // computer must not change what the first one may read.
    const mine = await ctx.db.query("agentConnections").withIndex("by_account", (q) => q.eq("accountId", account._id)).collect();
    let active = mine.filter((c) => c.revokedAt === undefined);
    if (active.length >= maximumAgents) {
      // An agent that lost its tokens connects again with a new approval. Its old connection can
      // never be used again, so it should not take a place.
      for (const connection of active) {
        if (await abandoned(ctx, connection, args.now)) await closeConnection(ctx, connection._id, args.now);
      }
      active = (await ctx.db.query("agentConnections").withIndex("by_account", (q) => q.eq("accountId", account._id)).collect())
        .filter((c) => c.revokedAt === undefined);
    }
    if (active.length >= maximumAgents) fail("TOO_MANY_AGENTS");
    const connectionId = await ctx.db.insert("agentConnections", {
      accountId: account._id,
      name: client.name,
      clientId: row.clientId,
      ...(args.potId === null ? {} : { potId: args.potId }),
      createdAt: args.now,
      windowStartedAt: args.now,
      windowCount: 0,
    });
    // Codes are kept until they expire, so a replay within their lifetime is still caught.
    const expiredCodes = await ctx.db.query("oauthCodes").withIndex("by_expires_at", (q) => q.lt("expiresAt", args.now)).take(20);
    for (const code of expiredCodes) await ctx.db.delete(code._id);
    await ctx.db.insert("oauthCodes", {
      codeHash: args.codeHash,
      accountId: account._id,
      connectionId,
      clientId: row.clientId,
      redirectUri: row.redirectUri,
      codeChallenge: row.codeChallenge,
      resource: row.resource,
      scope: row.scope,
      expiresAt: args.now + oauth.CODE_MILLIS,
    });
    await ctx.db.delete(row._id);
    return { redirectUri: row.redirectUri, state: row.state ?? null, issuer: row.issuer };
  },
});

/**
 * Approves the request as the signed-in person; returns where the browser goes next. Without
 * `household` (the consent page today) the agent reads all their households. A household id,
 * sent by older app versions, limits it to that one.
 */
export const approve = action({
  args: { request: v.string(), household: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args): Promise<{ redirectTo: string }> => {
    const code = oauth.randomSecret("nsac");
    const back: { redirectUri: string; state: string | null; issuer: string } = await ctx.runMutation(internal.agentOAuth.approveRequest, {
      request: args.request,
      potId: args.household ?? null,
      codeHash: await sha256Hex(code),
      now: Date.now(),
    });
    return { redirectTo: oauth.withQuery(back.redirectUri, { code, state: back.state ?? undefined, iss: back.issuer }) };
  },
});

/** Declines the request; the agent hears access_denied. Needs no sign-in. */
export const deny = mutation({
  args: { request: v.string() },
  handler: async (ctx, { request }) => {
    requireApprovedWriteTarget();
    const row = await findRequest(ctx, request, Date.now());
    if (!row) return { redirectTo: null };
    await ctx.db.delete(row._id);
    return {
      redirectTo: oauth.withQuery(row.redirectUri, {
        error: "access_denied",
        error_description: "The person declined to connect this agent.",
        state: row.state,
        iss: row.issuer,
      }),
    };
  },
});

// ---------- Tokens ----------

type Grant = { ok: true } | { ok: false; error: string; description: string };
const refused = (error: string, description: string): Grant => ({ ok: false, error, description });

async function issueTokens(
  ctx: MutationCtx,
  base: { accountId: Id<"accounts">; connectionId: Id<"agentConnections">; clientId: string; resource: string; scope: string },
  accessHash: string,
  refreshHash: string,
  now: number,
) {
  const grant = { accountId: base.accountId, connectionId: base.connectionId, clientId: base.clientId, resource: base.resource, scope: base.scope };
  await ctx.db.insert("oauthTokens", { ...grant, tokenHash: accessHash, kind: "access", createdAt: now, expiresAt: now + oauth.ACCESS_TOKEN_SECONDS * 1_000 });
  await ctx.db.insert("oauthTokens", { ...grant, tokenHash: refreshHash, kind: "refresh", createdAt: now, expiresAt: now + oauth.REFRESH_TOKEN_MILLIS });
  await ctx.db.patch(base.connectionId, { lastUsedAt: now });
  // Drop this connection's expired tokens a few at a time.
  const expired = await ctx.db.query("oauthTokens")
    .withIndex("by_connection", (q) => q.eq("connectionId", base.connectionId).lt("expiresAt", now))
    .take(20);
  for (const row of expired) await ctx.db.delete(row._id);
}

async function connectionUsable(ctx: MutationCtx, connectionId: Id<"agentConnections">): Promise<boolean> {
  const connection = await ctx.db.get(connectionId);
  return Boolean(connection && connection.revokedAt === undefined && await accountIsUsable(ctx, connection.accountId));
}

export const redeemCode = internalMutation({
  args: {
    codeHash: v.string(),
    clientId: v.string(),
    redirectUri: v.optional(v.string()),
    challenge: v.string(),
    resource: v.optional(v.string()),
    accessHash: v.string(),
    refreshHash: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args): Promise<Grant> => {
    requireApprovedWriteTarget();
    const code = await ctx.db.query("oauthCodes").withIndex("by_code_hash", (q) => q.eq("codeHash", args.codeHash)).unique();
    if (!code) return refused("invalid_grant", "The code is not valid.");
    if (code.usedAt !== undefined) {
      // A code used twice may have been stolen: close what it opened.
      await closeConnection(ctx, code.connectionId, args.now);
      return refused("invalid_grant", "The code was already used.");
    }
    if (code.expiresAt <= args.now || code.clientId !== args.clientId
      || (args.redirectUri !== undefined && args.redirectUri !== code.redirectUri)) {
      await ctx.db.delete(code._id);
      return refused("invalid_grant", "The code is not valid for this client.");
    }
    if (args.challenge !== code.codeChallenge) {
      await ctx.db.delete(code._id);
      return refused("invalid_grant", "PKCE verification failed.");
    }
    if (args.resource !== undefined && args.resource !== code.resource) {
      return refused("invalid_target", "The code was issued for another resource.");
    }
    if (!(await connectionUsable(ctx, code.connectionId))) {
      await ctx.db.delete(code._id);
      return refused("invalid_grant", "This connection is closed.");
    }
    await ctx.db.patch(code._id, { usedAt: args.now });
    await issueTokens(ctx, code, args.accessHash, args.refreshHash, args.now);
    return { ok: true };
  },
});

export const rotateRefresh = internalMutation({
  args: {
    refreshTokenHash: v.string(),
    clientId: v.string(),
    resource: v.optional(v.string()),
    accessHash: v.string(),
    refreshHash: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args): Promise<Grant> => {
    requireApprovedWriteTarget();
    const row = await ctx.db.query("oauthTokens").withIndex("by_token_hash", (q) => q.eq("tokenHash", args.refreshTokenHash)).unique();
    if (!row || row.kind !== "refresh" || row.clientId !== args.clientId) return refused("invalid_grant", "The refresh token is not valid.");
    if (args.resource !== undefined && args.resource !== row.resource) {
      return refused("invalid_target", "The refresh token was issued for another resource.");
    }
    if (row.usedAt !== undefined) {
      // A client that retries a refresh (a timeout, or two refreshes at once) presents the same
      // token again. Within the grace window, and only while what it was rotated into is still
      // unused, it gets that same pair back: the token endpoint derives the pair from the
      // presented token, so the hashes match.
      if (args.now - row.usedAt <= oauth.REFRESH_GRACE_MILLIS && row.replacedBy === args.refreshHash) {
        const next = await ctx.db.query("oauthTokens").withIndex("by_token_hash", (q) => q.eq("tokenHash", args.refreshHash)).unique();
        if (next && next.usedAt === undefined && await connectionUsable(ctx, row.connectionId)) return { ok: true };
      }
      // Refresh tokens are single use. Seeing one again means two parties hold it: close the connection.
      await closeConnection(ctx, row.connectionId, args.now);
      return refused("invalid_grant", "This refresh token was already used, so the connection was closed. Connect again.");
    }
    if (row.expiresAt <= args.now) return refused("invalid_grant", "The refresh token expired. Connect again.");
    if (!(await connectionUsable(ctx, row.connectionId))) return refused("invalid_grant", "This connection is closed.");
    await ctx.db.patch(row._id, { usedAt: args.now, replacedBy: args.refreshHash });
    await issueTokens(ctx, row, args.accessHash, args.refreshHash, args.now);
    return { ok: true };
  },
});

/** POST /oauth/token: authorization_code (with PKCE) and refresh_token grants. */
export const token = httpAction(async (ctx, request) => {
  const form = await readForm(request);
  if (!form) return oauthError("invalid_request", "Send the token request as a form.");
  const credentials = clientCredentials(request, form);
  if (!credentials) return oauthError("invalid_client", "client_id is required.", 401);
  if (await overLimit(ctx, request, "oauth-token", 600n, 60_000)) {
    return oauthError("temporarily_unavailable", "Too many token requests. Wait a minute.", 429);
  }
  const client = await ctx.runQuery(internal.agentOAuth.clientById, { clientId: credentials.clientId });
  if (!client) return oauthError("invalid_client", "Unknown client.", 401);
  if (client.secretHash !== undefined
    && (!credentials.secret || await sha256Hex(credentials.secret) !== client.secretHash)) {
    return oauthError("invalid_client", "Client authentication failed.", 401);
  }
  const requested = form.get("resource");
  let resource: string | undefined;
  if (requested) {
    resource = oauth.matchResource(process.env, requested) ?? undefined;
    if (!resource) return oauthError("invalid_target", "This server issues tokens only for its own MCP address.");
  }
  const now = Date.now();
  const grantType = form.get("grant_type");
  const presented = grantType === "refresh_token" ? form.get("refresh_token") : null;
  if (grantType === "refresh_token" && (!presented || presented.length > 200)) {
    return oauthError("invalid_request", "refresh_token is required.");
  }
  // A refresh rotates into a pair derived from the presented token (HMAC with a server secret),
  // so a retry of the same refresh gets the same pair. A code gets a random pair.
  const secret = process.env.NUMA_SHARED_TOKEN_HASH_SECRET;
  if (presented && !secret) return oauthError("temporarily_unavailable", "Try again later.", 503);
  const access = presented ? await oauth.rotatedSecret(secret!, "nsat", presented) : oauth.randomSecret("nsat");
  const refresh = presented ? await oauth.rotatedSecret(secret!, "nsrt", presented) : oauth.randomSecret("nsrt");
  const hashes = { accessHash: await sha256Hex(access), refreshHash: await sha256Hex(refresh) };
  let result: Grant;
  if (grantType === "authorization_code") {
    const code = form.get("code");
    const verifier = form.get("code_verifier");
    if (!code || code.length > 200) return oauthError("invalid_request", "code is required.");
    if (!verifier || !oauth.validCodeVerifier(verifier)) return oauthError("invalid_grant", "A valid code_verifier is required (PKCE).");
    const redirectUri = form.get("redirect_uri");
    result = await ctx.runMutation(internal.agentOAuth.redeemCode, {
      codeHash: await sha256Hex(code),
      clientId: client.clientId,
      ...(redirectUri ? { redirectUri } : {}),
      challenge: await oauth.s256(verifier),
      ...(resource ? { resource } : {}),
      ...hashes,
      now,
    });
  } else if (presented) {
    result = await ctx.runMutation(internal.agentOAuth.rotateRefresh, {
      refreshTokenHash: await sha256Hex(presented),
      clientId: client.clientId,
      ...(resource ? { resource } : {}),
      ...hashes,
      now,
    });
  } else {
    return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
  }
  if (!result.ok) return oauthError(result.error, result.description);
  return json({
    access_token: access,
    token_type: "Bearer",
    expires_in: oauth.ACCESS_TOKEN_SECONDS,
    refresh_token: refresh,
    scope: oauth.OAUTH_SCOPE,
  });
});

export const revokeToken = internalMutation({
  args: { tokenHash: v.string(), clientId: v.string() },
  handler: async (ctx, { tokenHash, clientId }) => {
    requireApprovedWriteTarget();
    const row = await ctx.db.query("oauthTokens").withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash)).unique();
    if (!row || row.clientId !== clientId) return null;
    if (row.kind === "refresh") await closeConnection(ctx, row.connectionId, Date.now());
    else await ctx.db.delete(row._id);
    return null;
  },
});

/** POST /oauth/revoke (RFC 7009). Revoking a refresh token closes the connection. */
export const revoke = httpAction(async (ctx, request) => {
  const form = await readForm(request);
  const credentials = form && clientCredentials(request, form);
  const presented = form?.get("token");
  if (!form || !credentials || !presented || presented.length > 200) return oauthError("invalid_request", "token and client_id are required.");
  const client = await ctx.runQuery(internal.agentOAuth.clientById, { clientId: credentials.clientId });
  if (!client) return oauthError("invalid_client", "Unknown client.", 401);
  if (client.secretHash !== undefined
    && (!credentials.secret || await sha256Hex(credentials.secret) !== client.secretHash)) {
    return oauthError("invalid_client", "Client authentication failed.", 401);
  }
  await ctx.runMutation(internal.agentOAuth.revokeToken, { tokenHash: await sha256Hex(presented), clientId: client.clientId });
  return new Response(null, { status: 200, headers: { "cache-control": "no-store", ...openCors } });
});

// ---------- Account deletion ----------

/**
 * One batch of erasing a departing account's agent connections that came through OAuth: their
 * tokens and codes, and each registered client nobody else connected. Returns true when it
 * deleted something (call again), false when nothing is left for this step.
 */
export async function eraseAgentOAuthBatch(ctx: MutationCtx, accountId: Id<"accounts">): Promise<boolean> {
  for (const table of ["oauthTokens", "oauthCodes"] as const) {
    const rows = await ctx.db.query(table).withIndex("by_account", (q) => q.eq("accountId", accountId)).take(100);
    if (rows.length > 0) {
      for (const row of rows) await ctx.db.delete(row._id);
      return true;
    }
  }
  const connections = (await ctx.db.query("agentConnections")
    .withIndex("by_account", (q) => q.eq("accountId", accountId))
    .take(100)).filter((row) => row.clientId !== undefined);
  for (const connection of connections) {
    const clientId = connection.clientId!;
    const users = await ctx.db.query("agentConnections").withIndex("by_client", (q) => q.eq("clientId", clientId)).take(50);
    if (users.every((row) => row.accountId === accountId)) {
      const client = await ctx.db.query("oauthClients").withIndex("by_client_id", (q) => q.eq("clientId", clientId)).unique();
      if (client) await ctx.db.delete(client._id);
    }
    await ctx.db.delete(connection._id);
  }
  return connections.length > 0;
}
