// Agent writes (convex/agentWrites.ts) end to end: a household made and shared by the Expo app's
// sync engine (app/src/sync), an agent connected with a secret link, and every write tool called
// over /mcp. After each write both phones pull, and the balances the server gives the agent must
// match the ones the app's own reducer computes.
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { reduce } from "../app/src/core/ledger";
import type { Household } from "../app/src/core/types";
import {
  claimInvite, issueInvites, leaveOnline, pull, resolveInvite, startSync, type Access, type Backend,
} from "../app/src/sync/engine";
import { EXTENDED_CONTRACT, LEGACY_CONTRACT, setContract } from "../app/src/sync/contract";
import { AGENT_SWITCHES, ALL_ON } from "../app/src/features/agents/permissions";
import { setupPrompt } from "../app/src/features/agents/setupPrompt";
import { clientLabel } from "./agentAccess";
import { errorText } from "./agentMcp";
import { agentWriteOps, agentWriteTools, localNoon, requestKeepMillis, requestPurgeBatch, writesPerMinute } from "./agentWrites";
import crons from "./crons";
import { ConvexError } from "convex/values";
import { sha256Hex } from "./lib/hash";
import { agentTools } from "./lib/agentTools";
import schema from "./schema";
import { modules } from "./test.setup";

beforeEach(() => {
  vi.stubEnv("NUMA_SHARED_PRODUCT", "numa-shared");
  vi.stubEnv("NUMA_SHARED_DEPLOYMENT_CLASS", "anonymous-local");
  vi.stubEnv("NUMA_SHARED_DEPLOYMENT_NAME", "anonymous-agent-writes");
  vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3210");
  vi.stubEnv("CONVEX_SITE_URL", "http://127.0.0.1:3211");
  vi.stubEnv("NUMA_SHARED_TOKEN_HASH_SECRET", "agent-writes-test-token-hash-secret-32-bytes");
  vi.stubEnv("NUMA_SHARED_SESSION_ISSUER", "https://auth.numa.shared");
  vi.stubEnv("NUMA_SHARED_SESSION_AUDIENCE", "tech.arsik.numashared");
});
afterEach(() => { vi.unstubAllEnvs(); setContract(LEGACY_CONTRACT); });

type T = ReturnType<typeof convexTest>;

async function fenceBuild11(t: T) {
  await t.run(async (ctx) => { await ctx.db.insert("appConfiguration", { key: "global", minimumSupportedBuild: 12, updatedAt: 1 }); });
  setContract(EXTENDED_CONTRACT);
}

async function signIn(t: T, name: string): Promise<Backend> {
  await t.run(async (ctx) => {
    const accountId = await ctx.db.insert("accounts", { publicAccountId: `account-${name}`, appleSubjectHash: `apple-${name}`, createdAt: 1 });
    await ctx.db.insert("sessions", {
      sessionId: `session-${name}-0000001`, accountId, refreshTokenHash: `refresh-${name}`,
      expiresAt: Date.now() + 86_400_000, createdAt: 1, rotatedAt: 1,
    });
  });
  const who = t.withIdentity({
    issuer: "https://auth.numa.shared", subject: `account-${name}`, sid: `session-${name}-0000001`,
    numa_session_audience: "tech.arsik.numashared", token_use: "access",
  });
  return {
    query: (fn, args) => who.query(makeFunctionReference<"query">(fn), args) as never,
    mutation: (fn, args) => who.mutation(makeFunctionReference<"mutation">(fn), args) as never,
  };
}

function phone(): Access & { list: Household[] } {
  const list: Household[] = [];
  return {
    list,
    get: (id) => list.find((h) => h.id === id),
    put: (h) => { const i = list.findIndex((x) => x.id === h.id); if (i >= 0) list[i] = h; else list.push(h); },
    remove: (id) => { const i = list.findIndex((x) => x.id === id); if (i >= 0) list.splice(i, 1); },
    all: () => list,
  };
}

/** Ana and Mia pay as a couple; Leo pays alone. With `money`, Mia paid 90.00 split between the two groups. */
function localHousehold(money = true): Household {
  const at = Date.now() - 60_000;
  return {
    id: "h_local", name: "Casa Prueba", currency: "EUR", createdAt: at, youId: "p_you",
    people: [
      { id: "p_you", name: "Ana", groupId: "g_couple", joined: true },
      { id: "p_mia", name: "Mia", groupId: "g_couple", joined: false },
      { id: "p_leo", name: "Leo", groupId: "g_leo", joined: false },
    ],
    groups: [
      { id: "g_couple", color: "citrus", memberIds: ["p_you", "p_mia"] },
      { id: "g_leo", color: "lilac", memberIds: ["p_leo"] },
    ],
    events: money ? [{
      id: "e_1", at, by: "p_you", kind: "expenseAdded", recordId: "r_1",
      content: {
        payerId: "p_mia", amount: 9_000, date: new Date(at).toISOString().slice(0, 10), category: "groceries",
        split: { mode: "equal", groupIds: ["g_couple", "g_leo"], weighting: "group" },
      },
    }] : [],
    seen: {},
    inviteCode: "ABC234",
  };
}

