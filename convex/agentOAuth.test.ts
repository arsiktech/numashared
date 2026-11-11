/// <reference types="vite/client" />
// One-step agent connection: MCP authorization with OAuth 2.1 and PKCE (convex/agentOAuth.ts).
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { tokenDeleteBatchesPerRun } from "./agentAccess";
import { redirectUriAllowed, s256 } from "./lib/oauth";
import schema from "./schema";
import { modules } from "./test.setup";

type Tester = ReturnType<typeof convexTest>;

const SITE = "http://127.0.0.1:3211";
const WEB = "http://127.0.0.1:8081";
const BRANDED = "https://shared.example.test";
const RESOURCE = `${SITE}/mcp`;
const POT = "pot-casa-mar-000000000001";
const OTHER_POT = "pot-someone-else-0000000001";
const REDIRECT = "http://127.0.0.1:33418/callback";

beforeEach(() => {
  vi.stubEnv("NUMA_SHARED_PRODUCT", "numa-shared");
  vi.stubEnv("NUMA_SHARED_DEPLOYMENT_CLASS", "anonymous-local");
  vi.stubEnv("NUMA_SHARED_DEPLOYMENT_NAME", "anonymous-agent-test");
  vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3210");
  vi.stubEnv("CONVEX_SITE_URL", SITE);
  vi.stubEnv("NUMA_SHARED_SESSION_ISSUER", "https://auth.numa.shared");
  vi.stubEnv("NUMA_SHARED_SESSION_AUDIENCE", "tech.arsik.numashared");
  vi.stubEnv("NUMA_SHARED_TOKEN_HASH_SECRET", "test-token-hash-secret-0123456789abcdefghijk");
  vi.stubEnv("NUMA_SHARED_WEB_APP_URL", WEB);
  vi.stubEnv("NUMA_SHARED_WEB_ORIGINS", BRANDED);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function identity(t: Tester, who: "alice" | "bob") {
  return t.withIdentity({
    issuer: "https://auth.numa.shared",
    subject: `account-${who}-0000000001`,
    sid: `session-${who}-000000001`,
    numa_session_audience: "tech.arsik.numashared",
    token_use: "access",
  });
}

/** Alice and Bob share Casa Mar; Bob alone has a second household. One expense in Casa Mar. */
async function seed(t: Tester): Promise<{ alice: Id<"accounts">; bob: Id<"accounts"> }> {
  return await t.run(async (ctx) => {
    const account = async (who: string) => {
      const id = await ctx.db.insert("accounts", { publicAccountId: `account-${who}-0000000001`, appleSubjectHash: `apple-${who}`, createdAt: 1 });
      await ctx.db.insert("sessions", {
        sessionId: `session-${who}-000000001`, accountId: id, refreshTokenHash: `refresh-${who}`,
        expiresAt: Date.now() + 86_400_000, createdAt: 1, rotatedAt: 1,
      });
      return id;
    };
    const alice = await account("alice");
    const bob = await account("bob");
    const pot = (potId: string, owner: Id<"accounts">, name: string) => ctx.db.insert("pots", {
      potId, currencyCode: "EUR", currencyExponent: 2n, orderedUnitIds: ["unit-alice", "unit-bob"], ownerAccountId: owner, name,
      minimumReaderSchemaVersion: 1n, nextSequence: 2n, nextTextRevision: 1n, positiveContributionBudget: 0n, negativeContributionBudget: 0n, createdAt: 1,
    });
    await pot(POT, alice, "Casa Mar");
    await pot(OTHER_POT, bob, "Bob's flat");
    const member = (potId: string, accountId: Id<"accounts">, memberId: string, role: "owner" | "member") =>
      ctx.db.insert("potMembers", { potId, accountId, memberId, role, status: "active", joinedAt: 1 });
    await member(POT, alice, "member-alice", "owner");
    await member(POT, bob, "member-bob", "member");
    await member(OTHER_POT, bob, "member-bob", "owner");
    for (const [potId, memberId, unitId, name, role] of [
      [POT, "member-alice", "unit-alice", "Alice", "owner"],
      [POT, "member-bob", "unit-bob", "Bob", "member"],
      [OTHER_POT, "member-bob", "unit-bob", "Bob", "owner"],
    ] as const) {
      await ctx.db.insert("potMemberProfiles", { potId, memberId, unitId, displayName: name, role, state: "active", createdAt: 1, updatedAt: 1 });
    }
    const money = (minorUnits: bigint) => ({ minorUnits, currency: { code: "EUR", exponent: 2n } });
    await ctx.db.insert("events", {
      potId: POT, eventId: "event-1-00000000000000", recordId: "record-groceries-0000000001", actorMemberId: "member-alice",
      occurredAtMillis: 1_760_000_000_000n, originatingTimeZone: "Europe/Madrid", schemaVersion: 1n, sequence: 1n,
      payload: {
        kind: "expenseAdded", recordId: "record-groceries-0000000001",
        content: { expenseKind: "shared", amount: money(10_000n), payerUnitId: "unit-alice",
          allocations: [{ unitId: "unit-alice", amount: money(5_000n) }, { unitId: "unit-bob", amount: money(5_000n) }] },
      } as never,
      textFields: [], createdAt: 1,
    });
    return { alice, bob };
  });
}

async function body(response: Response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function register(t: Tester, extra: Record<string, unknown> = {}) {
  const response = await t.fetch("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude Code", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", ...extra }),
  });
  return { status: response.status, body: await body(response) };
}

function pkce() {
  const verifier = `verifier-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  return { verifier, challenge: s256(verifier) };
}

async function authorize(t: Tester, clientId: string, challenge: string, extra: Record<string, string> = {}) {
  const query = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge,
    code_challenge_method: "S256", state: "state-123", resource: RESOURCE, scope: "shared:read", ...extra,
  });
  return await t.fetch(`/oauth/authorize?${query}`, { method: "GET" });
}

const requestIdOf = (location: string) => new URL(location).searchParams.get("request")!;

async function tokenRequest(t: Tester, form: Record<string, string>, headers: Record<string, string> = {}) {
  const response = await t.fetch("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(form).toString(),
  });
  return { status: response.status, body: await body(response) };
}

/**
 * Registers a client, approves it as `who` and swaps the code for tokens. With no household, as
 * the consent page sends it, the approval covers all households; older apps may name one.
 */
async function connect(t: Tester, who: "alice" | "bob", household?: string | null) {
  const client = (await register(t)).body;
  const { verifier, challenge } = pkce();
  const started = await authorize(t, client.client_id, await challenge);
  const request = requestIdOf(started.headers.get("location")!);
  const approved = await identity(t, who).action(api.agentOAuth.approve, household === undefined ? { request } : { request, household });
  const code = new URL(approved.redirectTo).searchParams.get("code")!;
  const tokens = await tokenRequest(t, {
    grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT, resource: RESOURCE,
  });
  expect(tokens.status).toBe(200);
  return { clientId: client.client_id as string, access: tokens.body.access_token as string, refresh: tokens.body.refresh_token as string };
}

async function mcp(t: Tester, access: string, method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const response = await t.fetch("/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${access}`, "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: response.status, headers: response.headers, body: await body(response) };
}

const callTool = (t: Tester, access: string, name: string, args: Record<string, unknown> = {}) =>
  mcp(t, access, "tools/call", { name, arguments: args });

describe("Agent connection with OAuth (MCP authorization)", () => {
  test("publishes protected resource and authorization server metadata", async () => {
    const t = convexTest(schema, modules);
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const prm = await t.fetch(path, { method: "GET" });
      expect(prm.status).toBe(200);
      expect(prm.headers.get("access-control-allow-origin")).toBe("*");
      expect(await body(prm)).toMatchObject({ resource: RESOURCE, authorization_servers: [SITE], scopes_supported: ["shared:read", "shared:write"] });
    }
    const branded = await body(await t.fetch("/.well-known/oauth-protected-resource/mcp", { method: "GET", headers: { "x-numa-public-origin": BRANDED } }));
    expect(branded.resource).toBe(`${BRANDED}/mcp`);
    const unlisted = await body(await t.fetch("/.well-known/oauth-protected-resource", { method: "GET", headers: { "x-numa-public-origin": "https://evil.example" } }));
    expect(unlisted.resource).toBe(RESOURCE);

    const as = await body(await t.fetch("/.well-known/oauth-authorization-server", { method: "GET" }));
    expect(as).toMatchObject({
      issuer: SITE,
      authorization_endpoint: `${SITE}/oauth/authorize`,
      token_endpoint: `${SITE}/oauth/token`,
      registration_endpoint: `${SITE}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });

    const unauthenticated = await t.fetch("/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${SITE}/.well-known/oauth-protected-resource/mcp", scope="shared:read shared:write"`,
    );
    const preflight = await t.fetch("/mcp", { method: "OPTIONS", headers: { origin: "https://claude.ai" } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-expose-headers")).toMatch(/WWW-Authenticate/);
    expect((await t.fetch("/mcp", { method: "POST", headers: { origin: "http://evil.example" }, body: "{}" })).status).toBe(403);
  });

  test("registers clients dynamically and rejects unsafe redirect addresses", async () => {
    const t = convexTest(schema, modules);
    const ok = await register(t);
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ client_name: "Claude Code", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" });
    expect(ok.body.client_id).toMatch(/^nsc_/);
    expect(ok.body.client_secret).toBeUndefined();

    for (const redirect of ["http://evil.example/callback", "javascript:alert(1)", "https://ok.example/cb#frag"]) {
      const bad = await register(t, { redirect_uris: [redirect] });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toBe("invalid_redirect_uri");
    }
    expect((await register(t, { redirect_uris: ["cursor://anysphere.cursor-mcp/oauth/callback"] })).status).toBe(201);
    expect((await register(t, { redirect_uris: ["com.example.agent:/oauth/callback"] })).status).toBe(201);
    expect((await register(t, { grant_types: ["client_credentials"] })).body.error).toBe("invalid_client_metadata");

    const confidential = await register(t, { token_endpoint_auth_method: "client_secret_post" });
    expect(confidential.body.client_secret).toMatch(/^nscs_/);
    const stored = await t.run(async (ctx) => await ctx.db.query("oauthClients").collect());
    expect(JSON.stringify(stored)).not.toContain(confidential.body.client_secret);
    const refused = await tokenRequest(t, { grant_type: "refresh_token", refresh_token: "nsrt_x", client_id: confidential.body.client_id });
    expect(refused.status).toBe(401);
    expect(refused.body.error).toBe("invalid_client");
  });

  test("connects in one step: authorize, consent, code, tokens, then all four tools", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const client = (await register(t)).body;
    const { verifier, challenge } = pkce();
    const started = await authorize(t, client.client_id, await challenge);
    expect(started.status).toBe(302);
    const location = started.headers.get("location")!;
    expect(location.startsWith(`${WEB}/connect?request=nsar_`)).toBe(true);

    const request = requestIdOf(location);
    expect(await t.query(api.agentOAuth.describeRequest, { request })).toEqual({
      status: "pending", agent: "Claude Code", verifiedHost: null, returnsTo: "127.0.0.1:33418", returnsToThisComputer: true,
    });
    expect((await identity(t, "alice").query(api.agentOAuth.myHouseholds, {})).map((h) => h.name)).toEqual(["Casa Mar"]);
    await expect(t.action(api.agentOAuth.approve, { request, household: null })).rejects.toThrow(/AUTH_REQUIRED/);

    const approved = await identity(t, "alice").action(api.agentOAuth.approve, { request, household: null });
    const back = new URL(approved.redirectTo);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe("state-123");
    expect(back.searchParams.get("iss")).toBe(SITE);
    const code = back.searchParams.get("code")!;
    expect(code).toMatch(/^nsac_/);
    expect(await t.query(api.agentOAuth.describeRequest, { request })).toEqual({ status: "expired" });

    const tokens = await tokenRequest(t, { grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT, resource: RESOURCE });
    expect(tokens.status).toBe(200);
    // The request named only shared:read; the grant is both, and the response says so.
    expect(tokens.body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "shared:read shared:write" });
    expect(tokens.body.access_token).toMatch(/^nsat_/);
    expect(tokens.body.refresh_token).toMatch(/^nsrt_/);
    const stored = JSON.stringify(await t.run(async (ctx) => [...await ctx.db.query("oauthTokens").collect(), ...await ctx.db.query("oauthCodes").collect()]));
    expect(stored).not.toContain(tokens.body.access_token);
    expect(stored).not.toContain(tokens.body.refresh_token);
    expect(stored).not.toContain(code);

    const access = tokens.body.access_token as string;
    const households = (await callTool(t, access, "list_households")).body.result.structuredContent;
    expect(households.result.map((h: { householdId: string }) => h.householdId)).toEqual([POT]);
    expect((await callTool(t, access, "list_members", { household: POT })).body.result.isError).toBeUndefined();
    const balances = (await callTool(t, access, "get_balances", { household: POT })).body.result.structuredContent;
    expect(balances.units.map((u: { label: string; amount: string }) => [u.label, u.amount])).toEqual([["Alice", "50.00"], ["Bob", "-50.00"]]);
    expect((await callTool(t, access, "list_records", { household: POT })).body.result.structuredContent.records).toHaveLength(1);

    const [connection] = await identity(t, "alice").query(api.agentAccess.listMine, {});
    expect(connection).toMatchObject({ name: "Claude Code", kind: "oauth", potId: null });
    expect(connection!.lastUsedAt).not.toBeNull();
    const activity = await identity(t, "alice").query(api.agentAccess.recentActivity, {});
    expect(activity.map((a) => [a.tool, a.ok])).toEqual([["list_records", true], ["get_balances", true], ["list_members", true], ["list_households", true]]);
    expect(JSON.stringify(activity)).not.toMatch(/Alice|Bob|50\.00|error/);
  });

  test("requires PKCE with S256 and refuses a wrong verifier", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const client = (await register(t)).body;
    const { challenge } = pkce();

    // A bad request shows an error page; it is never sent back to the agent before consent.
    const missing = await authorize(t, client.client_id, "");
    expect(missing.status).toBe(400);
    expect(missing.headers.get("location")).toBeNull();
    expect(await missing.text()).toMatch(/PKCE/);
    const plain = await authorize(t, client.client_id, await challenge, { code_challenge_method: "plain" });
    expect(plain.status).toBe(400);
    expect(plain.headers.get("location")).toBeNull();

    const started = await authorize(t, client.client_id, await challenge);
    const approved = await identity(t, "alice").action(api.agentOAuth.approve, { request: requestIdOf(started.headers.get("location")!), household: null });
    const code = new URL(approved.redirectTo).searchParams.get("code")!;
    const wrong = await tokenRequest(t, { grant_type: "authorization_code", code, code_verifier: pkce().verifier, client_id: client.client_id });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toMatchObject({ error: "invalid_grant", error_description: "PKCE verification failed." });
    const noVerifier = await tokenRequest(t, { grant_type: "authorization_code", code, client_id: client.client_id });
    expect(noVerifier.body.error).toBe("invalid_grant");
  });

  test("never redirects to an address the client did not register, or for another resource", async () => {
    const t = convexTest(schema, modules);
    const client = (await register(t)).body;
    const { challenge } = pkce();
    const foreign = await authorize(t, client.client_id, await challenge, { redirect_uri: "https://evil.example/callback" });
    expect(foreign.status).toBe(400);
    expect(foreign.headers.get("location")).toBeNull();
    expect(await foreign.text()).toMatch(/didn&#39;t register/);
    const unknown = await authorize(t, "nsc_not_registered", await challenge);
    expect(unknown.status).toBe(400);
    const otherPort = await authorize(t, client.client_id, await challenge, { redirect_uri: "http://127.0.0.1:50000/callback" });
    expect(otherPort.status).toBe(302); // loopback redirects may use any port (RFC 8252)
    const otherServer = await authorize(t, client.client_id, await challenge, { resource: "https://other.example/mcp" });
    expect(otherServer.status).toBe(400);
    expect(otherServer.headers.get("location")).toBeNull();
  });

  test("review P5: a bad request never auto-redirects before consent, and OS handler schemes cannot be registered", async () => {
    const t = convexTest(schema, modules);
    const client = (await register(t, { redirect_uris: ["https://phish.example/landing"] })).body;
    const cases: Array<Record<string, string>> = [
      { response_type: "token" },
      { code_challenge_method: "plain" },
      { scope: "admin" },
      { resource: "https://other.example/mcp" },
      { state: "x".repeat(501) },
    ];
    for (const extra of cases) {
      const query = new URLSearchParams({
        response_type: "code", client_id: client.client_id, redirect_uri: "https://phish.example/landing",
        code_challenge: "a".repeat(43), code_challenge_method: "S256", ...extra,
      });
      const response = await t.fetch(`/oauth/authorize?${query}`, { method: "GET" });
      expect([JSON.stringify(extra), response.status]).toEqual([JSON.stringify(extra), 400]);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
    }
    for (const uri of ["search-ms:query=x&crumb=location:%5C%5Cevil%5Cshare", "ms-msdt:/id x", "ms-officecmd:x", "intent://x#Intent;end", "vscode://x/cb", "ftp://x/cb", "http://evil.example/cb"]) {
      expect([uri, redirectUriAllowed(uri)]).toEqual([uri, false]);
      expect((await register(t, { redirect_uris: [uri] })).body.error).toBe("invalid_redirect_uri");
    }
    // The agents we support keep working: Claude, ChatGPT, Claude Code, Cursor, MCP Inspector, native apps.
    for (const uri of [
      "https://claude.ai/api/mcp/auth_callback",
      "https://chatgpt.com/connector_platform_oauth_redirect",
      "http://127.0.0.1:33418/callback",
      "http://localhost:6274/oauth/callback",
      "http://[::1]:8080/callback",
      "cursor://anysphere.cursor-mcp/oauth/callback",
      "com.example.agent:/oauth2redirect",
    ]) {
      expect([uri, redirectUriAllowed(uri)]).toEqual([uri, true]);
    }
  });

  test("declining sends access_denied back and closes the request", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const client = (await register(t)).body;
    const started = await authorize(t, client.client_id, await pkce().challenge);
    const request = requestIdOf(started.headers.get("location")!);
    const denied = await t.mutation(api.agentOAuth.deny, { request });
    const back = new URL(denied.redirectTo!);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe("state-123");
    expect(back.searchParams.get("iss")).toBe(SITE);
    await expect(identity(t, "alice").action(api.agentOAuth.approve, { request, household: null })).rejects.toThrow(/AGENT_REQUEST_EXPIRED/);
    expect(await identity(t, "alice").query(api.agentAccess.listMine, {})).toEqual([]);
  });

  test("rotates refresh tokens and closes the connection when one is used twice", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const first = await connect(t, "alice");
    const rotated = await tokenRequest(t, { grant_type: "refresh_token", refresh_token: first.refresh, client_id: first.clientId, resource: RESOURCE });
    expect(rotated.status).toBe(200);
    expect(rotated.body.refresh_token).not.toBe(first.refresh);
    expect((await callTool(t, rotated.body.access_token, "list_households")).status).toBe(200);
    expect((await callTool(t, first.access, "list_households")).status).toBe(200); // old access token lives out its hour

    const otherClient = (await register(t)).body.client_id;
    expect((await tokenRequest(t, { grant_type: "refresh_token", refresh_token: rotated.body.refresh_token, client_id: otherClient })).body.error).toBe("invalid_grant");

    // After the 30-second grace window, the first refresh token presented again is a replay.
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("oauthTokens").collect()) {
        if (row.usedAt !== undefined) await ctx.db.patch(row._id, { usedAt: row.usedAt - 31_000 });
      }
    });
    const replay = await tokenRequest(t, { grant_type: "refresh_token", refresh_token: first.refresh, client_id: first.clientId });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe("invalid_grant");
    const after = await callTool(t, rotated.body.access_token, "list_households");
    expect(after.status).toBe(401);
    expect(after.headers.get("www-authenticate")).toMatch(/error="invalid_token"/);
    expect((await tokenRequest(t, { grant_type: "refresh_token", refresh_token: rotated.body.refresh_token, client_id: first.clientId })).body.error).toBe("invalid_grant");
    expect(await identity(t, "alice").query(api.agentAccess.listMine, {})).toEqual([]);
  });

  test("a disconnected, revoked or expired token is refused", async () => {
    const t = convexTest(schema, modules);
    const { alice } = await seed(t);
    const one = await connect(t, "alice");
    const [connection] = await identity(t, "alice").query(api.agentAccess.listMine, {});
    await identity(t, "alice").mutation(api.agentAccess.disconnect, { id: connection!.id });
    const refused = await callTool(t, one.access, "list_households");
    expect(refused.status).toBe(401);
    expect((await tokenRequest(t, { grant_type: "refresh_token", refresh_token: one.refresh, client_id: one.clientId })).body.error).toBe("invalid_grant");

    const two = await connect(t, "alice");
    const revoked = await t.fetch("/oauth/revoke", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: two.refresh, client_id: two.clientId }).toString(),
    });
    expect(revoked.status).toBe(200);
    expect((await callTool(t, two.access, "list_households")).status).toBe(401);

    const three = await connect(t, "alice");
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("oauthTokens").collect()) {
        if (row.kind === "access") await ctx.db.patch(row._id, { expiresAt: Date.now() - 1 });
      }
    });
    const expired = await callTool(t, three.access, "list_households");
    expect(expired.status).toBe(401);
    expect(expired.body.error.message).toMatch(/expired/);

    const four = await connect(t, "alice");
    await t.run(async (ctx) => { await ctx.db.patch(alice, { deletionStartedAt: Date.now() }); });
    expect((await callTool(t, four.access, "list_households")).status).toBe(403);
  });

  test("an approval that names no household reads all of them, as the consent page sends it", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const { access } = await connect(t, "bob");
    const ids = (await callTool(t, access, "list_households")).body.result.structuredContent.result.map((h: { householdId: string }) => h.householdId);
    expect(ids.sort()).toEqual([POT, OTHER_POT].sort());
    for (const household of [POT, OTHER_POT]) {
      expect((await callTool(t, access, "get_balances", { household })).body.result.isError).toBeUndefined();
    }
    const [connection] = await identity(t, "bob").query(api.agentAccess.listMine, {});
    expect(connection).toMatchObject({ kind: "oauth", potId: null });
    // An explicit null, from the previous consent page, means the same.
    const legacy = await connect(t, "bob", null);
    expect((await callTool(t, legacy.access, "list_households")).body.result.structuredContent.result).toHaveLength(2);
  });

  test("a token for one household cannot read another", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const { access } = await connect(t, "bob", OTHER_POT);
    const ids = (await callTool(t, access, "list_households")).body.result.structuredContent.result.map((h: { householdId: string }) => h.householdId);
    expect(ids).toEqual([OTHER_POT]);
    for (const name of ["list_members", "get_balances", "list_records"]) {
      const refused = (await callTool(t, access, name, { household: POT })).body.result;
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toMatch(/limited to another household/);
    }
    // Nobody can approve a household they are not in.
    const client = (await register(t)).body;
    const started = await authorize(t, client.client_id, await pkce().challenge);
    await expect(identity(t, "alice").action(api.agentOAuth.approve, { request: requestIdOf(started.headers.get("location")!), household: OTHER_POT }))
      .rejects.toThrow(/NOT_MEMBER/);
  });

  test("a code works once; using it again closes the connection it opened", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const client = (await register(t)).body;
    const { verifier, challenge } = pkce();
    const started = await authorize(t, client.client_id, await challenge);
    const approved = await identity(t, "alice").action(api.agentOAuth.approve, { request: requestIdOf(started.headers.get("location")!), household: null });
    const code = new URL(approved.redirectTo).searchParams.get("code")!;
    const form = { grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id };
    const tokens = await tokenRequest(t, form);
    expect(tokens.status).toBe(200);
    expect((await tokenRequest(t, form)).body.error).toBe("invalid_grant");
    expect((await callTool(t, tokens.body.access_token, "list_households")).status).toBe(401);
  });

  test("accepts a client id metadata document and shows its host on the consent page", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const clientId = "https://agent.example.com/oauth/client.json";
    const fetched: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      fetched.push(String(url));
      return new Response(JSON.stringify({
        client_id: clientId, client_name: "Example Agent", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none",
      }), { headers: { "content-type": "application/json", "cache-control": "max-age=600" } });
    }));
    const { verifier, challenge } = pkce();
    const started = await authorize(t, clientId, await challenge);
    expect(started.status).toBe(302);
    const request = requestIdOf(started.headers.get("location")!);
    expect(await t.query(api.agentOAuth.describeRequest, { request })).toMatchObject({ agent: "Example Agent", verifiedHost: "agent.example.com" });
    await authorize(t, clientId, await challenge);
    expect(fetched).toEqual([clientId]); // cached
    const approved = await identity(t, "alice").action(api.agentOAuth.approve, { request, household: POT });
    const code = new URL(approved.redirectTo).searchParams.get("code")!;
    const tokens = await tokenRequest(t, { grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId });
    expect(tokens.status).toBe(200);

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ client_id: "https://someone-else.example/c.json", client_name: "X", redirect_uris: [REDIRECT] }))));
    const mismatch = await authorize(t, "https://agent2.example.com/client.json", await challenge);
    expect(mismatch.status).toBe(400);
    for (const local of ["https://127.0.0.1/c.json", "https://localhost/c.json", "https://agent.example.com/"]) {
      expect((await authorize(t, local, await challenge)).status).toBe(400);
    }
  });

  test("speaks MCP 2026-07-28 (server/discover, header checks) as well as initialize", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const { access } = await connect(t, "alice");
    const meta = { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } };
    const discover = await mcp(t, access, "server/discover", meta, { "mcp-protocol-version": "2026-07-28", "mcp-method": "server/discover" });
    expect(discover.status).toBe(200);
    expect(discover.body.result).toMatchObject({ resultType: "complete", supportedVersions: expect.arrayContaining(["2026-07-28", "2025-11-25"]) });
    const list = await mcp(t, access, "tools/list", meta, { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" });
    expect(list.body.result).toMatchObject({ resultType: "complete", cacheScope: "public" });
    const tools = list.body.result.tools as Array<{ name: string; annotations: { readOnlyHint: boolean } }>;
    expect(tools.filter((tool) => tool.name.startsWith("list_") || tool.name.startsWith("get_")).every((tool) => tool.annotations.readOnlyHint)).toBe(true);
    expect(tools.find((tool) => tool.name === "add_expense")?.annotations.readOnlyHint).toBe(false);
    const call = await mcp(t, access, "tools/call", { ...meta, name: "list_households", arguments: {} },
      { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "list_households" });
    expect(call.body.result.resultType).toBe("complete");
    const mismatch = await mcp(t, access, "tools/call", { ...meta, name: "list_households", arguments: {} },
      { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "get_balances" });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error.code).toBe(-32020);
    const unsupported = await mcp(t, access, "tools/list", { _meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01" } },
      { "mcp-protocol-version": "1900-01-01", "mcp-method": "tools/list" });
    expect(unsupported.status).toBe(400);
    expect(unsupported.body.error).toMatchObject({ code: -32022, data: { requested: "1900-01-01" } });
    const legacy = await mcp(t, access, "initialize", { protocolVersion: "2025-11-25" });
    expect(legacy.body.result).toMatchObject({ protocolVersion: "2025-11-25", serverInfo: { name: "numa-shared" } });
  });

  test("review P3: each approval is its own connection; a second consent never widens an earlier token", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const client = (await register(t)).body;
    // Computer 1: limited to Casa Mar.
    const one = pkce();
    const s1 = await authorize(t, client.client_id, await one.challenge);
    const a1 = await identity(t, "bob").action(api.agentOAuth.approve, { request: requestIdOf(s1.headers.get("location")!), household: POT });
    const tok1 = await tokenRequest(t, { grant_type: "authorization_code", code: new URL(a1.redirectTo).searchParams.get("code")!, code_verifier: one.verifier, client_id: client.client_id, resource: RESOURCE });
    expect((await callTool(t, tok1.body.access_token, "get_balances", { household: OTHER_POT })).body.result.isError).toBe(true);
    // Computer 2, same client id: "All my households".
    const two = pkce();
    const s2 = await authorize(t, client.client_id, await two.challenge);
    const a2 = await identity(t, "bob").action(api.agentOAuth.approve, { request: requestIdOf(s2.headers.get("location")!), household: null });
    const tok2 = await tokenRequest(t, { grant_type: "authorization_code", code: new URL(a2.redirectTo).searchParams.get("code")!, code_verifier: two.verifier, client_id: client.client_id, resource: RESOURCE });
    // The first token keeps its own scope.
    expect((await callTool(t, tok1.body.access_token, "get_balances", { household: OTHER_POT })).body.result.isError).toBe(true);
    expect((await callTool(t, tok2.body.access_token, "get_balances", { household: OTHER_POT })).body.result.isError).toBeUndefined();
    // Settings lists both, each with its own scope and its own Disconnect.
    const mine = await identity(t, "bob").query(api.agentAccess.listMine, {});
    expect(mine.map((c) => [c.name, c.kind, c.potId]).sort()).toEqual([["Claude Code", "oauth", null], ["Claude Code", "oauth", POT]]);
    await identity(t, "bob").mutation(api.agentAccess.disconnect, { id: mine.find((c) => c.potId === POT)!.id });
    expect((await callTool(t, tok1.body.access_token, "list_households")).status).toBe(401);
    expect((await callTool(t, tok2.body.access_token, "list_households")).status).toBe(200);
    expect(await identity(t, "bob").query(api.agentAccess.listMine, {})).toHaveLength(1);
  });

  test("an agent that lost its tokens can connect again at the limit; its dead connection gives up its place", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    for (let i = 0; i < 5; i += 1) await connect(t, "alice");
    // Four of them are abandoned: their refresh tokens expired long ago.
    await t.run(async (ctx) => {
      const connections = (await ctx.db.query("agentConnections").collect()).sort((a, b) => a._creationTime - b._creationTime);
      for (const connection of connections) await ctx.db.patch(connection._id, { createdAt: Date.now() - 3_600_000 });
      for (const row of await ctx.db.query("oauthTokens").collect()) {
        if (row.connectionId !== connections[4]!._id) await ctx.db.patch(row._id, { expiresAt: Date.now() - 1 });
      }
    });
    const kept = await connect(t, "alice");
    expect(await identity(t, "alice").query(api.agentAccess.listMine, {})).toHaveLength(2);
    expect((await callTool(t, kept.access, "list_households")).status).toBe(200);
    // Five live connections: the sixth is refused.
    for (let i = 0; i < 3; i += 1) await connect(t, "alice");
    const client = (await register(t)).body;
    const started = await authorize(t, client.client_id, await pkce().challenge);
    await expect(identity(t, "alice").action(api.agentOAuth.approve, { request: requestIdOf(started.headers.get("location")!), household: null }))
      .rejects.toThrow(/TOO_MANY_AGENTS/);
  });

  test("review P2: an OAuth access token is refused in the URL path", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const { access } = await connect(t, "bob");
    const response = await t.fetch(`/mcp/${access}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_households", arguments: {} } }) });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/resource_metadata=/);
    expect((await callTool(t, access, "list_households")).status).toBe(200);
  });

  test("review P9: a refresh retried within 30 seconds gets the same new pair and keeps the connection", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const { clientId, refresh } = await connect(t, "alice");
    const [a, b] = await Promise.all([1, 2].map(() => tokenRequest(t, { grant_type: "refresh_token", refresh_token: refresh, client_id: clientId, resource: RESOURCE })));
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(b.body.access_token).toBe(a.body.access_token);
    expect(b.body.refresh_token).toBe(a.body.refresh_token);
    expect((await callTool(t, a.body.access_token, "list_households")).status).toBe(200);
    // Once the new refresh token has been used, the old one is a replay even inside the window.
    const next = await tokenRequest(t, { grant_type: "refresh_token", refresh_token: a.body.refresh_token, client_id: clientId });
    expect(next.status).toBe(200);
    expect((await tokenRequest(t, { grant_type: "refresh_token", refresh_token: refresh, client_id: clientId })).status).toBe(400);
    expect((await callTool(t, next.body.access_token, "list_households")).status).toBe(401);
  });

  test("review P8: expired authorization codes are deleted", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await connect(t, "alice");
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("oauthCodes").collect()) await ctx.db.patch(row._id, { expiresAt: Date.now() - 1 });
    });
    await connect(t, "alice");
    const codes = await t.run(async (ctx) => await ctx.db.query("oauthCodes").collect());
    expect(codes).toHaveLength(1);
    expect(codes[0]!.expiresAt).toBeGreaterThan(Date.now());
  });

  test("closing a connection deletes all its tokens, past 500 and past one mutation's share", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      const { alice } = await seed(t);
      const one = await connect(t, "alice");
      const rows = 500 * tokenDeleteBatchesPerRun + 300;
      await t.run(async (ctx) => {
        const { _id, _creationTime, ...token } = (await ctx.db.query("oauthTokens").first())!;
        for (let i = 0; i < rows; i += 1) {
          await ctx.db.insert("oauthTokens", { ...token, tokenHash: `filler-${i}`, kind: "refresh", usedAt: 1 });
        }
      });
      const [connection] = await identity(t, "alice").query(api.agentAccess.listMine, {});
      await identity(t, "alice").mutation(api.agentAccess.disconnect, { id: connection!.id });
      expect((await callTool(t, one.access, "list_households")).status).toBe(401);
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const left = await t.run(async (ctx) => (await ctx.db.query("oauthTokens").collect()).filter((r) => r.accountId === alice));
      expect(left).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("account deletion erases OAuth tokens, codes and clients only that account used", async () => {
    const t = convexTest(schema, modules);
    const { alice, bob } = await seed(t);
    const aliceOnly = await connect(t, "alice");
    const shared = (await register(t)).body.client_id as string;
    for (const who of ["alice", "bob"] as const) {
      const started = await authorize(t, shared, await pkce().challenge);
      await identity(t, who).action(api.agentOAuth.approve, { request: requestIdOf(started.headers.get("location")!), household: null });
    }
    await t.run(async (ctx) => {
      for (let step = 0; step < 20; step += 1) {
        const { eraseAgentOAuthBatch } = await import("./agentOAuth");
        if (!(await eraseAgentOAuthBatch(ctx, alice))) break;
      }
    });
    const left = await t.run(async (ctx) => ({
      tokens: (await ctx.db.query("oauthTokens").collect()).filter((r) => r.accountId === alice),
      codes: (await ctx.db.query("oauthCodes").collect()).filter((r) => r.accountId === alice),
      connections: (await ctx.db.query("agentConnections").collect()).map((r) => r.accountId),
      clients: (await ctx.db.query("oauthClients").collect()).map((r) => r.clientId),
    }));
    expect(left.tokens).toEqual([]);
    expect(left.codes).toEqual([]);
    expect(left.connections).toEqual([bob]);
    expect(left.clients).toEqual([shared]);
    expect(left.clients).not.toContain(aliceOnly.clientId);
  });
});

describe("OAuth scopes for writes", () => {
  async function approvedWith(t: Tester, scope: string | null) {
    const client = (await register(t)).body;
    const { verifier, challenge } = pkce();
    const started = await authorize(t, client.client_id, await challenge, scope === null ? {} : { scope });
    if (scope === null) {
      // The helper names shared:read by default; this case sends no scope at all.
      const url = new URL(`http://x/oauth/authorize?${new URLSearchParams({
        response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: await challenge,
        code_challenge_method: "S256", state: "s", resource: RESOURCE,
      })}`);
      const bare = await t.fetch(`${url.pathname}${url.search}`, { method: "GET" });
      return finish(t, client.client_id, verifier, requestIdOf(bare.headers.get("location")!));
    }
    return finish(t, client.client_id, verifier, requestIdOf(started.headers.get("location")!));
  }
  async function finish(t: Tester, clientId: string, verifier: string, request: string) {
    const approved = await identity(t, "alice").action(api.agentOAuth.approve, { request });
    const code = new URL(approved.redirectTo).searchParams.get("code")!;
    const tokens = await tokenRequest(t, { grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT, resource: RESOURCE });
    const [connection] = (await identity(t, "alice").query(api.agentAccess.listMine, {})).slice(0, 1);
    return { scope: tokens.body.scope as string, permissions: connection!.permissions, refresh: tokens.body.refresh_token as string, clientId };
  }

  test("every new connection is granted both scopes and starts with every switch on, whatever it asked for", async () => {
    for (const scope of ["shared:read", "shared:read offline_access", "shared:read shared:write", "shared:write offline_access", null]) {
      const t = convexTest(schema, modules);
      await seed(t);
      const granted = await approvedWith(t, scope);
      expect(granted.scope).toBe("shared:read shared:write");
      expect(granted.permissions).toEqual({ addRecords: true, editRecords: true, manageHousehold: true });
      const refreshed = await tokenRequest(t, { grant_type: "refresh_token", refresh_token: granted.refresh, client_id: granted.clientId, resource: RESOURCE });
      expect(refreshed.body.scope).toBe("shared:read shared:write");
    }
  });

  test("the consent page shows the same text for every request: there is no read-only variant", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const client = (await register(t)).body;
    const { challenge } = pkce();
    const started = await authorize(t, client.client_id, await challenge, { scope: "shared:read" });
    const described = await t.query(api.agentOAuth.describeRequest, { request: requestIdOf(started.headers.get("location")!) });
    // Exactly the shape a full-scope request gets: nothing in it varies with the scope asked for.
    expect(described).toEqual({
      status: "pending", agent: "Claude Code", verifiedHost: null, returnsTo: "127.0.0.1:33418", returnsToThisComputer: true,
    });
  });

  test("a connection made before writes existed keeps shared:read and stays read-only until switched on", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const granted = await approvedWith(t, "shared:read");
    // Make it look like a pre-change connection: no switches stored, tokens granted shared:read.
    await t.run(async (ctx) => {
      const connection = (await ctx.db.query("agentConnections").collect())[0]!;
      await ctx.db.replace(connection._id, (({ _id, _creationTime, permissions, ...rest }) => rest)(connection));
      for (const token of await ctx.db.query("oauthTokens").collect()) await ctx.db.patch(token._id, { scope: "shared:read" });
    });
    const [connection] = await identity(t, "alice").query(api.agentAccess.listMine, {});
    expect(connection!.permissions).toEqual({ addRecords: false, editRecords: false, manageHousehold: false });
    const refreshed = await tokenRequest(t, { grant_type: "refresh_token", refresh_token: granted.refresh, client_id: granted.clientId, resource: RESOURCE });
    expect(refreshed.body.scope).toBe("shared:read");
    const refused = await callTool(t, refreshed.body.access_token, "rename_household", { household: POT, name: "Casa Nova", request_id: "legacy-1" });
    expect(refused.body.result.isError).toBe(true);
    expect(JSON.stringify(refused.body.result)).toContain(String.raw`the \"Manage the household\" switch is off`);
  });

  test("an unknown scope is still refused", async () => {
    const t = convexTest(schema, modules);
    const client = (await register(t)).body;
    const { challenge } = pkce();
    expect((await authorize(t, client.client_id, await challenge, { scope: "shared:admin" })).status).toBe(400);
  });
});
