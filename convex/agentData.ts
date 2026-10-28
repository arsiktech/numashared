// What a connected agent can read (convex/agentMcp.ts calls these). Every read runs as the
// connection's account and passes the same membership checks the app does. A connection limited to
// one household sees only that household. Nothing here writes.
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { internalQuery, type QueryCtx } from "./_generated/server";
import { fail, requireActiveMembership } from "./lib/access";
import {
  applyFinancialEventState,
  currentContribution,
  type FinancialRecordState,
} from "./lib/financialRecordState";

/** Most financial events one household can have for an agent to read it whole. */
export const maximumFinancialEvents = 6_000;
const defaultRecordLimit = 25;
const maximumRecordLimit = 50;

const financialKinds = [
  "expenseAdded",
  "expenseRevised",
  "recordVoided",
  "recordRestored",
  "settlementRecorded",
  "settlementFlagged",
  "openingBalanceSet",
] as const;

const textFields = ["title", "category", "note", "reason"] as const;

const scopeArgs = { accountId: v.id("accounts"), scopePotId: v.union(v.string(), v.null()) };

/** "12.34" for 1234 with exponent 2; "-0.05" for -5. */
export function formatMinorUnits(minorUnits: bigint, exponent: number): string {
  const negative = minorUnits < 0n;
  const digits = (negative ? -minorUnits : minorUnits).toString().padStart(exponent + 1, "0");
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = digits.slice(digits.length - exponent);
  return `${negative ? "-" : ""}${whole}${exponent > 0 ? `.${fraction}` : ""}`;
}

async function readablePot(
  ctx: QueryCtx,
  args: { accountId: Id<"accounts">; scopePotId: string | null; potId: string },
): Promise<{ pot: Doc<"pots">; membership: Doc<"potMembers"> }> {
  if (args.scopePotId !== null && args.scopePotId !== args.potId) fail("AGENT_NOT_ALLOWED");
  const membership = await requireActiveMembership(ctx, args.potId, args.accountId);
  const pot = await ctx.db.query("pots")
    .withIndex("by_pot_id", (q) => q.eq("potId", args.potId))
    .unique();
  if (!pot) fail("POT_MISSING");
  return { pot, membership };
}

async function rosterOf(ctx: QueryCtx, potId: string): Promise<Doc<"potMemberProfiles">[]> {
  const profiles = await ctx.db.query("potMemberProfiles")
    .withIndex("by_pot_member", (q) => q.eq("potId", potId))
    .take(65);
  if (profiles.length > 64) fail("TOO_MANY_MEMBERS");
  return profiles;
}

function displayName(profile: Doc<"potMemberProfiles">): string {
  if (profile.displayName) return profile.displayName;
  return profile.state === "archived" ? "Former member" : "Someone";
}

/** Which people stand behind each settlement unit: one person, or a group that pays as one. */
function unitPeople(pot: Doc<"pots">, profiles: readonly Doc<"potMemberProfiles">[]) {
  const people = new Map<string, Array<{ memberId: string; name: string }>>();
  const add = (unitId: string | undefined, memberId: string, name: string) => {
    if (unitId === undefined) return;
    const list = people.get(unitId) ?? [];
    if (!list.some((person) => person.memberId === memberId)) list.push({ memberId, name });
    people.set(unitId, list);
  };
  for (const profile of profiles) {
    const name = displayName(profile);
    add(profile.unitId, profile.memberId, name);
    const projected = pot.budgetGroupTopology?.members.find((m) => m.memberId === profile.memberId);
    add(projected?.personalUnitId, profile.memberId, name);
    add(projected?.unitId, profile.memberId, name);
  }
  const label = (unitId: string): string => {
    const list = people.get(unitId);
    return list && list.length > 0 ? list.map((person) => person.name).join(" & ") : "Unknown";
  };
  return { people, label };
}

type FinancialEvent = Doc<"events">;

async function financialEvents(ctx: QueryCtx, potId: string): Promise<FinancialEvent[]> {
  const events: FinancialEvent[] = [];
  for (const kind of financialKinds) {
    const rows = await ctx.db.query("events")
      .withIndex("by_pot_kind", (q) => q.eq("potId", potId).eq("payload.kind", kind))
      .take(maximumFinancialEvents + 1 - events.length);
    events.push(...rows);
    if (events.length > maximumFinancialEvents) fail("HOUSEHOLD_TOO_LARGE_FOR_AGENT");
  }
  events.sort((a, b) => (a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0));
  return events;
}

