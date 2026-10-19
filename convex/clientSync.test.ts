// End-to-end check of the Expo app's sync engine (app/src/sync) against these backend functions:
// two simulated phones create, promote, invite, join, add, edit, void, repay and pull, and must
// always agree on every balance.
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { reduce } from "../app/src/core/ledger";
import type { Household, LedgerEvent } from "../app/src/core/types";
import {
  adoptPots,
  addPersonOnline,
  deleteHouseholdOnline,
  removePersonOnline,
  claimInvite,
  flush,
  issueInvites,
  pull,
  resolveInvite,
  startSync,
  type Access,
  type Backend,
} from "../app/src/sync/engine";
import { isUuidv7 } from "../app/src/sync/uuid";
import { toWire } from "../app/src/sync/mapping";
import { runDeletion, type PendingDeletion } from "../app/src/sync/accountDeletion";
import { hashRefreshToken } from "./lib/sessionTokens";
import terminalCodes from "../contracts/event-terminal-codes.json";
import { TERMINAL_EVENT_CODES } from "../app/src/sync/terminal";
import { KNOWN_TIME_ZONES } from "../app/src/sync/timezones";
import { MAX_GROUP_SIZE } from "../app/src/core/types";
import { EXTENDED_CONTRACT, LEGACY_CONTRACT, setContract } from "../app/src/sync/contract";
import { maximumBudgetGroupSize } from "./lib/budgetGroupTopology";
import { ios18TimeZoneIdentifiers } from "./lib/ios18TimeZoneIdentifiers";
import schema from "./schema";
import { modules } from "./test.setup";

beforeEach(() => {
  vi.stubEnv("NUMA_SHARED_PRODUCT", "numa-shared");
  vi.stubEnv("NUMA_SHARED_DEPLOYMENT_CLASS", "anonymous-local");
  vi.stubEnv("NUMA_SHARED_DEPLOYMENT_NAME", "anonymous-agent");
  vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3210");
  vi.stubEnv("CONVEX_SITE_URL", "http://127.0.0.1:3211");
  vi.stubEnv("NUMA_SHARED_TOKEN_HASH_SECRET", "client-sync-test-token-hash-secret-32-bytes");
  vi.stubEnv("NUMA_SHARED_SESSION_ISSUER", "https://auth.numa.shared");
  vi.stubEnv("NUMA_SHARED_SESSION_AUDIENCE", "tech.arsik.numashared");
});

afterEach(() => { vi.unstubAllEnvs(); setContract(LEGACY_CONTRACT); });

type T = ReturnType<typeof convexTest>;

/** Production stops serving Swift build 11, which opens the wider contract on both ends. */
async function fenceBuild11(t: T) {
  await t.run(async (ctx) => {
    await ctx.db.insert("appConfiguration", { key: "global", minimumSupportedBuild: 12, updatedAt: 1 });
  });
  setContract(EXTENDED_CONTRACT);
}

