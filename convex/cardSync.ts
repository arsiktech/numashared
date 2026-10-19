// Card sync: spends on chosen payment cards become expenses in a household by themselves.
//
// The household's owner links it once from the app. The phone makes a random key, keeps it to show
// once, and sends only its SHA-256 here, with the cards to follow (last four digits) and whose they
// are (a group in the household). A sync script elsewhere (for example on the owner's computer)
// posts new spends to POST /card-sync/spends with that key. Each spend on a linked card becomes
// "<owner> paid, entirely for <that group>". Spends on any other card are dropped without being
// stored. A spend is added once, however often it is sent.
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { httpAction, internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { fail, requireActiveMembership, requireSession } from "./lib/access";
import { appendEventsToPot } from "./lib/appendEvents";
import { loadBudgetGroupTopology } from "./lib/budgetGroupTopology";
import { loadClientContract } from "./lib/clientContract";
import { requireApprovedWriteTarget } from "./lib/deployment";
import type { EventInput } from "./lib/eventValidation";
import { sha256Hex } from "./lib/hash";
import { ios18TimeZoneIdentifiers } from "./lib/ios18TimeZoneIdentifiers";
import { generateUUIDv7 } from "./lib/uuidV7";

export const maximumSpendsPerRequest = 50;
const maximumCards = 10;

const cardValidator = v.object({
  last4: v.string(),
  forUnitId: v.string(),
  label: v.string(),
});

async function ownerOf(ctx: MutationCtx, potId: string) {
  const { account } = await requireSession(ctx);
  const membership = await requireActiveMembership(ctx, potId, account._id);
  if (membership.role !== "owner") fail("NOT_OWNER");
  const pot = await ctx.db.query("pots").withIndex("by_pot_id", (q) => q.eq("potId", potId)).unique();
  if (!pot) fail("POT_MISSING");
  return { account, membership, pot };
}

async function activeLink(ctx: QueryCtx | MutationCtx, potId: string) {
  const links = await ctx.db.query("cardSyncLinks").withIndex("by_pot", (q) => q.eq("potId", potId)).collect();
  return links.find((link) => link.revokedAt === undefined) ?? null;
}

/** Links the household to card sync (replacing any earlier link and its key). Owner only. */
export const link = mutation({
  args: {
    potId: v.string(),
    keyHash: v.string(),
    timeZone: v.string(),
    cards: v.array(cardValidator),
  },
  handler: async (ctx, args) => {
    requireApprovedWriteTarget();
    const { account, membership, pot } = await ownerOf(ctx, args.potId);
    if (!/^[0-9a-f]{64}$/.test(args.keyHash)) fail("CARD_SYNC_KEY_INVALID");
    if (!ios18TimeZoneIdentifiers.has(args.timeZone)) fail("INVALID_TIME_ZONE");
    if (args.cards.length < 1 || args.cards.length > maximumCards) fail("CARD_SYNC_CARDS_INVALID");
    const topology = await loadBudgetGroupTopology(ctx, pot);
    const own = topology.members.find((m) => m.memberId === membership.memberId)?.unitId;
    const units = new Set([...pot.orderedUnitIds, ...topology.groups.map((g) => g.unitId)]);
    const seen = new Set<string>();
    for (const card of args.cards) {
      if (!/^\d{4}$/.test(card.last4) || seen.has(card.last4)) fail("CARD_SYNC_CARDS_INVALID");
      seen.add(card.last4);
      if (!units.has(card.forUnitId) || card.forUnitId === own) fail("CARD_SYNC_CARDS_INVALID");
      if (!card.label.trim() || card.label.length > 40) fail("CARD_SYNC_CARDS_INVALID");
    }
    const now = Date.now();
    const previous = await activeLink(ctx, args.potId);
    if (previous) await ctx.db.patch(previous._id, { revokedAt: now });
    await ctx.db.insert("cardSyncLinks", {
      potId: args.potId,
      accountId: account._id,
      actorMemberId: membership.memberId,
      keyHash: args.keyHash,
      timeZone: args.timeZone,
      cards: args.cards.map((c) => ({ ...c, label: c.label.trim() })),
      createdAt: now,
      added: 0n,
    });
    return { linked: true };
  },
});

/** Stops card sync for the household. The key stops working at once. */
export const unlink = mutation({
  args: { potId: v.string() },
  handler: async (ctx, args) => {
    requireApprovedWriteTarget();
    await ownerOf(ctx, args.potId);
    const current = await activeLink(ctx, args.potId);
    if (current) await ctx.db.patch(current._id, { revokedAt: Date.now() });
    return { unlinked: true };
  },
});

/** What the household's card sync is doing, for its members. */
export const status = query({
  args: { potId: v.string() },
  handler: async (ctx, args) => {
    const { account } = await requireSession(ctx);
    await requireActiveMembership(ctx, args.potId, account._id);
    const current = await activeLink(ctx, args.potId);
    if (!current) return null;
    return {
      cards: current.cards,
      actorMemberId: current.actorMemberId,
      createdAt: current.createdAt,
      lastUsedAt: current.lastUsedAt ?? null,
      added: current.added,
    };
  },
});

// ---------- receiving spends ----------

const spendValidator = v.object({
  id: v.string(),
  card: v.string(),
  occurredAtMillis: v.number(),
  merchant: v.string(),
  amount: v.string(),
  currency: v.string(),
  category: v.optional(v.string()),
});

type Outcome = { id: string; result: "added" | "duplicate" | "ignored"; reason?: string };

/** Card-network categories ("Grocery Stores and Supermarkets") to the app's categories. */
export function categoryForMerchant(category: string | undefined): string {
  const c = (category ?? "").toLowerCase();
  if (/grocer|supermarket|food store|bakeries|candy|dairy/.test(c)) return "groceries";
  if (/restaurant|eating|fast food|caterer|bar|tavern|night ?club|coffee/.test(c)) return "eating-out";
  if (/utilit|electric|gas|water/.test(c)) return "bills";
  if (/telecom|internet|cable/.test(c)) return "internet";
  if (/cleaning|laundry/.test(c)) return "cleaning";
  if (/household|hardware|home|furniture|drug|pharmac|cosmetic/.test(c)) return "household";
  return "other";
}

function cents(amount: string, exponent: bigint): bigint | null {
  const m = /^(\d{1,9})(?:\.(\d{1,6}))?$/.exec(amount.trim());
  if (!m) return null;
  const digits = Number(exponent);
  const fraction = (m[2] ?? "").padEnd(digits, "0");
  if (fraction.length > digits && /[1-9]/.test(fraction.slice(digits))) return null; // more precision than the currency has
  return BigInt(m[1]) * 10n ** exponent + BigInt(fraction.slice(0, digits) || "0");
}

const clip = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

export const receive = internalMutation({
  args: { keyHash: v.string(), spends: v.array(spendValidator) },
  handler: async (ctx, args): Promise<{ status: number; outcomes?: Outcome[]; error?: string }> => {
    requireApprovedWriteTarget();
    const link = await ctx.db.query("cardSyncLinks").withIndex("by_key_hash", (q) => q.eq("keyHash", args.keyHash)).unique();
    if (!link || link.revokedAt !== undefined) return { status: 401, error: "CARD_SYNC_KEY_INVALID" };
    const pot = await ctx.db.query("pots").withIndex("by_pot_id", (q) => q.eq("potId", link.potId)).unique();
    if (!pot || pot.deletingAt !== undefined || pot.archivedAtSequence !== undefined) return { status: 410, error: "HOUSEHOLD_GONE" };
    const membership = await ctx.db.query("potMembers")
      .withIndex("by_pot_account", (q) => q.eq("potId", link.potId).eq("accountId", link.accountId)).unique();
    if (!membership || membership.status !== "active" || membership.memberId !== link.actorMemberId) {
      return { status: 403, error: "CARD_SYNC_OWNER_LEFT" };
    }
    const topology = await loadBudgetGroupTopology(ctx, pot);
    const payerUnitId = topology.members.find((m) => m.memberId === link.actorMemberId)?.unitId;
    if (!payerUnitId) return { status: 409, error: "CARD_SYNC_PAYER_MISSING" };
    const liveUnits = new Set([...pot.orderedUnitIds, ...topology.groups.map((g) => g.unitId)]);
    // Older app builds can't read an expense note; the card goes in the note only once they're gone.
    const { extendedText } = await loadClientContract(ctx);

    const outcomes: Outcome[] = [];
    const events: EventInput[] = [];
    const accepted: { spendId: string; eventId: string; card: string }[] = [];
    const now = Date.now();
    const inBatch = new Set<string>();
    for (const spend of args.spends) {
      const card = link.cards.find((c) => c.last4 === spend.card);
      // A card that isn't linked: nothing about it is kept.
      if (!card) { outcomes.push({ id: spend.id, result: "ignored", reason: "card not linked" }); continue; }
      if (!spend.id.trim() || spend.id.length > 200) { outcomes.push({ id: spend.id, result: "ignored", reason: "invalid id" }); continue; }
      const seen = await ctx.db.query("cardSyncSpends")
        .withIndex("by_pot_spend", (q) => q.eq("potId", link.potId).eq("spendId", spend.id)).unique();
      if (seen || inBatch.has(spend.id)) { outcomes.push({ id: spend.id, result: "duplicate" }); continue; }
      if (spend.currency !== pot.currencyCode) { outcomes.push({ id: spend.id, result: "ignored", reason: `not in ${pot.currencyCode}` }); continue; }
      const minor = cents(spend.amount, pot.currencyExponent);
      if (minor === null || minor <= 0n) { outcomes.push({ id: spend.id, result: "ignored", reason: "invalid amount" }); continue; }
      if (!Number.isSafeInteger(spend.occurredAtMillis) || spend.occurredAtMillis <= 0 || spend.occurredAtMillis > now + 86_400_000) {
        outcomes.push({ id: spend.id, result: "ignored", reason: "invalid time" }); continue;
      }
      if (!liveUnits.has(card.forUnitId)) { outcomes.push({ id: spend.id, result: "ignored", reason: "group no longer in the household" }); continue; }
      inBatch.add(spend.id);
      const money = { minorUnits: minor, currency: { code: pot.currencyCode, exponent: pot.currencyExponent } };
      const text = [
        { field: "title" as const, value: clip(spend.merchant, 120) || "Card payment" },
        { field: "category" as const, value: categoryForMerchant(spend.category) },
        ...(extendedText ? [{ field: "note" as const, value: clip(`Card •${card.last4} ${card.label}`, 120) }] : []),
      ];
      const eventId = generateUUIDv7(now);
      events.push({
        eventId,
        potId: pot.potId,
        actorMemberId: link.actorMemberId,
        occurredAtMillis: BigInt(spend.occurredAtMillis),
        originatingTimeZone: link.timeZone,
        schemaVersion: pot.minimumReaderSchemaVersion,
        payload: {
          kind: "expenseAdded",
          recordId: generateUUIDv7(now),
          content: {
            expenseKind: "personal",
            amount: money,
            payerUnitId,
            ...(pot.minimumReaderSchemaVersion >= 2n ? { payerMemberId: link.actorMemberId } : {}),
            allocations: [{ unitId: card.forUnitId, amount: money }],
          },
        },
        textFields: text.map((t) => t.field),
        authoredText: text,
      } as EventInput);
      accepted.push({ spendId: spend.id, eventId, card: card.last4 });
      outcomes.push({ id: spend.id, result: "added" });
    }
    if (events.length) {
      await appendEventsToPot(ctx, { pot, accountId: link.accountId as Id<"accounts">, actorMemberId: link.actorMemberId, events });
      for (const a of accepted) {
        await ctx.db.insert("cardSyncSpends", { potId: link.potId, spendId: a.spendId, eventId: a.eventId, card: a.card, addedAt: now });
        await ctx.scheduler.runAfter(0, internal.apns.deliverEventPush, { potId: link.potId, eventId: a.eventId });
      }
    }
    await ctx.db.patch(link._id, { lastUsedAt: now, added: link.added + BigInt(events.length) });
    return { status: 200, outcomes };
  },
});

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" },
  });
}