function recordStates(events: readonly FinancialEvent[]) {
  const states = new Map<string, FinancialRecordState>();
  const byRecord = new Map<string, FinancialEvent[]>();
  for (const event of events) {
    if (event.recordId === undefined) continue;
    let state = states.get(event.recordId);
    if (!state) {
      state = {
        revisionEventIds: new Set(),
        revisions: new Map(),
        heads: new Set(),
        resolvedContests: new Map(),
        isFlagged: false,
        isVoided: false,
        nextOrder: 0,
      };
      states.set(event.recordId, state);
    }
    applyFinancialEventState(state, event);
    byRecord.set(event.recordId, [...(byRecord.get(event.recordId) ?? []), event]);
  }
  return { states, byRecord };
}

/** The households this account is an active member of (only the connection's household if limited). */
export const households = internalQuery({
  args: scopeArgs,
  handler: async (ctx, args) => {
    const memberships = await ctx.db.query("potMembers")
      .withIndex("by_account_status", (q) => q.eq("accountId", args.accountId).eq("status", "active"))
      .take(50);
    const result = [];
    for (const membership of memberships) {
      if (args.scopePotId !== null && membership.potId !== args.scopePotId) continue;
      const pot = await ctx.db.query("pots")
        .withIndex("by_pot_id", (q) => q.eq("potId", membership.potId))
        .unique();
      if (!pot || pot.deletingAt !== undefined) continue;
      const profiles = await rosterOf(ctx, pot.potId);
      result.push({
        householdId: pot.potId,
        name: pot.name ?? null,
        currency: pot.currencyCode,
        yourRole: membership.role,
        yourMemberId: membership.memberId,
        activeMembers: profiles.filter((profile) => profile.state === "active").length,
        archived: pot.archivedAtSequence !== undefined,
      });
    }
    return result.sort((a, b) => a.householdId.localeCompare(b.householdId));
  },
});

/** The people in a household. */
export const members = internalQuery({
  args: { ...scopeArgs, potId: v.string() },
  handler: async (ctx, args) => {
    const { pot, membership } = await readablePot(ctx, args);
    const profiles = await rosterOf(ctx, pot.potId);
    return profiles.map((profile) => ({
      memberId: profile.memberId,
      name: displayName(profile),
      role: profile.role,
      state: profile.state,
      isYou: profile.memberId === membership.memberId,
      unitId: pot.budgetGroupTopology?.members.find((m) => m.memberId === profile.memberId)?.unitId
        ?? profile.unitId ?? null,
    }));
  },
});

/** Who is owed and who owes, from every live record. Positive means owed money. */
export const balances = internalQuery({
  args: { ...scopeArgs, potId: v.string() },
  handler: async (ctx, args) => {
    const { pot, membership } = await readablePot(ctx, args);
    const profiles = await rosterOf(ctx, pot.potId);
    const { people, label } = unitPeople(pot, profiles);
    const exponent = Number(pot.currencyExponent);
    const events = await financialEvents(ctx, pot.potId);
    const { states } = recordStates(events);

    const net = new Map<string, bigint>();
    let records = 0;
    for (const state of states.values()) {
      const contribution = currentContribution(state);
      if (contribution.size === 0) continue;
      records += 1;
      for (const [unitId, amount] of contribution) net.set(unitId, (net.get(unitId) ?? 0n) + amount);
    }
    // Every person's unit shows up, even at zero, so the agent can say "settled".
    for (const unitId of people.keys()) if (!net.has(unitId)) net.set(unitId, 0n);

    // A group unit and a member's own unit can name the same people; show each person once.
    const seen = new Set<string>();
    const units = [];
    let total = 0n;
    for (const [unitId, amount] of net) {
      total += amount;
      const names = people.get(unitId) ?? [];
      const key = names.map((person) => person.memberId).sort().join(",");
      if (amount === 0n && key !== "" && seen.has(key)) continue;
      if (key !== "") seen.add(key);
      units.push({
        unitId,
        label: label(unitId),
        memberIds: names.map((person) => person.memberId),
        includesYou: names.some((person) => person.memberId === membership.memberId),
        minorUnits: amount.toString(),
        amount: formatMinorUnits(amount, exponent),
      });
    }
    units.sort((a, b) => {
      const left = BigInt(a.minorUnits);
      const right = BigInt(b.minorUnits);
      return left === right ? a.label.localeCompare(b.label) : left > right ? -1 : 1;
    });
    return {
      householdId: pot.potId,
      currency: pot.currencyCode,
      exponent,
      meaning: "Positive means the person or group is owed money. Negative means they owe money. The amounts add up to zero.",
      units,
      sumMinorUnits: total.toString(),
      liveRecords: records,
    };
  },
});