/** The household on Ana's phone, shared, with Leo joined from his own phone. */
async function sharedHousehold(t: T, options: { money?: boolean; leoJoins?: boolean } = {}) {
  const ana = await signIn(t, "ana");
  const leo = await signIn(t, "leo");
  const phoneA = phone();
  const phoneB = phone();
  phoneA.put(localHousehold(options.money ?? true));
  const id = await startSync(ana, phoneA, "h_local");
  await pull(ana, phoneA, id);
  let a = phoneA.get(id)!;
  const person = (name: string) => a.people.find((p) => p.name === name)!;
  const leoId = person("Leo").id;
  if (options.leoJoins ?? true) {
    await issueInvites(ana, phoneA, id);
    a = phoneA.get(id)!;
    const fetchFromSite = ((url: string, init?: RequestInit) => t.fetch(new URL(url).pathname + new URL(url).search, init)) as typeof fetch;
    const preview = await resolveInvite("http://127.0.0.1:3211", a.sync!.invites![leoId]!.code, fetchFromSite);
    if (preview.status !== "active") throw new Error("invite did not resolve");
    await claimInvite(leo, phoneB, preview);
  }
  a = phoneA.get(id)!;
  return {
    ana, leo, phoneA, phoneB, id,
    anaId: a.youId, miaId: person("Mia").id, leoId,
    coupleUnit: a.groups.find((g) => g.memberIds.length === 2)!.id,
    leoUnit: person("Leo").groupId,
  };
}

/** A setup-prompt connection as the current app makes it: all three switches sent explicitly. */
async function connectAgent(backend: Backend, name = "Claude", permissions: Record<string, boolean> | null = ALL_ON) {
  const secret = `nsag_${Math.random().toString(36).slice(2)}0123456789abcdefghij`;
  const { id } = await backend.mutation<{ id: string }>("agentAccess:connect", {
    name, keyHash: await sha256Hex(secret), keyHint: secret.slice(0, 9), ...(permissions ? { permissions } : {}),
  });
  return { id, secret };
}

type ToolResult = { isError?: boolean; structuredContent?: any; content: Array<{ text: string }> };

