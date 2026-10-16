// End-to-end check of the Expo app's sync engine (app/src/sync) against these backend functions:
// two simulated phones create, promote, invite, join, add, edit, void, repay and pull, and must
// always agree on every balance.
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { reduce } from "../app/src/core/ledger";
import type { Household, LedgerEvent } from "../app/src/core/types";
import {
  addPersonOnline,
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
import terminalCodes from "../contracts/event-terminal-codes.json";
import { TERMINAL_EVENT_CODES } from "../app/src/sync/terminal";
import { KNOWN_TIME_ZONES } from "../app/src/sync/timezones";
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

afterEach(() => vi.unstubAllEnvs());

type T = ReturnType<typeof convexTest>;

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
  });

  test("two phones create, invite, join, record and always agree", async () => {
    const t = convexTest(schema, modules);
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
});