type Money = { minorUnits: bigint };

/** The household's records, newest first: expenses, repayments and opening balances. */
export const records = internalQuery({
  args: {
    ...scopeArgs,
    potId: v.string(),
    limit: v.optional(v.number()),
    beforeSequence: v.optional(v.string()),
    recordId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { pot } = await readablePot(ctx, args);
    const profiles = await rosterOf(ctx, pot.potId);
    const { label } = unitPeople(pot, profiles);
    const exponent = Number(pot.currencyExponent);
    const money = (amount: Money) => ({ minorUnits: amount.minorUnits.toString(), amount: formatMinorUnits(amount.minorUnits, exponent) });
    const limit = Math.min(maximumRecordLimit, Math.max(1, Math.floor(args.limit ?? defaultRecordLimit)));
    let before: bigint | null = null;
    if (args.beforeSequence !== undefined) {
      if (!/^\d{1,18}$/.test(args.beforeSequence)) fail("AGENT_BAD_CURSOR");
      before = BigInt(args.beforeSequence);
    }

    const events = await financialEvents(ctx, pot.potId);
    const { states, byRecord } = recordStates(events);
    const roots = [...byRecord.entries()]
      .map(([recordId, list]) => ({ recordId, root: list[0]!, list }))
      .filter((entry) => args.recordId === undefined || entry.recordId === args.recordId)
      .filter((entry) => before === null || entry.root.sequence < before)
      .sort((a, b) => (a.root.sequence < b.root.sequence ? 1 : a.root.sequence > b.root.sequence ? -1 : 0));
    const page = roots.slice(0, limit);

    const out = [];
    for (const entry of page) {
      const state = states.get(entry.recordId)!;
      const texts: Record<string, string | null> = {};
      for (const event of [...entry.list].reverse()) {
        for (const field of textFields) {
          if (field in texts || !event.textFields.includes(field)) continue;
          const row = await ctx.db.query("eventTexts")
            .withIndex("by_event_field", (q) => q.eq("potId", pot.potId).eq("eventId", event.eventId).eq("field", field))
            .unique();
          texts[field] = row?.value ?? null;
        }
      }
      const base = {
        recordId: entry.recordId,
        occurredAt: new Date(Number(entry.root.occurredAtMillis)).toISOString(),
        recordedAt: new Date(entry.root.createdAt).toISOString(),
        sequence: entry.root.sequence.toString(),
        title: texts.title ?? null,
        category: texts.category ?? null,
        note: texts.note ?? null,
        reason: texts.reason ?? null,
      };
      if (state.rootKind === "settlement" && state.settlement) {
        const content = state.settlement.content;
        out.push({
          ...base,
          kind: "repayment",
          status: state.isFlagged ? "flagged" : "live",
          from: label(content.fromUnitId),
          to: label(content.toUnitId),
          ...money(content.amount),
          correctsRecordId: content.reversalOfRecordId ?? null,
        });
        continue;
      }
      let head: ReturnType<FinancialRecordState["revisions"]["get"]>;
      for (const eventId of state.heads) {
        const revision = state.revisions.get(eventId);
        if (revision && (!head || revision.order > head.order)) head = revision;
      }
      const content = head?.payload.content;
      const status = state.isVoided ? "voided" : state.heads.size > 1 ? "contested" : "live";
      if (!content) continue;
      if ("entries" in content) {
        out.push({
          ...base,
          kind: "opening-balance",
          status,
          entries: content.entries.map((entryItem) => ({ who: label(entryItem.unitId), ...money(entryItem.amount) })),
        });
        continue;
      }
      out.push({
        ...base,
        kind: content.expenseKind === "personal" ? "personal-expense" : "expense",
        status,
        paidBy: label(content.payerUnitId),
        ...money(content.amount),
        splitBetween: content.allocations.map((allocation) => ({ who: label(allocation.unitId), ...money(allocation.amount) })),
      });
    }
    const last = page.at(-1);
    return {
      householdId: pot.potId,
      currency: pot.currencyCode,
      records: out,
      nextBeforeSequence: roots.length > page.length && last ? last.root.sequence.toString() : null,
    };
  },
});
