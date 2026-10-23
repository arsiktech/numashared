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
import { buildFinancialRecordState } from "./lib/financialRecordState";
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
  // "spend" (default) adds an expense. "refund" gives money back on an earlier spend on the same
  // card at the same merchant. "cancel" means the card provider cancelled this very spend.
  kind: v.optional(v.union(v.literal("spend"), v.literal("refund"), v.literal("cancel"))),
  // The card provider's merchant id, to find which spend a refund belongs to.
  merchantKey: v.optional(v.string()),
});

type Outcome = {
  id: string;
  result: "added" | "duplicate" | "ignored" | "refunded" | "voided" | "unmatched";
  reason?: string;
};

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

type ExpenseContent = {
  expenseKind: "shared" | "personal";
  amount: { minorUnits: bigint; currency: { code: string; exponent: bigint } };
  payerUnitId: string;
  payerMemberId?: string;
  allocations: Array<{ unitId: string; amount: { minorUnits: bigint; currency: { code: string; exponent: bigint } } }>;
};

/** Where a synced spend stands now, including changes made earlier in the same request. */
type Tracked = {
  recordId: string;
  voided: boolean;
  /** Undefined when the expense was edited on two phones at once and nobody chose yet. */
  head?: { eventId: string; content: ExpenseContent; occurredAtMillis: bigint; texts: Map<string, string> };
};

function formatMoney(minor: bigint, code: string, exponent: bigint): string {
  const digits = Number(exponent);
  const whole = minor / 10n ** exponent;
  const fraction = digits ? `.${(minor % 10n ** exponent).toString().padStart(digits, "0")}` : "";
  return `${code === "EUR" ? "€" : `${code} `}${whole}${fraction}`;
}

const sameMerchant = (a: string, b: string) => a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();

