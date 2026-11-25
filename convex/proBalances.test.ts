import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { planSettlement as appPlan } from "../app/src/core/plan";
import schema from "./schema";
import { modules } from "./test.setup";
import { planSettlement as serverPlan } from "./lib/settlementPlan";
import { counterpartiesFor } from "./lib/proCounterparties";

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
afterEach(() => { vi.unstubAllEnvs(); });

const sha256 = async (value: string) => Array.from(
  new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
  (byte) => byte.toString(16).padStart(2, "0"),
).join("");

describe("counterparty lines", () => {
  test("uses the same settlement plan as the app", () => {
    const rows: Array<Record<string, number>> = [
      { a: -1250, b: 1250 },
      { a: -20, b: -30, c: 50 },
      { a: 400, b: -150, c: -250 },
      { a: 0, b: 0 },
    ];
    for (const row of rows) expect(serverPlan(row)).toEqual(appPlan(row));
  });

  test("a negative owner net is a debt to that counterparty, and a positive one is money owed to the owner", () => {
    const pair = (owner: string, other: string) => counterpartiesFor([
      { unitId: "owner", label: "Owner", minorUnits: owner, includesYou: true },
      { unitId: "other", label: "Other", minorUnits: other, includesYou: false },
    ]);
    expect(pair("-1250", "1250")).toEqual({
      status: "ok", yourMinorUnits: "-1250",
      counterparties: [{ unitId: "other", label: "Other", minorUnits: "-1250" }],
    });
    expect(pair("800", "-800")).toMatchObject({
      status: "ok", yourMinorUnits: "800",
      counterparties: [{ unitId: "other", minorUnits: "800" }],
    });
    expect(pair("0", "0")).toEqual({ status: "ok", yourMinorUnits: "0", counterparties: [] });
  });

  test("keeps only the transfers that involve the owner when three units share the household", () => {
    expect(counterpartiesFor([
      { unitId: "a", label: "Ada", minorUnits: "-20", includesYou: true },
      { unitId: "b", label: "Bea", minorUnits: "-30", includesYou: false },
      { unitId: "c", label: "Cam", minorUnits: "50", includesYou: false },
    ])).toEqual({
      status: "ok", yourMinorUnits: "-20",
      counterparties: [{ unitId: "c", label: "Cam", minorUnits: "-20" }],
    });
  });

  test("does not invent a plan when the owner has no unit or the amounts are not whole minor units", () => {
    expect(counterpartiesFor([{ unitId: "a", label: "Ada", minorUnits: "-20", includesYou: false }])).toEqual({ status: "unavailable" });
    expect(counterpartiesFor([
      { unitId: "a", label: "Ada", minorUnits: "-1.5", includesYou: true },
      { unitId: "b", label: "Bea", minorUnits: "1.5", includesYou: false },
    ])).toEqual({ status: "unavailable" });
  });
});

const HOUSEHOLD = "household-one-test";
const KEY = `nspro_${"a".repeat(43)}`;