/** POST /card-sync/spends  Authorization: Bearer <key>  { "spends": [ … ] } */
export const spendsHttp = httpAction(async (ctx, request) => {
  const auth = request.headers.get("authorization") ?? "";
  const key = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(auth)?.[1];
  if (!key) return json({ error: "CARD_SYNC_KEY_INVALID" }, 401);
  let body: unknown;
  try { body = await request.json(); } catch { return json({ error: "INVALID_JSON" }, 400); }
  const spends = (body as { spends?: unknown })?.spends;
  if (!Array.isArray(spends) || spends.length > maximumSpendsPerRequest) {
    return json({ error: `Send 1 to ${maximumSpendsPerRequest} spends as "spends".` }, 400);
  }
  const clean = [];
  for (const s of spends as Record<string, unknown>[]) {
    const occurred = typeof s.occurredAt === "string" ? Date.parse(s.occurredAt) : s.occurredAtMillis;
    if (typeof s.id !== "string" || typeof s.card !== "string" || typeof occurred !== "number" || !Number.isFinite(occurred)
      || typeof s.merchant !== "string" || typeof s.amount !== "string" || typeof s.currency !== "string"
      || (s.category !== undefined && typeof s.category !== "string")) {
      return json({ error: "Each spend needs id, card, occurredAt, merchant, amount (a decimal string) and currency." }, 400);
    }
    clean.push({
      id: s.id, card: s.card.replace(/\D/g, "").slice(-4), occurredAtMillis: Math.trunc(occurred),
      merchant: s.merchant.slice(0, 200), amount: s.amount, currency: s.currency.toUpperCase(),
      ...(typeof s.category === "string" ? { category: s.category.slice(0, 200) } : {}),
    });
  }
  const result = await ctx.runMutation(internal.cardSync.receive, { keyHash: await sha256Hex(key), spends: clean });
  if (result.status !== 200) return json({ error: result.error }, result.status);
  return json({ outcomes: result.outcomes });
});

export type CardSyncLink = Doc<"cardSyncLinks">;