export const receive = internalMutation({
  args: { keyHash: v.string(), spends: v.array(spendValidator) },
  handler: async (ctx, args): Promise<{ status: number; outcomes?: Outcome[]; error?: string }> => {
    requireApprovedWriteTarget();
    const link = await ctx.db.query("cardSyncLinks").withIndex("by_key_hash", (q) => q.eq("keyHash", args.keyHash)).unique();
    if (!link || link.revokedAt !== undefined) return { status: 401, error: "CARD_SYNC_KEY_INVALID" };
    const account = await ctx.db.get(link.accountId);
    if (!account || account.deletionStartedAt !== undefined) return { status: 401, error: "CARD_SYNC_KEY_INVALID" };
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
    const rows: Array<Omit<Doc<"cardSyncSpends">, "_id" | "_creationTime">> = [];
    const cancelled: Array<Id<"cardSyncSpends">> = [];
    let added = 0;
    const now = Date.now();
    const inBatch = new Set<string>();
    const tracked = new Map<string, Tracked>();
    let synced: Doc<"cardSyncSpends">[] | null = null;
    const money = (minor: bigint) => ({ minorUnits: minor, currency: { code: pot.currencyCode, exponent: pot.currencyExponent } });
    const schemaVersion = pot.minimumReaderSchemaVersion;

    /** The record a synced spend became, as it stands now. */
    async function trackedFor(row: Pick<Doc<"cardSyncSpends">, "eventId">): Promise<Tracked | null> {
      if (!row.eventId) return null;
      const root = await ctx.db.query("events").withIndex("by_pot_event", (q) => q.eq("potId", link!.potId).eq("eventId", row.eventId)).unique();
      if (!root?.recordId) return null;
      const known = tracked.get(root.recordId);
      if (known) return known;
      const history = await ctx.db.query("events")
        .withIndex("by_pot_record", (q) => q.eq("potId", link!.potId).eq("recordId", root.recordId)).order("asc").collect();
      const state = buildFinancialRecordState(history);
      const entry: Tracked = { recordId: root.recordId, voided: state.isVoided };
      if (state.rootKind === "expense" && state.heads.size === 1) {
        const headEventId = [...state.heads][0];
        const payload = state.revisions.get(headEventId)?.payload;
        const raw = payload?.kind === "expenseAdded" ? payload.content
          : payload?.kind === "expenseRevised" && payload.content.kind === "expense" ? payload.content : undefined;
        const headEvent = history.find((e) => e.eventId === headEventId);
        if (raw && headEvent) {
          const { kind: _kind, ...content } = raw as ExpenseContent & { kind?: string };
          const texts = new Map<string, string>();
          for (const t of await ctx.db.query("eventTexts").withIndex("by_pot_event", (q) => q.eq("potId", link!.potId).eq("eventId", headEventId)).collect()) {
            texts.set(t.field, t.value);
          }
          entry.head = { eventId: headEventId, content: content as ExpenseContent, occurredAtMillis: headEvent.occurredAtMillis, texts };
        }
      }
      tracked.set(root.recordId, entry);
      return entry;
    }

    function voidEvent(target: Tracked, reason: string, occurredAtMillis: number): string {
      const eventId = generateUUIDv7(now);
      events.push({
        eventId, potId: pot!.potId, actorMemberId: link!.actorMemberId, occurredAtMillis: BigInt(occurredAtMillis),
        originatingTimeZone: link!.timeZone, schemaVersion,
        payload: { kind: "recordVoided", recordId: target.recordId },
        textFields: ["reason"], authoredText: [{ field: "reason", value: clip(reason, 120) }],
      } as EventInput);
      target.voided = true;
      return eventId;
    }

    for (const spend of args.spends) {
      const kind = spend.kind ?? "spend";
      const card = link.cards.find((c) => c.last4 === spend.card);
      // A card that isn't linked: nothing about it is kept.
      if (!card) { outcomes.push({ id: spend.id, result: "ignored", reason: "card not linked" }); continue; }
      if (!spend.id.trim() || spend.id.length > 200) { outcomes.push({ id: spend.id, result: "ignored", reason: "invalid id" }); continue; }
      const seen = await ctx.db.query("cardSyncSpends")
        .withIndex("by_pot_spend", (q) => q.eq("potId", link.potId).eq("spendId", spend.id)).unique();
      const merchantKey = spend.merchantKey?.trim().slice(0, 200) || undefined;

      if (kind === "cancel") {
        if (inBatch.has(spend.id)) { outcomes.push({ id: spend.id, result: "duplicate" }); continue; }
        inBatch.add(spend.id);
        if (!seen) {
          // Never added; remember it so the spend is never added later.
          rows.push({ potId: link.potId, spendId: spend.id, eventId: "", card: card.last4, addedAt: now, kind: "cancel" });
          outcomes.push({ id: spend.id, result: "ignored", reason: "cancelled before it was added" });
          continue;
        }
        if (seen.kind !== undefined || seen.cancelledAt !== undefined) { outcomes.push({ id: spend.id, result: "duplicate" }); continue; }
        const target = await trackedFor(seen);
        cancelled.push(seen._id);
        if (!target || target.voided) { outcomes.push({ id: spend.id, result: "duplicate" }); continue; }
        const eventId = voidEvent(target, `Cancelled by the card provider (${clip(spend.merchant, 60) || "card payment"})`, Date.now());
        rows.push({ potId: link.potId, spendId: `${spend.id}#cancel`, eventId, card: card.last4, addedAt: now, kind: "cancel" });
        outcomes.push({ id: spend.id, result: "voided" });
        continue;
      }

      if (seen || inBatch.has(spend.id)) {
        // Older spends were stored before merchant ids were sent; fill them in for refund matching.
        if (seen && seen.kind === undefined && ((merchantKey && !seen.merchantKey) || seen.occurredAtMillis === undefined)) {
          await ctx.db.patch(seen._id, { ...(merchantKey && !seen.merchantKey ? { merchantKey } : {}), occurredAtMillis: spend.occurredAtMillis });
        }
        outcomes.push({ id: spend.id, result: "duplicate" });
        continue;
      }
      if (spend.currency !== pot.currencyCode) { outcomes.push({ id: spend.id, result: "ignored", reason: `not in ${pot.currencyCode}` }); continue; }
      const minor = cents(spend.amount, pot.currencyExponent);
      if (minor === null || minor <= 0n) { outcomes.push({ id: spend.id, result: "ignored", reason: "invalid amount" }); continue; }
      if (!Number.isSafeInteger(spend.occurredAtMillis) || spend.occurredAtMillis <= 0 || spend.occurredAtMillis > now + 86_400_000) {
        outcomes.push({ id: spend.id, result: "ignored", reason: "invalid time" }); continue;
      }

      if (kind === "refund") {
        inBatch.add(spend.id);
        synced ??= await ctx.db.query("cardSyncSpends").withIndex("by_pot_spend", (q) => q.eq("potId", link.potId)).collect();
        const candidates = synced
          .filter((r) => r.kind === undefined && r.cancelledAt === undefined && r.card === card.last4 && r.eventId
            && (r.occurredAtMillis === undefined || r.occurredAtMillis <= spend.occurredAtMillis))
          .sort((x, y) => (y.occurredAtMillis ?? 0) - (x.occurredAtMillis ?? 0));
        let target: Tracked | null = null;
        let exact: Tracked | null = null;
        for (const row of candidates) {
          const t = await trackedFor(row);
          if (!t?.head || t.voided || t.head.content.amount.minorUnits < minor || t.head.content.allocations.length !== 1) continue;
          const merchantMatches = merchantKey && row.merchantKey ? row.merchantKey === merchantKey
            : sameMerchant(t.head.texts.get("title") ?? "", clip(spend.merchant, 120) || "Card payment");
          if (!merchantMatches) continue;
          if (t.head.content.amount.minorUnits === minor) { exact = t; break; }
          target ??= t;
        }
        target = exact ?? target;
        const label = `${formatMoney(minor, pot.currencyCode, pot.currencyExponent)} refund`;
        if (!target?.head) {
          rows.push({ potId: link.potId, spendId: spend.id, eventId: "", card: card.last4, addedAt: now, kind: "refund", merchantKey, occurredAtMillis: spend.occurredAtMillis });
          outcomes.push({ id: spend.id, result: "unmatched", reason: `no spend on •${card.last4} at this merchant to take the ${label} from` });
          continue;
        }
        const head = target.head;
        let eventId: string;
        if (head.content.amount.minorUnits === minor) {
          eventId = voidEvent(target, `Refunded in full by ${clip(spend.merchant, 60) || "the merchant"}`, spend.occurredAtMillis);
          outcomes.push({ id: spend.id, result: "voided" });
        } else {
          const rest = head.content.amount.minorUnits - minor;
          const content: ExpenseContent = { ...head.content, amount: money(rest), allocations: [{ unitId: head.content.allocations[0].unitId, amount: money(rest) }] };
          if (schemaVersion < 2n) delete content.payerMemberId;
          const title = head.texts.get("title") || clip(spend.merchant, 120) || "Card payment";
          const category = head.texts.get("category");
          const note = extendedText
            ? clip([head.texts.get("note"), `${label} on ${new Date(spend.occurredAtMillis).toISOString().slice(0, 10)}`].filter(Boolean).join(". "), 500)
            : undefined;
          const text = [
            { field: "title" as const, value: title },
            ...(category ? [{ field: "category" as const, value: category }] : []),
            ...(note ? [{ field: "note" as const, value: note }] : []),
            ...(extendedText ? [{ field: "reason" as const, value: "Card refund" }] : []),
          ];
          eventId = generateUUIDv7(now);
          events.push({
            eventId, potId: pot.potId, actorMemberId: link.actorMemberId, occurredAtMillis: head.occurredAtMillis,
            originatingTimeZone: link.timeZone, schemaVersion,
            payload: { kind: "expenseRevised", recordId: target.recordId, basis: { kind: "parent", parentEventId: head.eventId }, content: { kind: "expense", ...content } },
            textFields: text.map((t) => t.field), authoredText: text,
          } as EventInput);
          target.head = { ...head, eventId, content, texts: new Map(text.map((t) => [t.field, t.value])) };
          outcomes.push({ id: spend.id, result: "refunded" });
        }
        rows.push({ potId: link.potId, spendId: spend.id, eventId, card: card.last4, addedAt: now, kind: "refund", merchantKey, occurredAtMillis: spend.occurredAtMillis });
        continue;
      }

      if (!liveUnits.has(card.forUnitId)) { outcomes.push({ id: spend.id, result: "ignored", reason: "group no longer in the household" }); continue; }
      inBatch.add(spend.id);
      const amount = money(minor);
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
        schemaVersion,
        payload: {
          kind: "expenseAdded",
          recordId: generateUUIDv7(now),
          content: {
            expenseKind: "personal",
            amount,
            payerUnitId,
            ...(schemaVersion >= 2n ? { payerMemberId: link.actorMemberId } : {}),
            allocations: [{ unitId: card.forUnitId, amount }],
          },
        },
        textFields: text.map((t) => t.field),
        authoredText: text,
      } as EventInput);
      rows.push({ potId: link.potId, spendId: spend.id, eventId, card: card.last4, addedAt: now, merchantKey, occurredAtMillis: spend.occurredAtMillis });
      added += 1;
      outcomes.push({ id: spend.id, result: "added" });
    }
    if (events.length) {
      await appendEventsToPot(ctx, { pot, accountId: link.accountId as Id<"accounts">, actorMemberId: link.actorMemberId, events });
      for (const event of events) {
        await ctx.scheduler.runAfter(0, internal.apns.deliverEventPush, { potId: link.potId, eventId: event.eventId });
      }
    }
    for (const row of rows) await ctx.db.insert("cardSyncSpends", row);
    for (const id of cancelled) await ctx.db.patch(id, { cancelledAt: now });
    await ctx.db.patch(link._id, { lastUsedAt: now, added: link.added + BigInt(added) });
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
      || (s.category !== undefined && typeof s.category !== "string")
      || (s.kind !== undefined && s.kind !== "spend" && s.kind !== "refund" && s.kind !== "cancel")
      || (s.merchantKey !== undefined && typeof s.merchantKey !== "string")) {
      return json({ error: "Each spend needs id, card, occurredAt, merchant, amount (a decimal string) and currency." }, 400);
    }
    clean.push({
      id: s.id, card: s.card.replace(/\D/g, "").slice(-4), occurredAtMillis: Math.trunc(occurred),
      merchant: s.merchant.slice(0, 200), amount: s.amount, currency: s.currency.toUpperCase(),
      ...(typeof s.category === "string" ? { category: s.category.slice(0, 200) } : {}),
      ...(s.kind === "refund" || s.kind === "cancel" ? { kind: s.kind as "refund" | "cancel" } : {}),
      ...(typeof s.merchantKey === "string" ? { merchantKey: s.merchantKey.slice(0, 200) } : {}),
    });
  }
  const result = await ctx.runMutation(internal.cardSync.receive, { keyHash: await sha256Hex(key), spends: clean });
  if (result.status !== 200) return json({ error: result.error }, result.status);
  return json({ outcomes: result.outcomes });
});

export type CardSyncLink = Doc<"cardSyncLinks">;
