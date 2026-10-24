/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { callsPerMinute, maximumAgents } from "./agentAccess";
import { formatMinorUnits } from "./agentData";
import { sha256Hex } from "./lib/hash";
import schema from "./schema";
import { modules } from "./test.setup";

type Tester = ReturnType<typeof convexTest>;

const POT = "pot-casa-mar-000000000001";
const OTHER_POT = "pot-someone-else-0000000001";
const ALICE = "member-alice-000000000001";
const BOB = "member-bob-00000000000001";
const ALICE_UNIT = "unit-alice-0000000000001";
const BOB_UNIT = "unit-bob-000000000000001";

beforeEach(() => {
  vi.stubEnv("NUMA_SHARED_PRODUCT", "numa-shared");
  vi.stubEnv("NUMA_SHARED_DEPLOYMENT_CLASS", "anonymous-local");
  vi.stubEnv("NUMA_SHARED_DEPLOYMENT_NAME", "anonymous-agent-test");
  vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3210");
  vi.stubEnv("CONVEX_SITE_URL", "http://127.0.0.1:3211");
  vi.stubEnv("NUMA_SHARED_SESSION_ISSUER", "https://auth.numa.shared");
  vi.stubEnv("NUMA_SHARED_SESSION_AUDIENCE", "tech.arsik.numashared");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const money = (minorUnits: bigint) => ({ minorUnits, currency: { code: "EUR", exponent: 2n } });

function identity(t: Tester, who: "alice" | "bob") {
  return t.withIdentity({
    issuer: "https://auth.numa.shared",
    subject: `account-${who}-0000000001`,
    sid: `session-${who}-000000001`,
    numa_session_audience: "tech.arsik.numashared",
    token_use: "access",
  });
}

async function account(t: Tester, who: "alice" | "bob"): Promise<Id<"accounts">> {
  return await t.run(async (ctx) => {
    const accountId = await ctx.db.insert("accounts", {
      publicAccountId: `account-${who}-0000000001`,
      appleSubjectHash: `apple-${who}`,
      createdAt: 1,
    });
    await ctx.db.insert("sessions", {
      sessionId: `session-${who}-000000001`,
      accountId,
      refreshTokenHash: `refresh-${who}`,
      expiresAt: Date.now() + 86_400_000,
      createdAt: 1,
      rotatedAt: 1,
    });
    return accountId;
  });
}

type Seeded = { alice: Id<"accounts">; bob: Id<"accounts"> };

/**
 * Alice and Bob share a household in euros.
 *  1. Alice pays 100.00 for groceries, split 50/50      -> Alice +50, Bob -50
 *  2. Bob repays Alice 20.00                           -> Alice +30, Bob -30
 *  3. Bob pays 30.00 for Alice alone, then it is voided -> no change
 * A second household has only Bob in it.
 */
async function seed(t: Tester): Promise<Seeded> {
  const alice = await account(t, "alice");
  const bob = await account(t, "bob");
  await t.run(async (ctx) => {
    const pot = (potId: string, owner: Id<"accounts">, name: string) => ctx.db.insert("pots", {
      potId,
      currencyCode: "EUR",
      currencyExponent: 2n,
      orderedUnitIds: [ALICE_UNIT, BOB_UNIT],
      ownerAccountId: owner,
      name,
      minimumReaderSchemaVersion: 1n,
      nextSequence: 10n,
      nextTextRevision: 1n,
      positiveContributionBudget: 0n,
      negativeContributionBudget: 0n,
      createdAt: 1,
    });
    await pot(POT, alice, "Casa Mar");
    await pot(OTHER_POT, bob, "Bob's flat");
    const member = (potId: string, accountId: Id<"accounts">, memberId: string, role: "owner" | "member") =>
      ctx.db.insert("potMembers", { potId, accountId, memberId, role, status: "active", joinedAt: 1 });
    await member(POT, alice, ALICE, "owner");
    await member(POT, bob, BOB, "member");
    await member(OTHER_POT, bob, BOB, "owner");
    const profile = (potId: string, memberId: string, unitId: string, name: string, role: "owner" | "member") =>
      ctx.db.insert("potMemberProfiles", { potId, memberId, unitId, displayName: name, role, state: "active", createdAt: 1, updatedAt: 1 });
    await profile(POT, ALICE, ALICE_UNIT, "Alice", "owner");
    await profile(POT, BOB, BOB_UNIT, "Bob", "member");
    await profile(OTHER_POT, BOB, BOB_UNIT, "Bob", "owner");

    const event = (sequence: bigint, recordId: string | undefined, actor: string, payload: never, textFields: Array<"title" | "category" | "note" | "reason"> = []) =>
      ctx.db.insert("events", {
        potId: POT,
        eventId: `event-${sequence}-00000000000000`,
        ...(recordId === undefined ? {} : { recordId }),
        actorMemberId: actor,
        occurredAtMillis: 1_760_000_000_000n + sequence * 86_400_000n,
        originatingTimeZone: "Europe/Madrid",
        schemaVersion: 1n,
        sequence,
        payload,
        textFields,
        createdAt: 1_760_000_000_000 + Number(sequence),
      });
    await event(1n, "record-groceries-0000000001", ALICE, {
      kind: "expenseAdded",
      recordId: "record-groceries-0000000001",
      content: {
        expenseKind: "shared",
        amount: money(10_000n),
        payerUnitId: ALICE_UNIT,
        allocations: [{ unitId: ALICE_UNIT, amount: money(5_000n) }, { unitId: BOB_UNIT, amount: money(5_000n) }],
      },
    } as never, ["title", "category"]);
    await ctx.db.insert("eventTexts", { potId: POT, eventId: "event-1-00000000000000", sequence: 1n, field: "title", value: "Weekly shop", authorAccountId: alice, createdAt: 1 });
    await ctx.db.insert("eventTexts", { potId: POT, eventId: "event-1-00000000000000", sequence: 1n, field: "category", value: "groceries", authorAccountId: alice, createdAt: 1 });
    await event(2n, "record-repayment-000000001", BOB, {
      kind: "settlementRecorded",
      recordId: "record-repayment-000000001",
      content: { amount: money(2_000n), fromUnitId: BOB_UNIT, toUnitId: ALICE_UNIT },
    } as never);
    await event(3n, "record-taxi-000000000000001", BOB, {
      kind: "expenseAdded",
      recordId: "record-taxi-000000000000001",
      content: {
        expenseKind: "shared",
        amount: money(3_000n),
        payerUnitId: BOB_UNIT,
        allocations: [{ unitId: ALICE_UNIT, amount: money(3_000n) }],
      },
    } as never);
    await event(4n, "record-taxi-000000000000001", BOB, { kind: "recordVoided", recordId: "record-taxi-000000000000001" } as never);
  });
  return { alice, bob };
}

/** Connects an agent for `who` (optionally limited to one household) and returns its secret. */
async function connect(t: Tester, who: "alice" | "bob", options: { potId?: string; secret?: string } = {}) {
  const secret = options.secret ?? `nsag_${who}_${Math.random().toString(36).slice(2)}0123456789abcdef`;
  const { id } = await identity(t, who).mutation(api.agentAccess.connect, {
    name: "Test agent",
    keyHash: await sha256Hex(secret),
    keyHint: secret.slice(0, 9),
    ...(options.potId === undefined ? {} : { potId: options.potId }),
  });
  return { id, secret };
}

async function rpc(t: Tester, secret: string, message: unknown, how: "path" | "bearer" = "path") {
  const response = how === "path"
    ? await t.fetch(`/mcp/${secret}`, { method: "POST", body: JSON.stringify(message) })
    : await t.fetch("/mcp", { method: "POST", headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify(message) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const call = (name: string, args: Record<string, unknown> = {}, id = 1) =>
  ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

async function tool(t: Tester, secret: string, name: string, args: Record<string, unknown> = {}) {
  const { status, body } = await rpc(t, secret, call(name, args));
  expect(status).toBe(200);
  return body.result as { isError?: boolean; structuredContent: any; content: Array<{ text: string }> };
}

describe("Agent access (read-only MCP)", () => {
  test("formats minor units", () => {
    expect(formatMinorUnits(1234n, 2)).toBe("12.34");
    expect(formatMinorUnits(-5n, 2)).toBe("-0.05");
    expect(formatMinorUnits(700n, 0)).toBe("700");
    expect(formatMinorUnits(0n, 2)).toBe("0.00");
  });

  test("lists only read tools and says the connection cannot change anything", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const { secret } = await connect(t, "alice");
    const init = await rpc(t, secret, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect(init.body.result.serverInfo.name).toBe("numa-shared");
    expect(init.body.result.instructions).toMatch(/only read/);
    const list = await rpc(t, secret, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = list.body.result.tools as Array<{ name: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean } }>;
    expect(tools.map((x) => x.name).sort()).toEqual(["get_balances", "list_households", "list_members", "list_records"]);
    expect(tools.every((x) => x.annotations.readOnlyHint && !x.annotations.destructiveHint)).toBe(true);
    const write = await rpc(t, secret, call("add_expense", { household: POT }));
    expect(write.body.error.message).toMatch(/Unknown tool/);
  });

  test("reads households, people, balances and records through the link and through a Bearer header", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const { secret } = await connect(t, "alice");

    const households = await tool(t, secret, "list_households");
    expect(households.structuredContent.result ?? households.structuredContent).toBeDefined();
    const list = JSON.parse(households.content[0]!.text) as Array<{ householdId: string; name: string; yourRole: string; activeMembers: number }>;
    expect(list).toEqual([{ householdId: POT, name: "Casa Mar", currency: "EUR", yourRole: "owner", yourMemberId: ALICE, activeMembers: 2, archived: false }]);

    const members = JSON.parse((await tool(t, secret, "list_members", { household: POT })).content[0]!.text) as Array<{ name: string; isYou: boolean }>;
    expect(members.map((m) => [m.name, m.isYou])).toEqual(expect.arrayContaining([["Alice", true], ["Bob", false]]));

    const balances = (await tool(t, secret, "get_balances", { household: POT })).structuredContent;
    expect(balances.units.map((u: { label: string; amount: string }) => [u.label, u.amount])).toEqual([["Alice", "30.00"], ["Bob", "-30.00"]]);
    expect(balances.sumMinorUnits).toBe("0");
    expect(balances.liveRecords).toBe(2);

    const records = (await tool(t, secret, "list_records", { household: POT })).structuredContent;
    expect(records.records.map((r: { recordId: string; status: string }) => [r.recordId, r.status])).toEqual([
      ["record-taxi-000000000000001", "voided"],
      ["record-repayment-000000001", "live"],
      ["record-groceries-0000000001", "live"],
    ]);
    const groceries = records.records[2];
    expect(groceries).toMatchObject({ kind: "expense", title: "Weekly shop", category: "groceries", paidBy: "Alice", amount: "100.00", note: null });
    expect(groceries.splitBetween.map((s: { who: string; amount: string }) => [s.who, s.amount])).toEqual([["Alice", "50.00"], ["Bob", "50.00"]]);
    expect(records.records[1]).toMatchObject({ kind: "repayment", from: "Bob", to: "Alice", amount: "20.00" });

    const page = (await tool(t, secret, "list_records", { household: POT, limit: 1 })).structuredContent;
    expect(page.records).toHaveLength(1);
    const older = (await tool(t, secret, "list_records", { household: POT, limit: 5, before_sequence: page.nextBeforeSequence })).structuredContent;
    expect(older.records[0].recordId).toBe("record-repayment-000000001");
    const one = (await tool(t, secret, "list_records", { household: POT, record_id: "record-groceries-0000000001" })).structuredContent;
    expect(one.records).toHaveLength(1);

    const viaHeader = await rpc(t, secret, call("get_balances", { household: POT }), "bearer");
    expect(viaHeader.status).toBe(200);
    expect(viaHeader.body.result.structuredContent.units).toHaveLength(2);
  });

  test("a revised expense replaces the old amount in balances", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("events", {
        potId: POT,
        eventId: "event-5-00000000000000",
        recordId: "record-groceries-0000000001",
        actorMemberId: ALICE,
        occurredAtMillis: 1_760_500_000_000n,
        originatingTimeZone: "Europe/Madrid",
        schemaVersion: 1n,
        sequence: 5n,
        payload: {
          kind: "expenseRevised",
          recordId: "record-groceries-0000000001",
          basis: { kind: "parent", parentEventId: "event-1-00000000000000" },
          content: {
            kind: "expense",
            expenseKind: "shared",
            amount: money(6_000n),
            payerUnitId: ALICE_UNIT,
            allocations: [{ unitId: ALICE_UNIT, amount: money(3_000n) }, { unitId: BOB_UNIT, amount: money(3_000n) }],
          },
        } as never,
        textFields: [],
        createdAt: 1_760_500_000_000,
      });
    });
    const { secret } = await connect(t, "alice");
    const balances = (await tool(t, secret, "get_balances", { household: POT })).structuredContent;
    // Alice paid 60 for both (+30), Bob repaid 20: Alice +10, Bob -10.
    expect(balances.units.map((u: { label: string; amount: string }) => [u.label, u.amount])).toEqual([["Alice", "10.00"], ["Bob", "-10.00"]]);
  });

  test("a member sees only households they belong to", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const { secret } = await connect(t, "alice");
    const refused = await tool(t, secret, "get_balances", { household: OTHER_POT });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(/not one this person belongs to/);
    const bob = await connect(t, "bob");
    const ids = JSON.parse((await tool(t, bob.secret, "list_households")).content[0]!.text).map((h: { householdId: string }) => h.householdId);
    expect(ids).toEqual([OTHER_POT, POT].sort());
  });

  test("a connection limited to one household cannot read another", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const { secret } = await connect(t, "bob", { potId: OTHER_POT });
    const ids = JSON.parse((await tool(t, secret, "list_households")).content[0]!.text).map((h: { householdId: string }) => h.householdId);
    expect(ids).toEqual([OTHER_POT]);
    const refused = await tool(t, secret, "list_records", { household: POT });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(/limited to another household/);
    await expect(identity(t, "alice").mutation(api.agentAccess.connect, {
      name: "x", keyHash: await sha256Hex("scope-check"), keyHint: "scope", potId: OTHER_POT,
    })).rejects.toThrow();
  });

  test("rejects unknown secrets and stops a disconnected agent on the next call", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    expect((await rpc(t, "nsag_not_a_real_secret_0123456789", call("list_households"))).status).toBe(401);
    expect((await t.fetch("/mcp", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await t.fetch("/mcp/anything", { method: "GET" })).status).toBe(405);

    const { id, secret } = await connect(t, "alice");
    expect((await rpc(t, secret, call("list_households"))).status).toBe(200);
    await identity(t, "alice").mutation(api.agentAccess.disconnect, { id });
    const after = await rpc(t, secret, call("list_households"));
    expect(after.status).toBe(401);
    expect(after.body.error.message).toMatch(/disconnected/);
    expect(await identity(t, "alice").query(api.agentAccess.listMine, {})).toEqual([]);
  });

  test("nobody else can disconnect or see another person's agent", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const { id } = await connect(t, "alice");
    await expect(identity(t, "bob").mutation(api.agentAccess.disconnect, { id })).rejects.toThrow();
    expect(await identity(t, "bob").query(api.agentAccess.listMine, {})).toEqual([]);
    const mine = await identity(t, "alice").query(api.agentAccess.listMine, {});
    expect(mine).toHaveLength(1);
    expect(JSON.stringify(mine)).not.toMatch(/keyHash/);
  });

  test("an account being deleted loses agent access", async () => {
    const t = convexTest(schema, modules);
    const { alice } = await seed(t);
    const { secret } = await connect(t, "alice");
    await t.run(async (ctx) => { await ctx.db.patch(alice, { deletionStartedAt: Date.now() }); });
    const refused = await rpc(t, secret, call("list_households"));
    expect(refused.status).toBe(403);
  });

  test("limits calls per minute and the number of agents", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const { secret } = await connect(t, "alice");
    for (let i = 0; i < callsPerMinute; i += 1) {
      expect((await rpc(t, secret, { jsonrpc: "2.0", id: i, method: "ping" })).status).toBe(200);
    }
    expect((await rpc(t, secret, { jsonrpc: "2.0", id: 999, method: "ping" })).status).toBe(429);

    for (let i = 1; i < maximumAgents; i += 1) await connect(t, "alice");
    await expect(connect(t, "alice")).rejects.toThrow();
  });

  test("records what the agent did without amounts or names", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const { secret } = await connect(t, "alice");
    await tool(t, secret, "get_balances", { household: POT });
    await tool(t, secret, "get_balances", { household: OTHER_POT });
    const activity = await identity(t, "alice").query(api.agentAccess.recentActivity, {});
    expect(activity.map((a) => [a.tool, a.ok])).toEqual([["get_balances", false], ["get_balances", true]]);
    expect(activity[0]!.agent).toBe("Test agent");
    expect(JSON.stringify(activity)).not.toMatch(/Alice|Bob|30\.00/);
  });

  test("rejects a malformed key and a reused key", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await expect(identity(t, "alice").mutation(api.agentAccess.connect, { name: "x", keyHash: "short", keyHint: "x" })).rejects.toThrow();
    await connect(t, "alice", { secret: "nsag_reused_secret_0123456789abcdef" });
    await expect(connect(t, "bob", { secret: "nsag_reused_secret_0123456789abcdef" })).rejects.toThrow();
  });
});