async function tool(t: T, secret: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const response = await t.fetch("/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { result?: ToolResult; error?: { message: string } };
  if (body.error) return { isError: true, content: [{ text: body.error.message }] };
  return body.result!;
}

async function ok(t: T, secret: string, name: string, args: Record<string, unknown>) {
  const result = await tool(t, secret, name, args);
  if (result.isError) throw new Error(`${name} refused: ${result.content[0]!.text}`);
  return result.structuredContent;
}

async function refused(t: T, secret: string, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await tool(t, secret, name, args);
  expect(result.isError).toBe(true);
  return result.content[0]!.text;
}

let counter = 0;
const rid = () => `req-${Date.now()}-${counter++}`;

/** Server balances (get_balances) and the app reducer's, both as unit -> cents without zeros. */
async function expectSameBalances(t: T, secret: string, id: string, ...households: Household[]) {
  const server = await ok(t, secret, "get_balances", { household: id }) as { units: Array<{ unitId: string; minorUnits: string }>; sumMinorUnits: string };
  expect(server.sumMinorUnits).toBe("0");
  const fromServer = Object.fromEntries(server.units.filter((u) => u.minorUnits !== "0").map((u) => [u.unitId, Number(u.minorUnits)]));
  for (const h of households) {
    const fromApp = Object.fromEntries(Object.entries(reduce(h).balances).filter(([, v]) => v !== 0));
    expect(fromApp).toEqual(fromServer);
  }
  return fromServer;
}

async function events(t: T, potId: string) {
  const rows = await t.run(async (ctx) => ctx.db.query("events").collect()) as Array<{ potId: string; recordId?: string; via?: string; textFields: string[]; payload: { kind: string } }>;
  return rows.filter((row) => row.potId === potId);
}

describe("agent writes", () => {
  test("the write tools are exactly these, and none deletes, leaves or removes", () => {
    const names = Object.keys(agentWriteTools).sort();
    expect(names).toEqual(["add_expense", "add_person", "add_repayment", "create_invite", "edit_record", "rename_household", "update_groups", "void_record"]);
    expect(agentTools.filter((x) => x.writes).map((x) => x.name).sort()).toEqual(names);
    for (const x of agentTools.filter((y) => y.writes)) expect(x.writes).toBe(agentWriteTools[x.name as keyof typeof agentWriteTools]);
    // The mutation's validator admits these tools and nothing else.
    const literals = (agentWriteOps.members as Array<{ fields: { tool: { value: string } } }>).map((m) => m.fields.tool.value).sort();
    expect(literals).toEqual(names);
    for (const forbidden of [/delete/i, /leave/i, /remove/i, /archive/i, /transfer/i, /account/i]) {
      expect([...names, ...agentTools.map((x) => x.name)].some((n) => forbidden.test(n))).toBe(false);
    }
  });

  test("the setup prompt names every tool, and refusals quote the switch labels Settings shows", () => {
    const prompt = setupPrompt("https://shared.numaworth.com/mcp/nsag_x");
    for (const x of agentTools) expect(prompt).toContain(x.name);
    const codes = { addRecords: "AGENT_SWITCH_ADD_RECORDS_OFF", editRecords: "AGENT_SWITCH_EDIT_RECORDS_OFF", manageHousehold: "AGENT_SWITCH_MANAGE_HOUSEHOLD_OFF" };
    for (const item of AGENT_SWITCHES) {
      expect(errorText(new ConvexError({ code: codes[item.key] }))).toContain(`"${item.label}" switch is off`);
    }
  });

  test("a setup-prompt connection takes the name the agent gives itself, once", async () => {
    expect(clientLabel("claude-code")).toBe("Claude Code");
    expect(clientLabel("codex-mcp-client")).toBe("Codex");
    expect(clientLabel("cursor-vscode")).toBe("Cursor");
    expect(clientLabel("my<script>agent")).toBe("my script agent");
    const t = convexTest(schema, modules);
    const s = await sharedHousehold(t);
    const { secret } = await connectAgent(s.ana, "Agent, 9 Nov 2026");
    const init = (clientInfo: Record<string, string>) => t.fetch("/mcp", {
      method: "POST", headers: { authorization: `Bearer ${secret}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo } }),
    });
    await init({ name: "claude-code", version: "2.1.0" });
    await init({ name: "Mallory" });
    const listed = await s.ana.query<Array<{ name: string }>>("agentAccess:listMine", {});
    expect(listed[0]!.name).toBe("Claude Code");
    const added = await ok(t, secret, "add_expense", { household: s.id, request_id: rid(), amount_minor_units: 100, currency: "EUR", title: "Tea", split: { mode: "equal" } });
    expect((await events(t, s.id)).find((e) => e.recordId === added.recordId)!.via).toBe("Claude Code");
  });

  test("an expense, an edit, a void and a repayment reach both phones, attributed, with matching balances", async () => {
    const t = convexTest(schema, modules);
    await fenceBuild11(t);
    const s = await sharedHousehold(t);
    const { secret } = await connectAgent(s.ana);

    // 30.01 paid by Ana, equal between the two groups: the remainder goes to the last group, as in the app.
    const added = await ok(t, secret, "add_expense", {
      household: s.id, request_id: rid(), amount_minor_units: 3001, currency: "eur",
      title: "Fibre", category: "internet", note: "October", split: { mode: "equal" },
    });
    expect(added).toMatchObject({ minorUnits: "3001", amount: "30.01", currency: "EUR" });
    expect(added.split.map((x: { minorUnits: string }) => x.minorUnits)).toEqual(["1500", "1501"]);

    await pull(s.ana, s.phoneA, s.id);
    await pull(s.leo, s.phoneB, s.id);
    const a = s.phoneA.get(s.id)!;
    const event = a.events.find((e) => e.kind === "expenseAdded" && e.recordId === added.recordId)!;
    expect(event).toMatchObject({ by: s.anaId, via: "Claude", content: { amount: 3001, note: "October", title: "Fibre", category: "internet" } });
    expect(event.kind === "expenseAdded" && event.content.split).toEqual({ mode: "equal", groupIds: expect.any(Array), weighting: "group" });
    const record = reduce(a).records.find((r) => r.id === added.recordId)!;
    expect(record).toMatchObject({ createdBy: s.anaId, createdVia: "Claude" });
    expect(s.phoneB.get(s.id)!.events.find((e) => e.id === event.id)?.via).toBe("Claude");
    await expectSameBalances(t, secret, s.id, a, s.phoneB.get(s.id)!);

    // The other member is told, as for an expense added in the app.
    const pending = await t.run(async (ctx) => ctx.db.query("pendingPushes").collect());
    expect(pending.flatMap((p) => p.eventIds)).toContain(event.id);

    // list_records shows the revision to edit; an edit with an older revision is refused.
    const listed = await ok(t, secret, "list_records", { household: s.id, record_id: added.recordId });
    expect(listed.records[0]).toMatchObject({ revision: added.revision, addedVia: "Claude" });
    const edited = await ok(t, secret, "edit_record", {
      household: s.id, request_id: rid(), record_id: added.recordId, revision: added.revision,
      amount_minor_units: 4000, currency: "EUR", reason: "Price went up",
    });
    expect(edited.split.map((x: { minorUnits: string }) => x.minorUnits)).toEqual(["2000", "2000"]);
    expect(await refused(t, secret, "edit_record", {
      household: s.id, request_id: rid(), record_id: added.recordId, revision: added.revision, title: "Old view",
    })).toMatch(/changed that record since you read it/);

    const repaid = await ok(t, secret, "add_repayment", {
      household: s.id, request_id: rid(), amount_minor_units: 2500, currency: "EUR",
      from: s.leoId, to: s.anaId, method: "bizum",
    });
    expect(repaid).toMatchObject({ fromUnitId: s.leoUnit, toUnitId: s.coupleUnit });

    await pull(s.ana, s.phoneA, s.id);
    await pull(s.leo, s.phoneB, s.id);
    let ledger = reduce(s.phoneA.get(s.id)!);
    const editedRecord = ledger.records.find((r) => r.id === added.recordId)!;
    expect(editedRecord.timeline.find((x) => x.type === "edited")).toMatchObject({ by: s.anaId, via: "Claude", reason: "Price went up" });
    expect(ledger.records.find((r) => r.id === repaid.recordId)).toMatchObject({ createdVia: "Claude", settlement: { method: "bizum", amount: 2500 } });
    await expectSameBalances(t, secret, s.id, s.phoneA.get(s.id)!, s.phoneB.get(s.id)!);

    // Void it; a voided record can't be edited or voided again; repayments can't be voided.
    await ok(t, secret, "void_record", { household: s.id, request_id: rid(), record_id: added.recordId, reason: "Duplicate of the bank line" });
    expect(await refused(t, secret, "edit_record", {
      household: s.id, request_id: rid(), record_id: added.recordId, revision: edited.revision, title: "Again",
    })).toMatch(/voided/);
    expect(await refused(t, secret, "void_record", { household: s.id, request_id: rid(), record_id: added.recordId, reason: "x" })).toMatch(/voided/);
    expect(await refused(t, secret, "void_record", { household: s.id, request_id: rid(), record_id: repaid.recordId, reason: "x" })).toMatch(/Repayments can't/);

    await pull(s.ana, s.phoneA, s.id);
    await pull(s.leo, s.phoneB, s.id);
    ledger = reduce(s.phoneB.get(s.id)!);
    expect(ledger.records.find((r) => r.id === added.recordId)).toMatchObject({ voided: true, voidReason: "Duplicate of the bank line" });
    expect(ledger.records.find((r) => r.id === added.recordId)!.timeline.find((x) => x.type === "voided")).toMatchObject({ via: "Claude" });
    await expectSameBalances(t, secret, s.id, s.phoneA.get(s.id)!, s.phoneB.get(s.id)!);

    // Every appended event carries the attribution, outside the event envelope.
    const stored = await events(t, s.id);
    expect(stored.filter((e) => e.via === "Claude")).toHaveLength(4);
    const listedEvents = await s.leo.query<{ events: Array<Record<string, unknown> & { event: Record<string, unknown> }> }>("events:listEvents", { potId: s.id, afterSequence: 0n });
    const agentEvent = listedEvents.events.find((e) => (e.event as { eventId: string }).eventId === event.id)!;
    expect(agentEvent.via).toBe("Claude");
    expect(agentEvent.event).not.toHaveProperty("via");
  });

  test("a retried request id adds nothing twice; a reused one with other input is refused", async () => {
    const t = convexTest(schema, modules);
    const s = await sharedHousehold(t);
    const { secret } = await connectAgent(s.ana);
    const args = { household: s.id, request_id: "retry-0001", amount_minor_units: 1200, currency: "EUR", title: "Bread", split: { mode: "equal" } };
    const first = await ok(t, secret, "add_expense", args);
    const second = await ok(t, secret, "add_expense", args);
    expect(second.recordId).toBe(first.recordId);
    expect(second.replayed).toBe(true);
    expect((await events(t, s.id)).filter((e) => e.payload.kind === "expenseAdded")).toHaveLength(2);
    expect(await refused(t, secret, "add_expense", { ...args, amount_minor_units: 1300 })).toMatch(/already used for a different change/);
    expect(await refused(t, secret, "add_expense", { ...args, request_id: "short" })).toMatch(/request_id/);
  });

  test("amounts are whole minor units in the household's currency; ambiguous input is refused", async () => {
    const t = convexTest(schema, modules);
    const s = await sharedHousehold(t);
    const { secret } = await connectAgent(s.ana);
    const base = { household: s.id, title: "Lunch", split: { mode: "equal" } };
    expect(await refused(t, secret, "add_expense", { ...base, request_id: rid(), amount_minor_units: 1200, currency: "USD" }))
      .toMatch(/not the household's.*EUR/);
    expect(await refused(t, secret, "add_expense", { ...base, request_id: rid(), amount_minor_units: 12.5, currency: "EUR" }))
      .toMatch(/whole number of minor units/);
    expect(await refused(t, secret, "add_expense", { ...base, request_id: rid(), amount_minor_units: 0, currency: "EUR" }))
      .toMatch(/amount/i);
    expect(await refused(t, secret, "add_expense", { ...base, request_id: rid(), amount: 12, currency: "EUR" }))
      .toMatch(/no argument "amount"/);
    expect(await refused(t, secret, "add_expense", {
      ...base, request_id: rid(), amount_minor_units: 1000, currency: "EUR",
      split: { mode: "exact", shares: [{ who: s.coupleUnit, minor_units: 600 }, { who: s.leoId, minor_units: 300 }] },
    })).toMatch(/add up to 900, not 1000/);
    expect(await refused(t, secret, "add_repayment", {
      household: s.id, request_id: rid(), amount_minor_units: 100, currency: "EUR", from: s.anaId, to: s.miaId,
    })).toMatch(/two different people or groups/);
    expect(await refused(t, secret, "add_expense", { ...base, request_id: rid(), amount_minor_units: 100, currency: "EUR", paid_by: "nobody" }))
      .toMatch(/not in this household/);
    expect((await events(t, s.id)).filter((e) => e.payload.kind === "expenseAdded")).toHaveLength(1);
  });

  test("each switch refuses its own tools, by name, and leaves the others working", async () => {
    const t = convexTest(schema, modules);
    const s = await sharedHousehold(t, { money: false });
    const { id: connection, secret } = await connectAgent(s.ana);
    const listed = await s.ana.query<Array<{ id: string; permissions: Record<string, boolean> }>>("agentAccess:listMine", {});
    expect(listed[0]!.permissions).toEqual({ addRecords: true, editRecords: true, manageHousehold: true });

    const expense = () => ({ household: s.id, request_id: rid(), amount_minor_units: 500, currency: "EUR", title: "Milk", split: { mode: "equal" } });
    const switchOff = (permission: string, allowed = false) => s.ana.mutation("agentAccess:setPermission", { id: connection, permission, allowed });

    await switchOff("addRecords");
    expect(await refused(t, secret, "add_expense", expense())).toMatch(/"Add expenses and repayments" switch is off/);
    expect(await refused(t, secret, "add_repayment", { household: s.id, request_id: rid(), amount_minor_units: 100, currency: "EUR", from: s.leoId, to: s.anaId }))
      .toMatch(/"Add expenses and repayments" switch is off/);
    await ok(t, secret, "rename_household", { household: s.id, request_id: rid(), name: "Casa Nueva" });
    await switchOff("addRecords", true);
    const added = await ok(t, secret, "add_expense", expense());

    await switchOff("editRecords");
    expect(await refused(t, secret, "edit_record", { household: s.id, request_id: rid(), record_id: added.recordId, revision: added.revision, title: "Oat milk" }))
      .toMatch(/"Edit and void records" switch is off/);
    expect(await refused(t, secret, "void_record", { household: s.id, request_id: rid(), record_id: added.recordId, reason: "x" }))
      .toMatch(/"Edit and void records" switch is off/);

    await switchOff("manageHousehold");
    for (const [name, args] of [
      ["rename_household", { name: "Other" }],
      ["add_person", { name: "Zoe" }],
      ["update_groups", { groups: [] }],
      ["create_invite", { member_id: s.miaId }],
    ] as const) {
      expect(await refused(t, secret, name, { household: s.id, request_id: rid(), ...args })).toMatch(/"Manage the household" switch is off/);
    }
    // Reading never needs a switch.
    await ok(t, secret, "get_balances", { household: s.id });

    // The activity list keeps the tool and the outcome only.
    const activity = await s.ana.query<Array<Record<string, unknown>>>("agentAccess:recentActivity", {});
    expect(activity.find((row) => row.tool === "add_expense" && row.ok === false)).toBeDefined();
    expect(Object.keys(activity[0]!).sort()).toEqual(["agent", "at", "id", "ok", "tool"]);

    // Someone else's connection can't be switched.
    const leoSecret = await connectAgent(s.leo);
    await expect(s.ana.mutation("agentAccess:setPermission", { id: leoSecret.id, permission: "addRecords", allowed: false })).rejects.toThrow();
  });

  test("a connection made before writes stays read-only until switched on", async () => {
    const t = convexTest(schema, modules);
    const s = await sharedHousehold(t);
    const { id, secret } = await connectAgent(s.ana);
    await t.run(async (ctx) => { await ctx.db.patch(id as never, { permissions: undefined }); });
    const listed = await s.ana.query<Array<{ permissions: Record<string, boolean> }>>("agentAccess:listMine", {});
    expect(listed[0]!.permissions).toEqual({ addRecords: false, editRecords: false, manageHousehold: false });
    expect(await refused(t, secret, "add_expense", { household: s.id, request_id: rid(), amount_minor_units: 1, currency: "EUR", title: "x", split: { mode: "equal" } }))
      .toMatch(/switch is off/);
    await ok(t, secret, "list_records", { household: s.id });
    await s.ana.mutation("agentAccess:setPermission", { id, permission: "addRecords", allowed: true });
    await ok(t, secret, "add_expense", { household: s.id, request_id: rid(), amount_minor_units: 1, currency: "EUR", title: "x", split: { mode: "equal" } });
  });

  test("an agent stops at the household its person left, and at a disconnect", async () => {
    const t = convexTest(schema, modules);
    const s = await sharedHousehold(t);
    const { secret } = await connectAgent(s.leo, "Codex");
    await ok(t, secret, "add_expense", { household: s.id, request_id: rid(), amount_minor_units: 700, currency: "EUR", title: "Soap", split: { mode: "equal" } });
    await leaveOnline(s.leo, s.phoneB, s.id);
    expect(await refused(t, secret, "add_expense", { household: s.id, request_id: rid(), amount_minor_units: 700, currency: "EUR", title: "Soap", split: { mode: "equal" } }))
      .toMatch(/no longer an active member/);
    const other = await connectAgent(s.ana);
    await s.ana.mutation("agentAccess:disconnect", { id: other.id });
    const response = await t.fetch("/mcp", { method: "POST", headers: { authorization: `Bearer ${other.secret}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "add_expense", arguments: {} } }) });
    expect(response.status).toBe(401);
  });

  test("household management goes through the owner's own rules", async () => {
    const t = convexTest(schema, modules);
    await fenceBuild11(t);
    const s = await sharedHousehold(t, { money: false });
    const { secret } = await connectAgent(s.ana, "Claude Code");

    await ok(t, secret, "rename_household", { household: s.id, request_id: rid(), name: "Piso Sol" });
    const person = await ok(t, secret, "add_person", { household: s.id, request_id: rid(), name: "Zoe" });
    const grouped = await ok(t, secret, "update_groups", { household: s.id, request_id: rid(), groups: [[s.leoId, person.memberId]] });
    expect(grouped.groups[0].memberIds).toEqual([s.leoId, person.memberId]);
    await pull(s.ana, s.phoneA, s.id);
    let a = s.phoneA.get(s.id)!;
    expect(a.name).toBe("Piso Sol");
    expect(a.people.map((p) => p.name)).toContain("Zoe");
    // Ana and Mia are now on their own; Leo and Zoe pay together.
    expect(a.groups.find((g) => g.memberIds.includes(s.leoId))!.memberIds.sort()).toEqual([s.leoId, person.memberId].sort());
    expect(a.groups.find((g) => g.memberIds.includes(s.anaId))!.memberIds).toEqual([s.anaId]);

    // An invite code the new person can claim. A retry gives the same code; a second code needs replace_existing.
    const inviteArgs = { household: s.id, request_id: "invite-zoe-0001", member_id: person.memberId };
    const invite = await ok(t, secret, "create_invite", inviteArgs);
    expect(invite.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(invite.link).toBe(`http://127.0.0.1:3211/join/${invite.link.split("/join/")[1]}`);
    expect((await ok(t, secret, "create_invite", inviteArgs)).code).toBe(invite.code);
    expect(await refused(t, secret, "create_invite", { ...inviteArgs, request_id: rid() })).toMatch(/already has a live invite code/);
    const replaced = await ok(t, secret, "create_invite", { ...inviteArgs, request_id: rid(), replace_existing: true });
    expect(replaced.code).not.toBe(invite.code);
    const zoe = await signIn(t, "zoe");
    const fetchFromSite = ((url: string, init?: RequestInit) => t.fetch(new URL(url).pathname + new URL(url).search, init)) as typeof fetch;
    expect((await resolveInvite("http://127.0.0.1:3211", invite.code, fetchFromSite)).status).toBe("revoked");
    const preview = await resolveInvite("http://127.0.0.1:3211", replaced.code, fetchFromSite);
    expect(preview.status).toBe("active");
    if (preview.status !== "active") return;
    expect(await claimInvite(zoe, phone(), preview)).toEqual({ status: "joined", householdId: s.id });
    expect(await refused(t, secret, "create_invite", { ...inviteArgs, request_id: rid() })).toMatch(/already joined/);

    // Once money is recorded, groups are locked, as in the app. A member who isn't the owner can't manage.
    await ok(t, secret, "add_expense", { household: s.id, request_id: rid(), amount_minor_units: 900, currency: "EUR", title: "Pizza", split: { mode: "equal", per_person: true } });
    expect(await refused(t, secret, "update_groups", { household: s.id, request_id: rid(), groups: [] })).toMatch(/Groups can't change once/);
    const leoAgent = await connectAgent(s.leo);
    expect(await refused(t, leoAgent.secret, "rename_household", { household: s.id, request_id: rid(), name: "Mine" }))
      .toMatch(/Only the household's owner/);

    await pull(s.ana, s.phoneA, s.id);
    a = s.phoneA.get(s.id)!;
    await expectSameBalances(t, secret, s.id, a);
    // Structural changes carry the attribution too.
    const stored = await events(t, s.id);
    expect(stored.filter((e) => ["potRenamed", "memberAdded", "groupChanged"].includes(e.payload.kind) && e.via === "Claude Code")).toHaveLength(3);
  });

  test("until Swift build 11 is fenced out, notes stay off the wire and the agent is told", async () => {
    const t = convexTest(schema, modules);
    const s = await sharedHousehold(t);
    const { secret } = await connectAgent(s.ana);
    const added = await ok(t, secret, "add_expense", {
      household: s.id, request_id: rid(), amount_minor_units: 1500, currency: "EUR", title: "Water", category: "bills", note: "Q3", split: { mode: "equal" },
    });
    expect(added.warnings[0]).toMatch(/note wasn't saved/);
    const repaid = await ok(t, secret, "add_repayment", {
      household: s.id, request_id: rid(), amount_minor_units: 500, currency: "EUR", from: s.leoId, to: s.anaId, method: "cash",
    });
    expect(repaid.warnings[0]).toMatch(/method and note weren't saved/);
    const stored = await events(t, s.id);
    expect(stored.find((e) => e.recordId === added.recordId)!.textFields).toEqual(["title", "category"]);
    expect(stored.find((e) => e.recordId === repaid.recordId)!.textFields).toEqual(["title"]);
  });

  test("until Swift build 11 is fenced out, a group has at most two people", async () => {
    const t = convexTest(schema, modules);
    const s = await sharedHousehold(t, { money: false });
    const { secret } = await connectAgent(s.ana);
    expect(await refused(t, secret, "update_groups", { household: s.id, request_id: rid(), groups: [[s.anaId, s.miaId, s.leoId]] }))
      .toMatch(/at most 2 people/);
    await ok(t, secret, "update_groups", { household: s.id, request_id: rid(), groups: [[s.anaId, s.leoId]] });
  });

  test(`writes have their own limit of ${writesPerMinute} a minute`, async () => {
    const t = convexTest(schema, modules);
    const s = await sharedHousehold(t);
    const { secret } = await connectAgent(s.ana);
    for (let i = 0; i < writesPerMinute; i += 1) {
      await ok(t, secret, "add_expense", { household: s.id, request_id: `burst-${i}-000`, amount_minor_units: 100 + i, currency: "EUR", title: "Snack", split: { mode: "equal" } });
    }
    expect(await refused(t, secret, "add_expense", { household: s.id, request_id: rid(), amount_minor_units: 1, currency: "EUR", title: "x", split: { mode: "equal" } }))
      .toMatch(/Too many changes in a minute/);
    // Reading still works.
    await ok(t, secret, "list_households", {});
  });
});

describe("review fixes (PR #31)", () => {
  const purge = makeFunctionReference<"mutation">("agentWrites:purgeExpiredRequests");
  const ageRequests = (t: T) => t.run(async (ctx) => {
    for (const row of await ctx.db.query("agentRequests").collect()) await ctx.db.patch(row._id, { expiresAt: Date.now() - 1 });
  });

  test("B1 an hourly job deletes expired request rows, so none outlives the policy's 24 hours", async () => {
    // The job is registered, hourly.
    const job = (crons as unknown as { crons: Record<string, { name: string; schedule: { type: string } }> }).crons["purge expired agent requests"]!;
    expect(job.name).toBe("agentWrites:purgeExpiredRequests");
    expect(job.schedule.type).toBe("hourly");
    // A row stops answering retries after 23 hours; the next hourly run is within the 24th.
    expect(requestKeepMillis + 3_600_000).toBeLessThanOrEqual(24 * 3_600_000);

    const t = convexTest(schema, modules);
    const s = await sharedHousehold(t);
    const { secret } = await connectAgent(s.ana);
    await ok(t, secret, "add_expense", { household: s.id, request_id: rid(), amount_minor_units: 4321, currency: "EUR", title: "Rent", split: { mode: "equal" } });
    await ok(t, secret, "add_expense", { household: s.id, request_id: rid(), amount_minor_units: 1234, currency: "EUR", title: "Gas", split: { mode: "equal" } });
    await t.run(async (ctx) => {
      const [old] = await ctx.db.query("agentRequests").collect();
      await ctx.db.patch(old!._id, { expiresAt: Date.now() - 3_600_000 });
    });
    // Reads alone remove nothing; the job does, and leaves the row that is still live.
    await ok(t, secret, "list_records", { household: s.id });
    expect(await t.mutation(purge, {})).toEqual({ deleted: 1 });
    const rows = await t.run(async (ctx) => ctx.db.query("agentRequests").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.expiresAt).toBeGreaterThan(Date.now());
  });

  test("B1 the purge works in bounded batches and schedules itself until none are left", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      const s = await sharedHousehold(t, { leoJoins: false });
      const { id } = await connectAgent(s.ana);
      const total = requestPurgeBatch * 2 + 7;
      await t.run(async (ctx) => {
        const connection = await ctx.db.get(id as never) as unknown as { accountId: never };
        for (let i = 0; i < total; i += 1) {
          await ctx.db.insert("agentRequests", {
            connectionId: id as never, accountId: connection.accountId, requestId: `old-request-${i}`, tool: "add_expense",
            inputHash: "x", result: "{}", createdAt: 1, expiresAt: Date.now() - 1,
          });
        }
      });
      expect(await t.mutation(purge, {})).toEqual({ deleted: requestPurgeBatch });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(await t.run(async (ctx) => ctx.db.query("agentRequests").collect())).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // UTC+13 (New Zealand summer), UTC+14 (Kiribati, Line Islands) and UTC-11 (American Samoa).
  for (const zone of ["Pacific/Auckland", "Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
    test(`B2 a dated record shows on the day asked for to a viewer in ${zone}`, async () => {
      const t = convexTest(schema, modules);
      const s = await sharedHousehold(t);
      const { secret } = await connectAgent(s.ana);
      const added = await ok(t, secret, "add_expense", {
        household: s.id, request_id: rid(), amount_minor_units: 1000, currency: "EUR", title: "Dinner",
        split: { mode: "equal" }, date: "2026-11-05", time_zone: zone,
      });
      const paid = await ok(t, secret, "add_repayment", {
        household: s.id, request_id: rid(), amount_minor_units: 500, currency: "EUR", from: s.leoId, to: s.anaId,
        date: "2026-11-06", time_zone: zone,
      });
      const listed = await ok(t, secret, "list_records", { household: s.id, record_id: added.recordId });
      await ok(t, secret, "edit_record", {
        household: s.id, request_id: rid(), record_id: added.recordId, revision: listed.records[0].revision, date: "2026-11-07",
      });
      const rows = await events(t, s.id) as unknown as Array<{ recordId?: string; originatingTimeZone: string; occurredAtMillis: bigint }>;
      for (const row of rows.filter((r) => r.recordId === added.recordId || r.recordId === paid.recordId)) {
        expect(row.originatingTimeZone).toBe(zone);
      }
      // The phone reads dates in its own zone (mapping.ts localISO), as a real phone in that zone does.
      vi.stubEnv("TZ", zone);
      expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(zone);
      await pull(s.ana, s.phoneA, s.id);
      const records = reduce(s.phoneA.get(s.id)!).records;
      expect(records.find((r) => r.id === added.recordId)!.expense!.date).toBe("2026-11-07");
      expect(records.find((r) => r.id === paid.recordId)!.settlement!.date).toBe("2026-11-06");
    });
  }

  test("B2 without time_zone, the date is placed in the zone of the person's phone", async () => {
    const t = convexTest(schema, modules);
    const s = await sharedHousehold(t);
    await t.run(async (ctx) => {
      const account = (await ctx.db.query("accounts").collect()).find((a) => a.publicAccountId === "account-ana")!;
      await ctx.db.insert("pushTokens", { accountId: account._id, deviceToken: "ana-phone", environment: "sandbox", timeZone: "Pacific/Kiritimati", updatedAt: 1 });
    });
    const { secret } = await connectAgent(s.ana);
    const added = await ok(t, secret, "add_expense", {
      household: s.id, request_id: rid(), amount_minor_units: 1000, currency: "EUR", title: "Dinner", split: { mode: "equal" }, date: "2026-11-05",
    });
    const row = (await events(t, s.id) as unknown as Array<{ recordId?: string; originatingTimeZone: string; occurredAtMillis: bigint }>)
      .find((r) => r.recordId === added.recordId)!;
    expect(row.originatingTimeZone).toBe("Pacific/Kiritimati");
    expect(Number(row.occurredAtMillis)).toBe(Date.UTC(2026, 10, 4, 22)); // noon at UTC+14
  });

  test("B2 localNoon is noon on that day in the zone, across offsets and daylight saving", () => {
    expect(localNoon(2026, 11, 5, "Pacific/Auckland")).toBe(Date.UTC(2026, 10, 4, 23)); // NZDT, +13
    expect(localNoon(2026, 6, 5, "Pacific/Auckland")).toBe(Date.UTC(2026, 5, 5, 0)); // NZST, +12
    expect(localNoon(2026, 11, 5, "Pacific/Kiritimati")).toBe(Date.UTC(2026, 10, 4, 22));
    expect(localNoon(2026, 11, 5, "Pacific/Pago_Pago")).toBe(Date.UTC(2026, 10, 5, 23));
    expect(localNoon(2026, 3, 29, "Europe/Madrid")).toBe(Date.UTC(2026, 2, 29, 10)); // the day clocks go forward
    expect(localNoon(2026, 11, 5, "UTC")).toBe(Date.UTC(2026, 10, 5, 12));
  });

  test("nit 1 after leaving the household, a replayed request id is refused too", async () => {
    const t = convexTest(schema, modules);
    const s = await sharedHousehold(t);
    const { secret } = await connectAgent(s.leo, "Leo agent");
    const args = { household: s.id, request_id: "leave-replay-01", amount_minor_units: 900, currency: "EUR", title: "Snacks", split: { mode: "equal" } };
    await ok(t, secret, "add_expense", args);
    await pull(s.leo, s.phoneB, s.id);
    await leaveOnline(s.leo, s.phoneB, s.id);
    expect(await refused(t, secret, "add_expense", { ...args, request_id: "leave-replay-02" })).toMatch(/no longer an active member/);
    expect(await refused(t, secret, "add_expense", args)).toMatch(/no longer an active member/);
  });

  test("nit 2 prototype names are unknown arguments", async () => {
    const t = convexTest(schema, modules);
    const s = await sharedHousehold(t, { leoJoins: false });
    const { secret } = await connectAgent(s.ana);
    expect(await refused(t, secret, "list_households", { constructor: "x" })).toMatch(/has no argument "constructor"/);
    expect(await refused(t, secret, "list_households", { toString: "y" })).toMatch(/has no argument "toString"/);
  });

  test("nit 4 a setup-prompt connection is read-only unless the app sends the switches", async () => {
    const t = convexTest(schema, modules);
    const s = await sharedHousehold(t, { leoJoins: false });
    const old = await connectAgent(s.ana, "Old app", null);
    const current = await connectAgent(s.ana, "Current app");
    const listed = await s.ana.query<Array<{ id: string; permissions: Record<string, boolean> }>>("agentAccess:listMine", {});
    expect(listed.find((c) => c.id === old.id)!.permissions).toEqual({ addRecords: false, editRecords: false, manageHousehold: false });
    expect(listed.find((c) => c.id === current.id)!.permissions).toEqual(ALL_ON);
    const expense = { household: s.id, amount_minor_units: 100, currency: "EUR", title: "Tea", split: { mode: "equal" } };
    expect(await refused(t, old.secret, "add_expense", { ...expense, request_id: rid() })).toMatch(/switch is off/);
    await ok(t, current.secret, "add_expense", { ...expense, request_id: rid() });
  });

  test("nit 5 a create_invite request id used again after its answer is purged makes a new invite", async () => {
    const t = convexTest(schema, modules);
    await fenceBuild11(t);
    const s = await sharedHousehold(t, { leoJoins: false });
    const { secret } = await connectAgent(s.ana);
    const args = { household: s.id, request_id: "invite-mia-0001", member_id: s.miaId };
    const first = await ok(t, secret, "create_invite", args);
    expect((await ok(t, secret, "create_invite", args)).code).toBe(first.code);
    await ageRequests(t);
    await t.mutation(purge, {});
    const again = await ok(t, secret, "create_invite", { ...args, replace_existing: true });
    expect(again.replayed).toBeUndefined();
    expect(again.code).not.toBe(first.code);
    expect(again.link).not.toBe(first.link);
    // The invite errors the shared helper can still raise read as sentences, not codes.
    for (const code of ["INVITE_CODE_UNAVAILABLE", "INVITE_SECRET_ALREADY_USED"]) {
      expect(errorText(new ConvexError({ code }))).toMatch(/new request_id/);
    }
  });
});