async function seed(t: ReturnType<typeof convexTest>, minor: { owner: bigint; other: bigint }) {
  const keyHash = await sha256(KEY);
  await t.run(async (ctx) => {
    const accountId = await ctx.db.insert("accounts", { publicAccountId: "account-ada", appleSubjectHash: "apple-ada", createdAt: 1 });
    await ctx.db.insert("sessions", {
      sessionId: "session-ada-0000001", accountId, refreshTokenHash: "refresh-ada",
      expiresAt: Date.now() + 86_400_000, createdAt: 1, rotatedAt: 1,
    });
    await ctx.db.insert("pots", {
      potId: HOUSEHOLD, currencyCode: "EUR", currencyExponent: 2n, orderedUnitIds: ["unit-owner", "unit-other"],
      ownerAccountId: accountId, minimumReaderSchemaVersion: 1n, nextSequence: 2n, nextTextRevision: 1n,
      positiveContributionBudget: 1_000_000_000n, negativeContributionBudget: 1_000_000_000n, createdAt: 1,
    });
    await ctx.db.insert("potMembers", {
      potId: HOUSEHOLD, accountId, memberId: "member-owner", role: "owner", status: "active", joinedAt: 1,
    });
    await ctx.db.insert("potMemberProfiles", {
      potId: HOUSEHOLD, memberId: "member-owner", unitId: "unit-owner", displayName: "Ada", role: "owner", state: "active", createdAt: 1, updatedAt: 1,
    });
    await ctx.db.insert("potMemberProfiles", {
      potId: HOUSEHOLD, memberId: "member-other", unitId: "unit-other", displayName: "Bea", role: "member", state: "active", createdAt: 1, updatedAt: 1,
    });
    const money = (minorUnits: bigint) => ({ minorUnits, currency: { code: "EUR", exponent: 2n } });
    await ctx.db.insert("events", {
      potId: HOUSEHOLD, eventId: "event-opening", recordId: "record-opening", actorMemberId: "member-owner",
      occurredAtMillis: 1n, originatingTimeZone: "UTC", schemaVersion: 1n, sequence: 1n,
      payload: { kind: "openingBalanceSet", recordId: "record-opening", content: { entries: [
        { unitId: "unit-owner", amount: money(minor.owner) },
        { unitId: "unit-other", amount: money(minor.other) },
      ] } },
      textFields: [], createdAt: 1,
    });
    await ctx.db.insert("proLinks", {
      accountId, keyHash, keyHint: KEY.slice(0, 12), createdAt: 1, windowStartedAt: 1, windowCount: 0,
    });
  });
}

function post(t: ReturnType<typeof convexTest>, key: string | null, body: unknown) {
  return t.fetch("/pro/balances", {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  });
}

describe("POST /pro/balances", () => {
  test("returns the owner's debt to the other unit and refuses a missing, wrong or revoked key", async () => {
    const t = convexTest(schema, modules);
    await seed(t, { owner: -1250n, other: 1250n });
    const ok = await post(t, KEY, { household: HOUSEHOLD });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      householdId: HOUSEHOLD, currency: "EUR", exponent: 2, status: "ok", yourMinorUnits: "-1250",
      counterparties: [{ unitId: "unit-other", label: "Bea", minorUnits: "-1250" }],
    });
    expect((await post(t, null, { household: HOUSEHOLD })).status).toBe(401);
    expect((await post(t, `nspro_${"b".repeat(43)}`, { household: HOUSEHOLD })).status).toBe(401);
    expect((await post(t, KEY, {})).status).toBe(400);
    const who = t.withIdentity({
      issuer: "https://auth.numa.shared", subject: "account-ada", sid: "session-ada-0000001",
      numa_session_audience: "tech.arsik.numashared", token_use: "access",
    });
    await who.mutation(makeFunctionReference<"mutation">("proBalances:revoke"), {});
    expect((await post(t, KEY, { household: HOUSEHOLD })).status).toBe(401);
  });

  test("a new key replaces the previous one, and a household the person is not in is not settled to zero", async () => {
    const t = convexTest(schema, modules);
    await seed(t, { owner: 800n, other: -800n });
    const who = t.withIdentity({
      issuer: "https://auth.numa.shared", subject: "account-ada", sid: "session-ada-0000001",
      numa_session_audience: "tech.arsik.numashared", token_use: "access",
    });
    const next = `nspro_${"c".repeat(43)}`;
    await who.mutation(makeFunctionReference<"mutation">("proBalances:issue"), { keyHash: await sha256(next), keyHint: next.slice(0, 12) });
    expect((await post(t, KEY, { household: HOUSEHOLD })).status).toBe(401);
    const owed = await post(t, next, { household: HOUSEHOLD });
    expect(await owed.json()).toMatchObject({ status: "ok", yourMinorUnits: "800", counterparties: [{ unitId: "unit-other", minorUnits: "800" }] });
    expect((await post(t, next, { household: "household-missing" })).status).toBe(404);
  });
});
