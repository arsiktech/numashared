// A read-only key Numa Pro uses to copy household balances. The person makes the key in
// Settings, AI agents; only its SHA-256 is stored. POST /pro/balances is the only route that
// accepts it. Nothing in this file writes a household record.
import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { httpAction, internalMutation, mutation, query } from "./_generated/server";
import { accountIsUsable } from "./agentAccess";
import { fail, requireSession } from "./lib/access";
import { requireApprovedWriteTarget } from "./lib/deployment";
import { sha256Hex } from "./lib/hash";
import { counterpartiesFor, type BalanceUnit } from "./lib/proCounterparties";

const callsPerMinute = 30;
const keyHashPattern = /^[0-9a-f]{64}$/;

/** Makes a Numa Pro key, replacing any live one. The secret itself never arrives here. */
export const issue = mutation({
  args: { keyHash: v.string(), keyHint: v.string() },
  handler: async (ctx, args) => {
    requireApprovedWriteTarget();
    const { account } = await requireSession(ctx);
    if (!keyHashPattern.test(args.keyHash) || args.keyHint.length < 6 || args.keyHint.length > 12) fail("PRO_LINK_KEY_INVALID");
    if (await ctx.db.query("proLinks").withIndex("by_key_hash", (q) => q.eq("keyHash", args.keyHash)).first()) {
      fail("PRO_LINK_KEY_INVALID");
    }
    const now = Date.now();
    const rows = await ctx.db.query("proLinks").withIndex("by_account", (q) => q.eq("accountId", account._id)).collect();
    for (const row of rows) if (row.revokedAt === undefined) await ctx.db.patch(row._id, { revokedAt: now });
    const id = await ctx.db.insert("proLinks", {
      accountId: account._id, keyHash: args.keyHash, keyHint: args.keyHint.slice(0, 12),
      createdAt: now, windowStartedAt: now, windowCount: 0,
    });
    return { id };
  },
});

/** Stops the live key. The next read is refused. */
export const revoke = mutation({
  args: {},
  handler: async (ctx) => {
    requireApprovedWriteTarget();
    const { account } = await requireSession(ctx);
    const now = Date.now();
    const rows = await ctx.db.query("proLinks").withIndex("by_account", (q) => q.eq("accountId", account._id)).collect();
    for (const row of rows) if (row.revokedAt === undefined) await ctx.db.patch(row._id, { revokedAt: now });
    return null;
  },
});

/** Whether a Numa Pro key is live, without anything that could be used as one. */
export const status = query({
  args: {},
  handler: async (ctx) => {
    const { account } = await requireSession(ctx);
    const rows = await ctx.db.query("proLinks").withIndex("by_account", (q) => q.eq("accountId", account._id)).collect();
    const live = rows.filter((row) => row.revokedAt === undefined).sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!live) return null;
    return { hint: live.keyHint, createdAt: live.createdAt, lastUsedAt: live.lastUsedAt ?? null };
  },
});

type Auth = { ok: true; accountId: Id<"accounts"> } | { ok: false; status: 401 | 429 };

/** Checks the key and counts the call. A revoked or unknown key is refused. */
export const authenticate = internalMutation({
  args: { keyHash: v.string() },
  handler: async (ctx, { keyHash }): Promise<Auth> => {
    const link = await ctx.db.query("proLinks").withIndex("by_key_hash", (q) => q.eq("keyHash", keyHash)).unique();
    if (!link || link.revokedAt !== undefined) return { ok: false, status: 401 };
    if (!(await accountIsUsable(ctx, link.accountId))) return { ok: false, status: 401 };
    const now = Date.now();
    const fresh = now - link.windowStartedAt >= 60_000;
    if (!fresh && link.windowCount >= callsPerMinute) return { ok: false, status: 429 };
    await ctx.db.patch(link._id, {
      windowStartedAt: fresh ? now : link.windowStartedAt,
      windowCount: fresh ? 1 : link.windowCount + 1,
      lastUsedAt: now,
    });
    return { ok: true, accountId: link.accountId };
  },
});

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
  });
}

function errorCode(error: unknown): string | null {
  if (error instanceof ConvexError && error.data && typeof error.data === "object" && error.data !== null && "code" in error.data) {
    return String((error.data as { code: unknown }).code);
  }
  return null;
}

type BalanceReport = {
  currency: string;
  exponent: number;
  units: BalanceUnit[];
};

/** POST /pro/balances  Authorization: Bearer nspro_…  { "household": "<id>" } */
export const balancesHttp = httpAction(async (ctx, request) => {
  const key = /^Bearer (nspro_[A-Za-z0-9_-]{40,80})$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!key) return json({ error: "PRO_LINK_KEY_INVALID" }, 401);
  let household = "";
  try {
    const raw = await request.text();
    if (raw.length > 4_096) return json({ error: "PAYLOAD_TOO_LARGE" }, 413);
    const body = raw ? JSON.parse(raw) as { household?: unknown } : {};
    if (typeof body.household !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(body.household)) {
      return json({ error: "HOUSEHOLD_REQUIRED" }, 400);
    }
    household = body.household;
  } catch {
    return json({ error: "INVALID_JSON" }, 400);
  }
  const auth: Auth = await ctx.runMutation(internal.proBalances.authenticate, { keyHash: await sha256Hex(key) });
  if (!auth.ok) return json({ error: auth.status === 429 ? "PRO_LINK_LIMITED" : "PRO_LINK_KEY_INVALID" }, auth.status);
  let report: BalanceReport;
  try {
    report = await ctx.runQuery(internal.agentData.balances, { accountId: auth.accountId, scopePotId: null, potId: household }) as BalanceReport;
  } catch (error) {
    const code = errorCode(error);
    if (code === "NOT_MEMBER" || code === "POT_MISSING" || code === "MEMBERSHIP_ARCHIVED" || code === "POT_DELETING" || code === "AGENT_NOT_ALLOWED") {
      return json({ error: "HOUSEHOLD_UNAVAILABLE" }, 404);
    }
    return json({ householdId: household, status: "unavailable" });
  }
  const reading = counterpartiesFor(report.units);
  if (reading.status !== "ok") return json({ householdId: household, currency: report.currency, exponent: report.exponent, status: "unavailable" });
  return json({
    householdId: household,
    currency: report.currency,
    exponent: report.exponent,
    status: "ok",
    yourMinorUnits: reading.yourMinorUnits,
    counterparties: reading.counterparties,
  });
});