async function signIn(t: T, name: string): Promise<Backend> {
  await t.run(async (ctx) => {
    const accountId = await ctx.db.insert("accounts", {
      publicAccountId: `account-${name}`,
      appleSubjectHash: `apple-${name}`,
      createdAt: 1,
    });
    await ctx.db.insert("sessions", {
      sessionId: `session-${name}-0000001`,
      accountId,
      refreshTokenHash: `refresh-${name}`,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      createdAt: 1,
      rotatedAt: 1,
    });
  });
  const who = t.withIdentity({
    issuer: "https://auth.numa.shared",
    subject: `account-${name}`,
    sid: `session-${name}-0000001`,
    numa_session_audience: "tech.arsik.numashared",
    token_use: "access",
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
    put: (h) => {
      const i = list.findIndex((x) => x.id === h.id);
      if (i >= 0) list[i] = h;
      else list.push(h);
    },
    remove: (id) => {
      const i = list.findIndex((x) => x.id === id);
      if (i >= 0) list.splice(i, 1);
    },
    all: () => list,
  };
}

const later = () => Date.now() + 60_000;
const balances = (h: Household) => reduce(h).balances;

function append(access: Access, id: string, e: LedgerEvent) {
  const h = access.get(id)!;
  access.put({ ...h, events: [...h.events, e] });
}

/** A household made on one phone before sync, with the app's old-style ids. */
function localHousehold(): Household {
  const at = Date.now() - 60_000;
  return {
    id: "h_local",
    name: "Casa Prueba",
    currency: "EUR",
    createdAt: at,
    youId: "p_you",
    people: [
      { id: "p_you", name: "Ana", groupId: "g_couple", joined: true },
      { id: "p_mia", name: "Mia", groupId: "g_couple", joined: false },
      { id: "p_leo", name: "Leo", groupId: "g_leo", joined: false },
    ],
    groups: [
      { id: "g_couple", color: "citrus", memberIds: ["p_you", "p_mia"] },
      { id: "g_leo", color: "lilac", memberIds: ["p_leo"] },
    ],
    events: [{
      id: "e_1", at, by: "p_you", kind: "expenseAdded", recordId: "r_1",
      content: {
        payerId: "p_mia", amount: 9_000, date: new Date(at).toISOString().slice(0, 10), category: "groceries",
        note: "Apples, bread and coffee",
        split: { mode: "equal", groupIds: ["g_couple", "g_leo"], weighting: "group" },
      },
    }],
    seen: {},
    inviteCode: "ABC234",
  };
}

describe("app sync engine against the backend", () => {
  test("client contract copies match the backend", () => {
    expect([...TERMINAL_EVENT_CODES].sort()).toEqual([...terminalCodes].sort());
    expect([...KNOWN_TIME_ZONES].sort()).toEqual([...ios18TimeZoneIdentifiers].sort());
    expect(MAX_GROUP_SIZE).toBe(maximumBudgetGroupSize);
  });

  test("a household with a group of three shares and syncs", async () => {
    const t = convexTest(schema, modules);
    await fenceBuild11(t);
    const ana = await signIn(t, "ana");
    const phoneA = phone();
    const local = localHousehold();
    phoneA.put({
      ...local,
      people: [...local.people.map((p) => (p.id === "p_leo" ? { ...p, groupId: "g_couple" } : p)),
        { id: "p_zoe", name: "Zoe", groupId: "g_zoe", joined: false }],
      groups: [
        { id: "g_couple", color: "citrus", memberIds: ["p_you", "p_mia", "p_leo"] },
        { id: "g_zoe", color: "lilac", memberIds: ["p_zoe"] },
      ],
      events: local.events.map((e) => (e.kind === "expenseAdded"
        ? { ...e, content: { ...e.content, split: { mode: "equal" as const, groupIds: ["g_couple", "g_zoe"], weighting: "person" as const } } }
        : e)),
    });
    const id = await startSync(ana, phoneA, "h_local");
    await pull(ana, phoneA, id);
    const a = phoneA.get(id)!;
    const family = a.groups.find((g) => g.memberIds.length === 3)!;
    expect(family.serverGroupId).toBeDefined();
    expect(a.events[0].seq).toBeGreaterThan(0);
    // Per-person weighting: the family carries three quarters of the 90.00.
    const zoeUnit = a.groups.find((g) => g.memberIds.length === 1)!.id;
    expect(balances(a)).toEqual({ [family.id]: 2_250, [zoeUnit]: -2_250 });
  });

  test("events recorded on this phone in someone else's name still share and send", async () => {
    // Sheet imports made by an earlier build named each payer as the recorder; the server only
    // accepts events from the member sending them.
    const t = convexTest(schema, modules);
    const ana = await signIn(t, "ana");
    const phoneA = phone();
    const local = localHousehold();
    phoneA.put({ ...local, events: local.events.map((e) => ({ ...e, by: "p_mia" })) });
    const id = await startSync(ana, phoneA, "h_local");
    const h = phoneA.get(id)!;
    expect(h.events.every((e) => e.by === h.youId && e.seq)).toBe(true);
    const mia = h.people.find((p) => p.name === "Mia")!.id;
    const at = Date.now() - 60_000;
    append(phoneA, id, { id: "e_2", at, by: mia, kind: "settlementRecorded", recordId: "r_2",
      content: { fromGroupId: h.groups[1].id, toGroupId: h.groups[0].id, amount: 1_000, date: new Date(at).toISOString().slice(0, 10) } });
    expect(await flush(ana, phoneA, id, later)).toBe("done");
    const after = phoneA.get(id)!;
    expect(after.events.every((e) => e.by === after.youId && e.seq)).toBe(true);
  });

  test("two phones create, invite, join, record and always agree", async () => {
    const t = convexTest(schema, modules);
    await fenceBuild11(t);
    const ana = await signIn(t, "ana");
    const leo = await signIn(t, "leo");
    const phoneA = phone();
    const phoneB = phone();

    // Ana's phone promotes the local household, keeping its first expense.
    phoneA.put(localHousehold());
    const id = await startSync(ana, phoneA, "h_local");
    expect(isUuidv7(id)).toBe(true);
    expect(phoneA.get("h_local")).toBeUndefined();
    let a = phoneA.get(id)!;
    expect(a.sync?.setup).toBeUndefined();
    expect(a.events[0].seq).toBeGreaterThan(0);
    expect(a.groups.find((g) => g.memberIds.length === 2)?.serverGroupId).toBeDefined();

    await pull(ana, phoneA, id);
    a = phoneA.get(id)!;
    expect(a.name).toBe("Casa Prueba");
    expect(a.people.map((p) => p.name).sort()).toEqual(["Ana", "Leo", "Mia"]);
    expect(a.events).toHaveLength(1);
    expect(a.events[0].kind === "expenseAdded" && a.events[0].content.note).toBe("Apples, bread and coffee");
    const leoId = a.people.find((p) => p.name === "Leo")!.id;
    const coupleUnit = a.groups.find((g) => g.memberIds.length === 2)!.id;
    const leoUnit = a.people.find((p) => p.name === "Leo")!.groupId;
    expect(balances(a)).toEqual({ [coupleUnit]: 4_500, [leoUnit]: -4_500 });

    // Ana invites; Leo looks the code up on the public join endpoint and claims it.
    await issueInvites(ana, phoneA, id);
    a = phoneA.get(id)!;
    const leoInvite = a.sync!.invites![leoId];
    expect(leoInvite.issued).toBe(true);
    expect(leoInvite.code).toMatch(/^[A-Z2-9]{6}$/);
    const fetchFromSite = ((url: string, init?: RequestInit) => t.fetch(new URL(url).pathname + new URL(url).search, init)) as typeof fetch;
    const preview = await resolveInvite("http://127.0.0.1:3211", leoInvite.code.slice(0, 3) + " " + leoInvite.code.slice(3), fetchFromSite);
    expect(preview.status).toBe("active");
    if (preview.status !== "active") return;
    expect(preview.potName).toBe("Casa Prueba");
    const joined = await claimInvite(leo, phoneB, preview);
    expect(joined).toEqual({ status: "joined", householdId: id });
    let b = phoneB.get(id)!;
    expect(b.youId).toBe(leoId);
    expect(b.sync?.role).toBe("member");
    expect(balances(b)).toEqual(balances(a));
    expect(b.events[0].kind === "expenseAdded" && b.events[0].content.payerId).toBe(a.people.find((p) => p.name === "Mia")!.id);

    // Leo adds an expense; it waits out the undo window, then goes up.
    append(phoneB, id, {
      id: "01890f5e-7b00-7000-8000-00000000a001", at: Date.now(), by: leoId, kind: "expenseAdded",
      recordId: "01890f5e-7b00-7000-8000-00000000a002",
      content: {
        payerId: leoId, amount: 3_001, date: "2026-10-01", category: "internet",
        split: { mode: "equal", groupIds: [b.groups[1].id, b.groups[0].id], weighting: "group" },
      },
    });
    expect(await flush(leo, phoneB, id)).toBe("waiting");
    expect(await flush(leo, phoneB, id, later)).toBe("done");
    await pull(ana, phoneA, id);
    a = phoneA.get(id)!;
    b = phoneB.get(id)!;
    expect(balances(a)).toEqual(balances(b));
    const internet = a.events.find((e) => e.recordId === "01890f5e-7b00-7000-8000-00000000a002")!;
    expect(internet.kind === "expenseAdded" && internet.content.date).toBe("2026-10-01");
    expect(internet.kind === "expenseAdded" && internet.content.split.mode).toBe("equal");

    // Ana edits her first expense with a reason, then repays Leo with a method and a note.
    const first = a.events[0];
    append(phoneA, id, {
      id: "01890f5e-7b00-7000-8000-00000000b001", at: Date.now() - 20_000, by: a.youId, kind: "expenseRevised",
      recordId: first.recordId, basis: { kind: "parent", parentEventId: first.id }, reason: "Forgot the milk",
      content: { ...(first.kind === "expenseAdded" ? first.content : ({} as never)), amount: 9_300 },
    });
    const ab = balances(phoneA.get(id)!);
    const owing = Object.entries(ab).find(([, v]) => v < 0)!;
    const owed = Object.entries(ab).find(([, v]) => v > 0)!;
    append(phoneA, id, {
      id: "01890f5e-7b00-7000-8000-00000000b002", at: Date.now() - 15_000, by: a.youId, kind: "settlementRecorded",
      recordId: "01890f5e-7b00-7000-8000-00000000b003",
      content: { fromGroupId: owing[0], toGroupId: owed[0], amount: 1_000, date: "2026-10-02", method: "bank", note: "Half now, half on Friday" },
    });
    expect(await flush(ana, phoneA, id)).toBe("done");

    // Leo voids his internet expense.
    append(phoneB, id, {
      id: "01890f5e-7b00-7000-8000-00000000c001", at: Date.now() - 20_000, by: leoId, kind: "recordVoided",
      recordId: "01890f5e-7b00-7000-8000-00000000a002", reason: "Added twice",
    });
    await pull(leo, phoneB, id);
    expect(await flush(leo, phoneB, id)).toBe("done");
    await pull(ana, phoneA, id);
    await pull(leo, phoneB, id);
    a = phoneA.get(id)!;
    b = phoneB.get(id)!;
    expect(balances(a)).toEqual(balances(b));
    const repay = b.events.find((e) => e.kind === "settlementRecorded")!;
    expect(repay.kind === "settlementRecorded" && repay.content).toMatchObject({ method: "bank", note: "Half now, half on Friday", amount: 1_000 });
    const edit = b.events.find((e) => e.kind === "expenseRevised")!;
    expect(edit.kind === "expenseRevised" && edit.reason).toBe("Forgot the milk");
    expect(reduce(b).byId["01890f5e-7b00-7000-8000-00000000a002"].voided).toBe(true);
    expect(a.events.every((e) => e.seq !== undefined)).toBe(true);
    expect(a.events.map((e) => e.id)).toEqual(b.events.map((e) => e.id));

    // A person added later gets their own group and a code of their own.
    const zoe = await addPersonOnline(ana, phoneA, id, "Zoe");
    await issueInvites(ana, phoneA, id);
    a = phoneA.get(id)!;
    expect(a.people.find((p) => p.id === zoe)?.name).toBe("Zoe");
    expect(a.groups.find((g) => g.memberIds.includes(zoe))?.memberIds).toEqual([zoe]);
    expect(a.sync!.invites![zoe].issued).toBe(true);
    await pull(leo, phoneB, id);
    expect(phoneB.get(id)!.people.some((p) => p.id === zoe)).toBe(true);
  });

  test("until Swift build 11 is fenced out, both ends keep its text and group-size contract", async () => {
    const t = convexTest(schema, modules);
    const ana = await signIn(t, "ana");
    const leo = await signIn(t, "leo");
    const phoneA = phone();
    const phoneB = phone();

    // The app won't share a group of three while build 11 can still read the household.
    const local = localHousehold();
    phoneA.put({
      ...local,
      id: "h_family",
      people: local.people.map((p) => (p.id === "p_leo" ? { ...p, groupId: "g_couple" } : p)),
      groups: [{ id: "g_couple", color: "citrus", memberIds: ["p_you", "p_mia", "p_leo"] }],
      events: [],
    });
    await expect(startSync(ana, phoneA, "h_family")).rejects.toThrow("group-too-large");

    // Notes, edit reasons and repayment details stay on the phone; the rest syncs.
    phoneA.put(localHousehold());
    const id = await startSync(ana, phoneA, "h_local");
    await pull(ana, phoneA, id);
    let a = phoneA.get(id)!;
    const first = a.events[0];
    append(phoneA, id, {
      id: "01890f5e-7b00-7000-8000-00000000e001", at: Date.now() - 20_000, by: a.youId, kind: "expenseRevised",
      recordId: first.recordId, basis: { kind: "parent", parentEventId: first.id }, reason: "Forgot the milk",
      content: { ...(first.kind === "expenseAdded" ? first.content : ({} as never)), amount: 9_300, note: "Milk too" },
    });
    const ab = balances(phoneA.get(id)!);
    append(phoneA, id, {
      id: "01890f5e-7b00-7000-8000-00000000e002", at: Date.now() - 15_000, by: a.youId, kind: "settlementRecorded",
      recordId: "01890f5e-7b00-7000-8000-00000000e003",
      content: {
        fromGroupId: Object.entries(ab).find(([, v]) => v < 0)![0], toGroupId: Object.entries(ab).find(([, v]) => v > 0)![0],
        amount: 1_000, date: "2026-10-02", method: "bank", note: "Half now",
      },
    });
    expect(await flush(ana, phoneA, id)).toBe("done");
    a = phoneA.get(id)!;
    expect(a.sync!.rejected ?? []).toEqual([]);

    await issueInvites(ana, phoneA, id);
    const leoId = a.people.find((p) => p.name === "Leo")!.id;
    const code = phoneA.get(id)!.sync!.invites![leoId].code;
    const fetchFromSite = ((url: string, init?: RequestInit) => t.fetch(new URL(url).pathname + new URL(url).search, init)) as typeof fetch;
    const preview = await resolveInvite("http://127.0.0.1:3211", code, fetchFromSite);
    if (preview.status !== "active") throw new Error(preview.status);
    await claimInvite(leo, phoneB, preview);
    const b = phoneB.get(id)!;
    expect(balances(b)).toEqual(balances(phoneA.get(id)!));
    for (const e of b.events) {
      if (e.kind === "expenseAdded" || e.kind === "expenseRevised") expect(e.content.note).toBeUndefined();
      if (e.kind === "expenseRevised") expect(e.reason).toBeUndefined();
      if (e.kind === "settlementRecorded") expect(e.content).not.toHaveProperty("method");
      if (e.kind === "settlementRecorded") expect(e.content.note).toBeUndefined();
    }
    expect(b.events.map((e) => e.kind)).toEqual(["expenseAdded", "expenseRevised", "settlementRecorded"]);

    // The server refuses the wider contract from any client, not just this one.
    const wire = toWire(phoneA.get(id)!, id, phoneA.get(id)!.sync!.schema, {
      ...first, id: "01890f5e-7b00-7000-8000-00000000e004", recordId: "01890f5e-7b00-7000-8000-00000000e005", seq: undefined,
    } as LedgerEvent, EXTENDED_CONTRACT);
    await expect(ana.mutation("events:appendEvents", { potId: id, events: [wire] })).rejects.toThrow("TEXT_FIELD_NOT_ALLOWED_NOTE");
  });

  test("an event the server can never accept is set aside, the rest still syncs", async () => {
    const t = convexTest(schema, modules);
    const ana = await signIn(t, "ana");
    const phoneA = phone();
    phoneA.put(localHousehold());
    const id = await startSync(ana, phoneA, "h_local");
    await pull(ana, phoneA, id);
    const a = phoneA.get(id)!;
    const leoGroup = a.groups.find((g) => g.memberIds.length === 1)!.id;
    // A void whose reason is only whitespace the app's own check misses (NEL): the client drops
    // the blank text, and the server refuses a void without a reason.
    append(phoneA, id, {
      id: "01890f5e-7b00-7000-8000-00000000d001", at: Date.now() - 20_000, by: a.youId, kind: "recordVoided",
      recordId: a.events[0].recordId, reason: "\u0085",
    });
    append(phoneA, id, {
      id: "01890f5e-7b00-7000-8000-00000000d002", at: Date.now() - 19_000, by: a.youId, kind: "settlementRecorded",
      recordId: "01890f5e-7b00-7000-8000-00000000d003",
      content: { fromGroupId: leoGroup, toGroupId: a.groups.find((g) => g.memberIds.length === 2)!.id, amount: 500, date: "2026-10-03" },
    });
    expect(await flush(ana, phoneA, id)).toBe("done");
    const after = phoneA.get(id)!;
    expect(after.sync!.rejected?.map((r) => r.code)).toEqual(["TEXT_FIELD_REQUIRED_REASON"]);
    expect(after.events.find((e) => e.id === "01890f5e-7b00-7000-8000-00000000d002")?.seq).toBeGreaterThan(0);
    expect(after.events.some((e) => e.id === "01890f5e-7b00-7000-8000-00000000d001")).toBe(false);
  });
  test("a changed opening balance reaches every phone", async () => {
    const t = convexTest(schema, modules);
    const ana = await signIn(t, "ana");
    const phoneA = phone();
    phoneA.put({ ...localHousehold(), events: [] });
    const id = await startSync(ana, phoneA, "h_local");
    await pull(ana, phoneA, id);
    let a = phoneA.get(id)!;
    const couple = a.groups.find((g) => g.memberIds.length === 2)!.id;
    const leo = a.groups.find((g) => g.memberIds.length === 1)!.id;
    const opening = "01890f5e-7b00-7000-8000-00000000f001";
    append(phoneA, id, {
      id: opening, at: Date.now() - 30_000, by: a.youId, kind: "openingBalanceSet", recordId: "01890f5e-7b00-7000-8000-00000000f002",
      content: { entries: [{ fromGroupId: leo, toGroupId: couple, amount: 10_000 }], date: "2026-10-01" },
    });
    append(phoneA, id, {
      id: "01890f5e-7b00-7000-8000-00000000f003", at: Date.now() - 25_000, by: a.youId, kind: "openingRevised",
      recordId: "01890f5e-7b00-7000-8000-00000000f002", basis: { kind: "parent", parentEventId: opening },
      content: { entries: [{ fromGroupId: leo, toGroupId: couple, amount: 20_000 }], date: "2026-10-01" },
    });
    expect(await flush(ana, phoneA, id)).toBe("done");
    a = phoneA.get(id)!;
    expect(balances(a)).toEqual({ [couple]: 20_000, [leo]: -20_000 });

    // Another phone signed in as Ana reads the change instead of stopping at 100.
    const phoneC = phone();
    await adoptPots(ana, phoneC);
    await pull(ana, phoneC, id);
    const c = phoneC.get(id)!;
    expect(c.sync!.paused).toBeUndefined();
    expect(balances(c)).toEqual(balances(a));
  });

  test("a money event this app can't read pauses sync and keeps the cursor before it", async () => {
    const t = convexTest(schema, modules);
    const ana = await signIn(t, "ana");
    const phoneA = phone();
    phoneA.put(localHousehold());
    const id = await startSync(ana, phoneA, "h_local");
    await pull(ana, phoneA, id);
    const before = phoneA.get(id)!;
    // The server hands out one event from a newer app, then one this app knows.
    const real = ana.query;
    const newer: Backend = {
      mutation: ana.mutation,
      query: async (fn, args) => {
        if (fn !== "events:listEvents") return real(fn, args);
        const at = BigInt(before.sync!.lastSeq);
        if ((args as { afterSequence: bigint }).afterSequence !== at) return { events: [], hasMore: false, nextAfterSequence: at } as never;
        const template = { ...(await real<{ events: Array<{ event: Record<string, unknown> }> }>("events:listEvents", { potId: id, afterSequence: 0n })).events.at(-1)! };
        const future = { ...template, serverSequence: at + 1n, event: { ...template.event, eventId: "01890f5e-7b00-7000-8000-00000000f101", payload: { kind: "budgetTransfer", recordId: "x" } } };
        const known = { ...template, serverSequence: at + 2n, event: { ...template.event, eventId: "01890f5e-7b00-7000-8000-00000000f102" } };
        return { events: [future, known], hasMore: false, nextAfterSequence: at + 2n } as never;
      },
    };
    await pull(newer, phoneA, id);
    const after = phoneA.get(id)!;
    expect(after.sync!.lastSeq).toBe(before.sync!.lastSeq);
    expect(after.sync!.paused?.code).toBe("UNREADABLE_EVENT");
    expect(after.events.some((e) => e.id === "01890f5e-7b00-7000-8000-00000000f102")).toBe(false);
    expect(await flush(ana, phoneA, id)).toBe("paused");
  });

  test("two phones editing the same expense at once see a contest, and keeping one settles it", async () => {
    const t = convexTest(schema, modules);
    const ana = await signIn(t, "ana");
    const leo = await signIn(t, "leo");
    const phoneA = phone();
    const phoneB = phone();
    phoneA.put(localHousehold());
    const id = await startSync(ana, phoneA, "h_local");
    await pull(ana, phoneA, id);
    await issueInvites(ana, phoneA, id);
    const leoId = phoneA.get(id)!.people.find((p) => p.name === "Leo")!.id;
    const site = ((url: string, init?: RequestInit) => t.fetch(new URL(url).pathname, init)) as typeof fetch;
    const preview = await resolveInvite("http://127.0.0.1:3211", phoneA.get(id)!.sync!.invites![leoId].code, site);
    if (preview.status !== "active") throw new Error(preview.status);
    await claimInvite(leo, phoneB, preview);

    const first = phoneA.get(id)!.events[0];
    if (first.kind !== "expenseAdded") throw new Error("expected an expense");
    const edit = (eventId: string, by: string, amount: number): LedgerEvent => ({
      id: eventId, at: Date.now() - 20_000, by, kind: "expenseRevised", recordId: first.recordId,
      basis: { kind: "parent", parentEventId: first.id }, content: { ...first.content, amount },
    });
    append(phoneA, id, edit("01890f5e-7b00-7000-8000-00000000f401", phoneA.get(id)!.youId, 9_500));
    append(phoneB, id, edit("01890f5e-7b00-7000-8000-00000000f402", leoId, 8_000));
    expect(await flush(ana, phoneA, id)).toBe("done");
    expect(await flush(leo, phoneB, id)).toBe("done");
    await pull(ana, phoneA, id);
    await pull(leo, phoneB, id);
    const contestedA = reduce(phoneA.get(id)!).byId[first.recordId];
    expect(contestedA.contested).toHaveLength(2);
    expect(balances(phoneA.get(id)!)).toEqual(balances(phoneB.get(id)!));

    // Ana keeps her own version.
    const [firstEventId, secondEventId] = [...contestedA.contested!].sort();
    append(phoneA, id, {
      id: "01890f5e-7b00-7000-8000-00000000f403", at: Date.now() - 10_000, by: phoneA.get(id)!.youId, kind: "expenseRevised",
      recordId: first.recordId, basis: { kind: "resolution", firstEventId, secondEventId }, content: { ...first.content, amount: 9_500 },
    });
    expect(await flush(ana, phoneA, id)).toBe("done");
    await pull(leo, phoneB, id);
    const settled = reduce(phoneB.get(id)!).byId[first.recordId];
    expect(settled.contested).toBeUndefined();
    expect(settled.expense!.amount).toBe(9_500);
    expect(balances(phoneB.get(id)!)).toEqual(balances(phoneA.get(id)!));
  });

  test("an expense undone while a pull is on the network stays undone", async () => {
    const t = convexTest(schema, modules);
    const ana = await signIn(t, "ana");
    const phoneA = phone();
    phoneA.put(localHousehold());
    const id = await startSync(ana, phoneA, "h_local");
    await pull(ana, phoneA, id);
    const a = phoneA.get(id)!;
    const pending = {
      ...a.events[0], id: "01890f5e-7b00-7000-8000-00000000f301", recordId: "01890f5e-7b00-7000-8000-00000000f302",
      at: Date.now(), seq: undefined,
    } as LedgerEvent;
    append(phoneA, id, pending);
    // The person taps Undo while the pull waits for the server.
    const undoing: Backend = {
      mutation: ana.mutation,
      query: async <R,>(fn: string, args: Record<string, unknown>) => {
        const result = await ana.query<R>(fn, args);
        if (fn === "events:listTextChangesWithSkippedRevisions") {
          const h = phoneA.get(id)!;
          phoneA.put({ ...h, events: h.events.filter((e) => e.id !== pending.id) });
        }
        return result;
      },
    };
    await pull(undoing, phoneA, id);
    expect(phoneA.get(id)!.events.some((e) => e.id === pending.id)).toBe(false);
  });

  test("deleting the account from the app erases it on the server and its households on the phone", async () => {
    vi.stubEnv("NUMA_SHARED_AUTH_KEY_ID", "client-sync");
    vi.stubEnv("NUMA_SHARED_AUTH_PRIVATE_KEY_PKCS8_PEM", "unused: deletion signs nothing");
    const t = convexTest(schema, modules);
    const ana = await signIn(t, "ana");
    const phoneA = phone();
    phoneA.put(localHousehold());
    const id = await startSync(ana, phoneA, "h_local");
    // The app holds a real refresh token for this session.
    const refreshToken = "client-sync-refresh-token-for-ana-0000000000000000";
    const refreshTokenHash = await hashRefreshToken(refreshToken, "client-sync-test-token-hash-secret-32-bytes");
    await t.run(async (ctx) => {
      const row = await ctx.db.query("sessions").filter((q) => q.eq(q.field("sessionId"), "session-ana-0000001")).unique();
      await ctx.db.patch(row!._id, { refreshTokenHash });
    });
    const post = async <T,>(path: string, body: unknown): Promise<T> => {
      const res = await t.fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const json = await res.json();
      if (!res.ok) throw new Error(JSON.stringify(json));
      return json as T;
    };
    const preview = await post<{ pots: Array<{ potId: string; outcome: string }> }>("/auth/account/deletion-preview", { refreshToken });
    expect(preview.pots).toEqual([expect.objectContaining({ potId: id, outcome: "deleted" })]);

    let saved: PendingDeletion | null = null;
    await runDeletion({
      post,
      read: async () => saved,
      write: async (p) => { saved = p; },
      session: () => ({ accountId: "account-ana", refreshToken }),
      purgeLocal: async () => { phoneA.remove(id); },
    });
    expect(phoneA.get(id)).toBeUndefined();
    expect(saved).toBeNull();
    const left = await t.run(async (ctx) => ({
      accounts: await ctx.db.query("accounts").collect(),
      pots: await ctx.db.query("pots").collect(),
    }));
    expect(left.accounts).toEqual([]);
    expect(left.pots).toEqual([]);
  });

  test("people and households made by mistake can be removed while nobody relies on them", async () => {
    const t = convexTest(schema, modules);
    const ana = await signIn(t, "ana");
    const leo = await signIn(t, "leo");
    const phoneA = phone();
    phoneA.put({ ...localHousehold(), events: [] });
    const id = await startSync(ana, phoneA, "h_local");
    await pull(ana, phoneA, id);
    let a = phoneA.get(id)!;
    const leoId = a.people.find((p) => p.name === "Leo")!.id;
    const miaId = a.people.find((p) => p.name === "Mia")!.id;

    // Leo, alone in his group, goes; Mia leaves the couple first, then goes too.
    await removePersonOnline(ana, phoneA, id, leoId);
    await removePersonOnline(ana, phoneA, id, miaId);
    a = phoneA.get(id)!;
    expect(a.people.map((p) => p.name)).toEqual(["Ana"]);
    expect(a.groups).toHaveLength(1);
    expect(a.groups[0].memberIds).toEqual([a.youId]);

    // Nobody else ever joined, so the owner can delete it outright.
    await deleteHouseholdOnline(ana, phoneA, id);
    expect(phoneA.get(id)).toBeUndefined();
    await expect(ana.query("pots:listMyPots", {})).resolves.toEqual([]);
    await expect(t.run(async (ctx) => ({
      events: (await ctx.db.query("events").collect()).length,
      pots: (await ctx.db.query("pots").collect()).length,
      invites: (await ctx.db.query("invites").collect()).length,
    }))).resolves.toEqual({ events: 0, pots: 0, invites: 0 });

    // Once someone has joined, deleting is refused (leaving still works).
    const phoneB = phone();
    phoneA.put({ ...localHousehold(), id: "h_second", events: [] });
    const second = await startSync(ana, phoneA, "h_second");
    await pull(ana, phoneA, second);
    await issueInvites(ana, phoneA, second);
    const leo2 = phoneA.get(second)!.people.find((p) => p.name === "Leo")!.id;
    const code = phoneA.get(second)!.sync!.invites![leo2].code;
    const preview = await resolveInvite("http://127.0.0.1:3211", code,
      ((url: string, init?: RequestInit) => t.fetch(new URL(url).pathname, init)) as typeof fetch);
    if (preview.status !== "active") throw new Error("invite not active");
    await claimInvite(leo, phoneB, preview);
    await expect(deleteHouseholdOnline(ana, phoneA, second)).rejects.toThrow("HOUSEHOLD_HAS_MEMBERS");
    await expect(removePersonOnline(ana, phoneA, second, leo2)).rejects.toThrow();

    // Even after the owner detaches Leo's claim, the household still had a guest: no delete.
    await ana.mutation("members:reassignClaim", {
      potId: second,
      event: {
        eventId: "01890f5e-7b00-7000-8000-00000000f201", potId: second, actorMemberId: phoneA.get(second)!.youId,
        occurredAtMillis: BigInt(Date.now()), originatingTimeZone: "Europe/Madrid", schemaVersion: 2n,
        payload: { kind: "memberClaimReassigned", memberId: leo2 }, textFields: [], authoredText: [],
      },
    });
    await expect(t.run(async (ctx) => (await ctx.db.query("potMembers").collect()).filter((m) => m.potId === second).length))
      .resolves.toBe(1);
    await expect(deleteHouseholdOnline(ana, phoneA, second)).rejects.toThrow("HOUSEHOLD_HAS_MEMBERS");
  });

  test("a deletion that takes several calls closes the household first", async () => {
    const t = convexTest(schema, modules);
    const ana = await signIn(t, "ana");
    const leo = await signIn(t, "leo");
    const phoneA = phone();
    phoneA.put({ ...localHousehold(), events: [] });
    const id = await startSync(ana, phoneA, "h_local");
    await pull(ana, phoneA, id);
    await issueInvites(ana, phoneA, id);
    const leoId = phoneA.get(id)!.people.find((p) => p.name === "Leo")!.id;
    const code = phoneA.get(id)!.sync!.invites![leoId].code;
    const site = ((url: string, init?: RequestInit) => t.fetch(new URL(url).pathname, init)) as typeof fetch;
    const preview = await resolveInvite("http://127.0.0.1:3211", code, site);
    if (preview.status !== "active") throw new Error("invite not active");
    // Pad the history so one call can't erase it all.
    await t.run(async (ctx) => {
      for (let i = 0; i < 6_000; i++) {
        await ctx.db.insert("textRedactions", { potId: id, eventId: `pad-${i}`, sequence: 1n, field: "note", revision: BigInt(10_000 + i), redactedAt: 1 });
      }
    });

    const first = await ana.mutation<{ deleted: boolean }>("pots:deleteHousehold", { potId: id });
    expect(first.deleted).toBe(false);
    // Half-erased: nobody can join, write or even see it, and the code is gone.
    await expect(claimInvite(leo, phone(), preview)).rejects.toThrow();
    await expect(resolveInvite("http://127.0.0.1:3211", code, site)).resolves.toMatchObject({ status: expect.not.stringMatching(/^active$/) });
    await expect(ana.query("pots:listMyPots", {})).resolves.toEqual([]);
    await expect(ana.query("members:listRoster", { potId: id })).rejects.toThrow("POT_DELETING");
    // The owner's next calls finish the job.
    let done = first.deleted;
    for (let i = 0; i < 20 && !done; i++) done = (await ana.mutation<{ deleted: boolean }>("pots:deleteHousehold", { potId: id })).deleted;
    expect(done).toBe(true);
    await expect(t.run(async (ctx) => (await ctx.db.query("pots").collect()).length)).resolves.toBe(0);
  });
});

describe("card sync", () => {
  const post = (t: T, key: string, spends: unknown[]) => t.fetch("/card-sync/spends", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify({ spends }),
  });
  const sha256 = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))),
    (b) => b.toString(16).padStart(2, "0")).join("");
  const KEY = "nscs_test_key_abcdefghijklmnopqrstuvwxyz012345";

  test("spends on a linked card become expenses for that group, once; other cards leave no trace", async () => {
    const t = convexTest(schema, modules);
    await fenceBuild11(t);
    const ana = await signIn(t, "ana");
    const phoneA = phone();
    phoneA.put({ ...localHousehold(), events: [] });
    const id = await startSync(ana, phoneA, "h_local");
    await pull(ana, phoneA, id);
    let a = phoneA.get(id)!;
    const leoGroup = a.groups.find((g) => g.memberIds.length === 1)!.id;
    const ownGroup = a.groups.find((g) => g.memberIds.includes(a.youId))!.id;

    // Only the owner links, never to their own group.
    await expect(ana.mutation("cardSync:link", { potId: id, keyHash: await sha256(KEY), timeZone: "Europe/Madrid",
      cards: [{ last4: "4242", forUnitId: ownGroup, label: "Leo" }] })).rejects.toThrow("CARD_SYNC_CARDS_INVALID");
    await ana.mutation("cardSync:link", { potId: id, keyHash: await sha256(KEY), timeZone: "Europe/Madrid",
      cards: [{ last4: "4242", forUnitId: leoGroup, label: "Leo" }] });

    const res = await post(t, KEY, [
      { id: "tx-1", card: "•4242", occurredAt: "2026-09-30T18:04:51Z", merchant: "Corner Shop 12", amount: "5.33", currency: "EUR", category: "Grocery Stores and Supermarkets" },
      { id: "tx-2", card: "1234", occurredAt: "2026-09-30T19:00:00Z", merchant: "Someone else's card", amount: "99.00", currency: "EUR" },
      { id: "tx-3", card: "4242", occurredAt: "2026-09-30T20:00:00Z", merchant: "US shop", amount: "10.00", currency: "USD" },
      { id: "tx-1", card: "4242", occurredAt: "2026-09-30T18:04:51Z", merchant: "Corner Shop 12", amount: "5.33", currency: "EUR" },
    ]);
    expect(res.status).toBe(200);
    expect((await res.json()).outcomes).toEqual([
      { id: "tx-1", result: "added" },
      { id: "tx-2", result: "ignored", reason: "card not linked" },
      { id: "tx-3", result: "ignored", reason: "not in EUR" },
      { id: "tx-1", result: "duplicate" },
    ]);
    // Sending it again later is a no-op too.
    expect((await (await post(t, KEY, [{ id: "tx-1", card: "4242", occurredAt: "2026-09-30T18:04:51Z", merchant: "x", amount: "5.33", currency: "EUR" }])).json()).outcomes)
      .toEqual([{ id: "tx-1", result: "duplicate" }]);
    // Nothing about the other card is stored.
    expect(await t.run(async (ctx) => (await ctx.db.query("cardSyncSpends").collect()).map((s) => s.spendId))).toEqual(["tx-1"]);

    await pull(ana, phoneA, id);
    a = phoneA.get(id)!;
    const spend = a.events.find((e) => e.kind === "expenseAdded")!;
    expect(spend.kind === "expenseAdded" && spend.content).toMatchObject({
      payerId: a.youId, amount: 533, title: "Corner Shop 12", category: "groceries", note: "Card •4242 Leo", date: "2026-09-30",
    });
    expect(balances(a)).toEqual({ [ownGroup]: 533, [leoGroup]: -533 });
    expect(await ana.query("cardSync:status", { potId: id })).toMatchObject({ added: 1n, cards: [{ last4: "4242", label: "Leo" }] });

    // A wrong key, and the old key after unlinking, are refused.
    expect((await post(t, "nscs_wrong_key_abcdefghijklmnopqrstuvwxyz0123", [])).status).toBe(401);
    await ana.mutation("cardSync:unlink", { potId: id });
    expect((await post(t, KEY, [{ id: "tx-9", card: "4242", occurredAt: "2026-10-01T10:00:00Z", merchant: "x", amount: "1.00", currency: "EUR" }])).status).toBe(401);
    expect(await ana.query("cardSync:status", { potId: id })).toBeNull();
  });

  test("a member who isn't the owner can't link cards", async () => {
    const t = convexTest(schema, modules);
    const ana = await signIn(t, "ana");
    const leo = await signIn(t, "leo");
    const phoneA = phone();
    phoneA.put({ ...localHousehold(), events: [] });
    const id = await startSync(ana, phoneA, "h_local");
    await pull(ana, phoneA, id);
    await issueInvites(ana, phoneA, id);
    const leoId = phoneA.get(id)!.people.find((p) => p.name === "Leo")!.id;
    const site = ((url: string, init?: RequestInit) => t.fetch(new URL(url).pathname, init)) as typeof fetch;
    const preview = await resolveInvite("http://127.0.0.1:3211", phoneA.get(id)!.sync!.invites![leoId].code, site);
    if (preview.status !== "active") throw new Error(preview.status);
    await claimInvite(leo, phone(), preview);
    const couple = phoneA.get(id)!.groups.find((g) => g.memberIds.length === 2)!.id;
    await expect(leo.mutation("cardSync:link", { potId: id, keyHash: await sha256(KEY), timeZone: "Europe/Madrid",
      cards: [{ last4: "4242", forUnitId: couple, label: "Ana" }] })).rejects.toThrow("NOT_OWNER");
  });
});
