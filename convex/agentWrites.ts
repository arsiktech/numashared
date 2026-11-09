// What a connected agent can change (convex/agentMcp.ts calls `write`), as the connection's person.
//
// Every write builds the same wire events the app builds (app/src/sync/mapping.ts, engine.ts) and
// hands them to the same server functions the app's mutations use: appendEventsToPot for money,
// and the bodies of members:renamePot, addPendingMember, changeBudgetGroups and issueInvite for the
// household. So validation, the text manifest, the currency lock, group limits, the revision rules
// and the client contract (Swift build 11) apply unchanged, and every client reduces the result
// exactly as it reduces an app-made event. The only addition is `events.via`, the connection's
// name, which the history shows as "Arseny via Claude". It sits beside the event, not inside it.
//
// The server enforces the person's switches (Settings, AI agents) on every call, before anything
// else. There is deliberately no operation that deletes an account or a household, leaves a
// household or removes a member: `agentWriteOps` below is the complete list, and its validator
// admits nothing else.
import { ConvexError, v, type Infer } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { accountIsUsable, permissionsOf, type AgentSwitch } from "./agentAccess";
import { formatMinorUnits } from "./agentData";
import { addOrBindPendingMember, changeBudgetGroupsForMember, issueInviteForMember, renamePotForMember, revokeInviteForMember } from "./members";
import { queueEventPushes } from "./pushQueue";
import { requireActiveMembership } from "./lib/access";
import { appendEventsToPot } from "./lib/appendEvents";
import { activeBudgetUnitIds, loadBudgetGroupTopology, type BudgetGroupTopology } from "./lib/budgetGroupTopology";
import { loadClientContract } from "./lib/clientContract";
import { requireApprovedWriteTarget } from "./lib/deployment";
import { canonicalValue, type EventInput } from "./lib/eventValidation";
import { buildFinancialRecordState, type FinancialRecordState } from "./lib/financialRecordState";
import { sha256Hex } from "./lib/hash";
import { readInviteTicketSecret } from "./lib/inviteTicket";
import { ios18TimeZoneIdentifiers } from "./lib/ios18TimeZoneIdentifiers";
import { isNotificationEligible } from "./lib/notificationMatrix";
import { generateUUIDv7 } from "./lib/uuidV7";

declare const process: { env: Record<string, string | undefined> };

/** Changes per agent per minute. Reads allow 60 (agentAccess.callsPerMinute). */
export const writesPerMinute = 20;
const requestKeepMillis = 24 * 3_600_000;
/** Same lifetime the app gives a new invite code (app/src/sync/engine.ts). */
const inviteLifetimeMillis = 29 * 24 * 3_600_000;

/** The app's categories and their labels (app/src/core/names.ts). */
export const CATEGORIES: Readonly<Record<string, string>> = {
  groceries: "Groceries",
  household: "Household",
  rent: "Rent",
  bills: "Bills",
  internet: "Internet",
  "eating-out": "Eating out",
  cleaning: "Cleaning",
  other: "Other",
};
/** How money moved, for a repayment (app/src/sync/mapping.ts METHODS). */
export const METHODS = ["bizum", "bank", "cash", "other"] as const;
const SETTLEMENT_TITLE = "Repayment";
/** Invite code letters the app uses (no 0, O, 1 or I). */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** The tools that write, and the switch each one needs. Nothing else can write. */
export const agentWriteTools = {
  add_expense: "addRecords",
  add_repayment: "addRecords",
  edit_record: "editRecords",
  void_record: "editRecords",
  rename_household: "manageHousehold",
  add_person: "manageHousehold",
  update_groups: "manageHousehold",
  create_invite: "manageHousehold",
} as const satisfies Record<string, AgentSwitch>;
export type AgentWriteTool = keyof typeof agentWriteTools;

const id = v.string();
const split = v.union(
  v.object({ mode: v.literal("equal"), between: v.optional(v.array(id)), perPerson: v.boolean() }),
  v.object({ mode: v.literal("exact"), shares: v.array(v.object({ who: id, minorUnits: v.int64() })) }),
);
const when = { date: v.optional(v.string()), timeZone: v.optional(v.string()) };

/** Every write an agent can make. Each names the household it changes. */
export const agentWriteOps = v.union(
  v.object({
    tool: v.literal("add_expense"), potId: id, amountMinorUnits: v.int64(), currency: v.string(),
    title: v.optional(v.string()), category: v.optional(v.string()), note: v.optional(v.string()),
    paidBy: v.optional(id), split, ...when,
  }),
  v.object({
    tool: v.literal("add_repayment"), potId: id, amountMinorUnits: v.int64(), currency: v.string(),
    from: id, to: id, method: v.optional(v.string()), note: v.optional(v.string()), ...when,
  }),
  v.object({
    tool: v.literal("edit_record"), potId: id, recordId: id, revision: id,
    amountMinorUnits: v.optional(v.int64()), currency: v.optional(v.string()),
    title: v.optional(v.string()), category: v.optional(v.string()), note: v.optional(v.string()),
    paidBy: v.optional(id), split: v.optional(split), date: v.optional(v.string()), reason: v.optional(v.string()),
  }),
  v.object({ tool: v.literal("void_record"), potId: id, recordId: id, reason: v.string() }),
  v.object({ tool: v.literal("rename_household"), potId: id, name: v.string() }),
  v.object({ tool: v.literal("add_person"), potId: id, name: v.string() }),
  v.object({ tool: v.literal("update_groups"), potId: id, groups: v.array(v.array(id)) }),
  v.object({ tool: v.literal("create_invite"), potId: id, memberId: id, replaceExisting: v.boolean() }),
);
export type AgentWriteOp = Infer<typeof agentWriteOps>;
type Op<T extends AgentWriteTool> = Extract<AgentWriteOp, { tool: T }>;

/** A refusal the agent can act on. `detail` adds the specific field or value. */
function refuse(code: string, detail?: string): never {
  throw new ConvexError({ code, retryable: false, ...(detail ? { detail } : {}) });
}

const switchCodes: Record<AgentSwitch, string> = {
  addRecords: "AGENT_SWITCH_ADD_RECORDS_OFF",
  editRecords: "AGENT_SWITCH_EDIT_RECORDS_OFF",
  manageHousehold: "AGENT_SWITCH_MANAGE_HOUSEHOLD_OFF",
};

type Money = { minorUnits: bigint; currency: { code: string; exponent: bigint } };
type ExpenseContent = {
  expenseKind: "shared" | "personal";
  amount: Money;
  payerUnitId: string;
  payerMemberId?: string;
  allocations: Array<{ unitId: string; amount: Money }>;
};

type Context = {
  ctx: MutationCtx;
  pot: Doc<"pots">;
  membership: Doc<"potMembers">;
  accountId: Id<"accounts">;
  now: number;
  extendedText: boolean;
  warnings: string[];
};

// ---------- people and groups ----------

type Units = {
  topology: BudgetGroupTopology;
  active: Set<string>;
  /** A person's current group (their settlement unit), or a unit id passed straight through. */
  unitOf: (who: string, field: string) => string;
  /** People who pay through a unit and are still in the household. */
  peopleIn: (unitId: string) => number;
};

async function units(c: Context): Promise<Units> {
  const topology = await loadBudgetGroupTopology(c.ctx, c.pot);
  const active = activeBudgetUnitIds(topology, c.pot.orderedUnitIds);
  const unitOf = (who: string, field: string): string => {
    const member = topology.members.find((m) => m.memberId === who);
    if (member) {
      if (member.archived) refuse("AGENT_PERSON_LEFT", field);
      return member.unitId;
    }
    if (active.has(who)) return who;
    refuse("AGENT_UNKNOWN_PERSON", field);
  };
  const peopleIn = (unitId: string) => topology.members.filter((m) => !m.archived && m.unitId === unitId).length || 1;
  return { topology, active, unitOf, peopleIn };
}

// ---------- money and text ----------

function money(c: Context, minorUnits: bigint): Money {
  return { minorUnits, currency: { code: c.pot.currencyCode, exponent: c.pot.currencyExponent } };
}

function amountOf(c: Context, minorUnits: bigint, currency: string): bigint {
  if (currency.trim().toUpperCase() !== c.pot.currencyCode) {
    refuse("AGENT_CURRENCY_MISMATCH", `this household records ${c.pot.currencyCode}; got ${currency}`);
  }
  if (minorUnits <= 0n) refuse("AGENT_AMOUNT_INVALID", "amount_minor_units must be a whole number above 0");
  // An amount above 10 million in any currency is far more likely a mistake than a household cost.
  if (minorUnits > 10_000_000n * 10n ** c.pot.currencyExponent) refuse("AGENT_AMOUNT_INVALID", "amount_minor_units is too large");
  return minorUnits;
}

/** Plain short text, or undefined when blank. Blank means "none" (the app drops blank text too). */
function cleanText(value: string | undefined, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (text === "") return undefined;
  if (text.length > max) refuse("AGENT_TEXT_TOO_LONG", `${field} is longer than ${max} characters`);
  if (text === "[redacted]") refuse("AGENT_TEXT_TOO_LONG", `${field} can't be "[redacted]"`);
  return text;
}

function categoryOf(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const key = value.trim().toLowerCase().replace(/\s+/g, "-");
  if (!(key in CATEGORIES)) refuse("AGENT_CATEGORY_UNKNOWN", `use one of ${Object.keys(CATEGORIES).join(", ")}`);
  return key;
}

/** The wire time of a record dated YYYY-MM-DD: noon UTC, the same day in every zone people live in. */
function occurredAt(c: Context, date: string | undefined): bigint {
  if (date === undefined) return BigInt(c.now);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  const ms = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12) : NaN;
  if (!m || Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== date.trim()) {
    refuse("AGENT_DATE_INVALID", "date must be YYYY-MM-DD");
  }
  if (ms < Date.UTC(2000, 0, 1) || ms > c.now + 366 * 86_400_000) refuse("AGENT_DATE_INVALID", "date is out of range");
  return BigInt(ms);
}

/** The time zone the record was made in: the agent's, else the person's phone, else UTC. */
async function timeZoneOf(c: Context, timeZone: string | undefined): Promise<string> {
  if (timeZone !== undefined) {
    if (!ios18TimeZoneIdentifiers.has(timeZone)) refuse("AGENT_TIME_ZONE_INVALID", "time_zone must be an IANA name such as Europe/Madrid");
    return timeZone;
  }
  const tokens = await c.ctx.db.query("pushTokens").withIndex("by_account", (q) => q.eq("accountId", c.accountId)).take(10);
  const latest = tokens.sort((a, b) => b.updatedAt - a.updatedAt)[0]?.timeZone;
  return latest && ios18TimeZoneIdentifiers.has(latest) ? latest : "UTC";
}

/** Builds the manifest and authored text in the canonical order, as app/src/sync/wire.ts authored(). */
function authored(text: Partial<Record<"title" | "category" | "note" | "reason", string | undefined>>) {
  const fields = (["title", "category", "note", "reason"] as const).filter((f) => text[f] !== undefined);
  return { textFields: fields, authoredText: fields.map((field) => ({ field, value: text[field]! })) };
}

/** Exact integer split by weight, remainder to the last unit (app/src/core/allocate.ts allocateEqual). */
export function allocateEqual(amount: bigint, weights: Array<{ unitId: string; weight: bigint }>): Map<string, bigint> {
  const total = weights.reduce((sum, w) => sum + w.weight, 0n);
  const result = new Map<string, bigint>();
  let used = 0n;
  weights.forEach(({ unitId, weight }, index) => {
    const portion = index === weights.length - 1 ? amount - used : (amount * weight) / total;
    used += portion;
    result.set(unitId, portion);
  });
  return result;
}

type SplitInput = Infer<typeof split>;

function allocations(c: Context, u: Units, amount: bigint, input: SplitInput): Array<{ unitId: string; amount: Money }> {
  if (input.mode === "equal") {
    const listed = input.between ?? [];
    const ids: string[] = [];
    if (listed.length === 0) {
      // Everyone: every group still in the household, in the household's order.
      for (const unitId of [...c.pot.orderedUnitIds, ...u.topology.groups.map((g) => g.unitId)]) {
        if (u.active.has(unitId) && !ids.includes(unitId)) ids.push(unitId);
      }
    } else {
      for (const who of listed) {
        const unitId = u.unitOf(who, "split.between");
        if (!ids.includes(unitId)) ids.push(unitId);
      }
    }
    if (ids.length === 0) refuse("AGENT_SPLIT_INVALID", "nobody to split between");
    const parts = allocateEqual(amount, ids.map((unitId) => ({ unitId, weight: input.perPerson ? BigInt(u.peopleIn(unitId)) : 1n })));
    return ids.map((unitId) => ({ unitId, amount: money(c, parts.get(unitId)!) }));
  }
  if (input.shares.length === 0) refuse("AGENT_SPLIT_INVALID", "split.shares is empty");
  const out: Array<{ unitId: string; amount: Money }> = [];
  let sum = 0n;
  for (const share of input.shares) {
    const unitId = u.unitOf(share.who, "split.shares.who");
    if (out.some((a) => a.unitId === unitId)) refuse("AGENT_SPLIT_INVALID", "two shares go to the same group; combine them");
    if (share.minorUnits < 0n) refuse("AGENT_SPLIT_INVALID", "a share is below 0");
    sum += share.minorUnits;
    out.push({ unitId, amount: money(c, share.minorUnits) });
  }
  if (sum !== amount) refuse("AGENT_SPLIT_INVALID", `the shares add up to ${sum}, not ${amount} minor units`);
  return out;
}

/** "personal" when the whole amount goes to one other group, as app/src/sync/mapping.ts expenseToWire. */
function expenseKind(payerUnitId: string, parts: Array<{ unitId: string; amount: Money }>): "shared" | "personal" {
  const nonzero = parts.filter((a) => a.amount.minorUnits > 0n);
  return nonzero.length === 1 && parts.length === 1 && nonzero[0]!.unitId !== payerUnitId ? "personal" : "shared";
}

function newEvent(c: Context, payload: EventInput["payload"], occurred: bigint, timeZone: string,
  text: ReturnType<typeof authored>): EventInput {
  return {
    eventId: generateUUIDv7(c.now),
    potId: c.pot.potId,
    actorMemberId: c.membership.memberId,
    occurredAtMillis: occurred,
    originatingTimeZone: timeZone,
    schemaVersion: c.pot.minimumReaderSchemaVersion,
    payload,
    ...text,
  } as EventInput;
}

/** Appends financial events exactly as events:appendEvents does, pushes included. */
async function appendFinancial(c: Context, events: EventInput[]) {
  const appended = await appendEventsToPot(c.ctx, {
    pot: c.pot, accountId: c.accountId, actorMemberId: c.membership.memberId, events,
  });
  const inserted = new Set(appended.insertedEventIds);
  await queueEventPushes(c.ctx, c.pot.potId,
    events.filter((e) => inserted.has(e.eventId) && isNotificationEligible(e.payload)).map((e) => e.eventId));
  return appended.events;
}

// ---------- records ----------

async function addExpense(c: Context, op: Op<"add_expense">) {
  const u = await units(c);
  const amount = amountOf(c, op.amountMinorUnits, op.currency);
  const payer = op.paidBy ?? c.membership.memberId;
  if (!u.topology.members.some((m) => m.memberId === payer)) refuse("AGENT_UNKNOWN_PERSON", "paid_by must be a person's member_id from list_members");
  const payerUnitId = u.unitOf(payer, "paid_by");
  const parts = allocations(c, u, amount, op.split);
  const category = categoryOf(op.category);
  const title = cleanText(op.title, "title", 120) ?? (category ? CATEGORIES[category] : undefined);
  if (title === undefined) refuse("AGENT_TITLE_REQUIRED", "give a title or a category");
  let note = cleanText(op.note, "note", 500);
  if (note !== undefined && !c.extendedText) {
    note = undefined;
    c.warnings.push("The note wasn't saved: someone in this household uses an older app that can't show notes yet.");
  }
  const recordId = generateUUIDv7(c.now);
  const schema = c.pot.minimumReaderSchemaVersion;
  const event = newEvent(c, {
    kind: "expenseAdded",
    recordId,
    content: {
      expenseKind: expenseKind(payerUnitId, parts),
      amount: money(c, amount),
      payerUnitId,
      ...(schema >= 2n ? { payerMemberId: payer } : {}),
      allocations: parts,
    },
  }, occurredAt(c, op.date), await timeZoneOf(c, op.timeZone), authored({ title, category: category ?? "other", note }));
  const [receipt] = await appendFinancial(c, [event]);
  return {
    recordId, revision: event.eventId, sequence: receipt!.sequence.toString(),
    ...shown(c, amount),
    split: parts.map((a) => ({ unitId: a.unitId, ...shown(c, a.amount.minorUnits) })),
  };
}

const shown = (c: Context, minorUnits: bigint) => ({
  minorUnits: minorUnits.toString(),
  amount: formatMinorUnits(minorUnits, Number(c.pot.currencyExponent)),
  currency: c.pot.currencyCode,
});

async function addRepayment(c: Context, op: Op<"add_repayment">) {
  const u = await units(c);
  const amount = amountOf(c, op.amountMinorUnits, op.currency);
  const fromUnitId = u.unitOf(op.from, "from");
  const toUnitId = u.unitOf(op.to, "to");
  if (fromUnitId === toUnitId) refuse("AGENT_REPAYMENT_SAME_GROUP");
  let method: string | undefined;
  if (op.method !== undefined && op.method.trim() !== "") {
    method = op.method.trim().toLowerCase();
    if (!(METHODS as readonly string[]).includes(method)) refuse("AGENT_METHOD_UNKNOWN", `use one of ${METHODS.join(", ")}`);
  }
  let note = cleanText(op.note, "note", 500);
  if ((method !== undefined || note !== undefined) && !c.extendedText) {
    method = undefined;
    note = undefined;
    c.warnings.push("The method and note weren't saved: someone in this household uses an older app that can't show them yet.");
  }
  const recordId = generateUUIDv7(c.now);
  const event = newEvent(c, {
    kind: "settlementRecorded", recordId,
    content: { amount: money(c, amount), fromUnitId, toUnitId },
  }, occurredAt(c, op.date), await timeZoneOf(c, op.timeZone), authored({ title: SETTLEMENT_TITLE, category: method, note }));
  const [receipt] = await appendFinancial(c, [event]);
  return { recordId, sequence: receipt!.sequence.toString(), fromUnitId, toUnitId, ...shown(c, amount) };
}

async function loadRecord(c: Context, recordId: string): Promise<{ events: Doc<"events">[]; state: FinancialRecordState }> {
  const events = await c.ctx.db.query("events")
    .withIndex("by_pot_record", (q) => q.eq("potId", c.pot.potId).eq("recordId", recordId))
    .order("asc").collect();
  const state = buildFinancialRecordState(events);
  if (state.rootKind === undefined) refuse("AGENT_RECORD_NOT_FOUND");
  return { events, state };
}

async function texts(c: Context, eventId: string): Promise<Map<string, string>> {
  const rows = await c.ctx.db.query("eventTexts")
    .withIndex("by_pot_event", (q) => q.eq("potId", c.pot.potId).eq("eventId", eventId)).collect();
  return new Map(rows.map((row) => [row.field, row.value]));
}

async function editRecord(c: Context, op: Op<"edit_record">) {
  const { events, state } = await loadRecord(c, op.recordId);
  if (state.rootKind === "settlement") refuse("AGENT_REPAYMENT_IMMUTABLE");
  if (state.rootKind === "openingBalance") refuse("AGENT_OPENING_BALANCE_EDIT");
  if (state.isVoided) refuse("AGENT_RECORD_VOIDED");
  if (state.heads.size !== 1) refuse("AGENT_RECORD_CONTESTED");
  const headEventId = [...state.heads][0]!;
  if (headEventId !== op.revision) refuse("AGENT_RECORD_CHANGED");
  const head = state.revisions.get(headEventId)!.payload;
  const raw = head.content;
  if ("entries" in raw) refuse("AGENT_OPENING_BALANCE_EDIT");
  const { kind: _kind, ...before } = raw as ExpenseContent & { kind?: string };
  const headEvent = events.find((e) => e.eventId === headEventId)!;
  const headText = await texts(c, headEventId);

  const u = await units(c);
  const schema = c.pot.minimumReaderSchemaVersion;
  const amount = op.amountMinorUnits === undefined ? before.amount.minorUnits
    : amountOf(c, op.amountMinorUnits, op.currency ?? "");
  if (op.amountMinorUnits === undefined && op.currency !== undefined && op.currency.trim().toUpperCase() !== c.pot.currencyCode) {
    refuse("AGENT_CURRENCY_MISMATCH", `this household records ${c.pot.currencyCode}; got ${op.currency}`);
  }
  let payerUnitId = before.payerUnitId;
  let payerMemberId = before.payerMemberId;
  if (op.paidBy !== undefined) {
    if (!u.topology.members.some((m) => m.memberId === op.paidBy)) refuse("AGENT_UNKNOWN_PERSON", "paid_by must be a person's member_id from list_members");
    payerUnitId = u.unitOf(op.paidBy, "paid_by");
    payerMemberId = op.paidBy;
  }
  let parts = before.allocations;
  if (op.split !== undefined) {
    parts = allocations(c, u, amount, op.split);
  } else if (amount !== before.amount.minorUnits) {
    // Keep an equal split equal at the new amount; anything else needs the new split spelled out.
    const equal = allocateEqual(before.amount.minorUnits, before.allocations.map((a) => ({ unitId: a.unitId, weight: 1n })));
    if (!before.allocations.every((a) => equal.get(a.unitId) === a.amount.minorUnits)) {
      refuse("AGENT_SPLIT_REQUIRED");
    }
    const next = allocateEqual(amount, before.allocations.map((a) => ({ unitId: a.unitId, weight: 1n })));
    parts = before.allocations.map((a) => ({ unitId: a.unitId, amount: money(c, next.get(a.unitId)!) }));
  }
  const content: ExpenseContent = {
    expenseKind: expenseKind(payerUnitId, parts),
    amount: money(c, amount),
    payerUnitId,
    ...(schema >= 2n && payerMemberId !== undefined ? { payerMemberId } : {}),
    allocations: parts,
  };

  const category = categoryOf(op.category) ?? headText.get("category");
  let title = op.title === undefined ? headText.get("title") : cleanText(op.title, "title", 120);
  title ??= CATEGORIES[category ?? "other"] ?? "Other";
  let note = op.note === undefined ? headText.get("note") : cleanText(op.note, "note", 500);
  let reason = cleanText(op.reason, "reason", 300);
  if (!c.extendedText) {
    if ((op.note !== undefined && note !== undefined) || reason !== undefined) {
      c.warnings.push("The note or reason wasn't saved: someone in this household uses an older app that can't show it yet.");
    }
    note = undefined;
    reason = undefined;
  }
  const occurred = op.date === undefined ? headEvent.occurredAtMillis : occurredAt(c, op.date);
  const unchanged = canonicalValue(content) === canonicalValue({ ...before, ...(schema >= 2n ? {} : { payerMemberId: undefined }) })
    && occurred === headEvent.occurredAtMillis
    && title === headText.get("title") && category === headText.get("category") && note === headText.get("note");
  if (unchanged) refuse("AGENT_NOTHING_TO_CHANGE");
  if (schema < 2n) delete content.payerMemberId;

  const event = newEvent(c, {
    kind: "expenseRevised",
    recordId: op.recordId,
    basis: { kind: "parent", parentEventId: headEventId },
    content: { kind: "expense", ...content },
  }, occurred, headEvent.originatingTimeZone, authored({ title, category, note, reason }));
  const [receipt] = await appendFinancial(c, [event]);
  return {
    recordId: op.recordId, revision: event.eventId, sequence: receipt!.sequence.toString(),
    ...shown(c, amount),
    split: parts.map((a) => ({ unitId: a.unitId, ...shown(c, a.amount.minorUnits) })),
  };
}

async function voidRecord(c: Context, op: Op<"void_record">) {
  const { state } = await loadRecord(c, op.recordId);
  if (state.rootKind === "settlement") refuse("AGENT_REPAYMENT_IMMUTABLE");
  if (state.isVoided) refuse("AGENT_RECORD_VOIDED");
  const reason = cleanText(op.reason, "reason", 300);
  if (reason === undefined) refuse("AGENT_REASON_REQUIRED");
  const event = newEvent(c, { kind: "recordVoided", recordId: op.recordId }, BigInt(c.now),
    await timeZoneOf(c, undefined), authored({ reason }));
  const [receipt] = await appendFinancial(c, [event]);
  return { recordId: op.recordId, voided: true, sequence: receipt!.sequence.toString() };
}

// ---------- the household ----------

function structuralEvent(c: Context, payload: EventInput["payload"], timeZone: string, schemaVersion = c.pot.minimumReaderSchemaVersion): EventInput {
  return { ...newEvent(c, payload, BigInt(c.now), timeZone, authored({})), schemaVersion };
}

async function renameHousehold(c: Context, op: Op<"rename_household">) {
  const name = cleanText(op.name, "name", 128);
  if (name === undefined) refuse("AGENT_NAME_REQUIRED");
  const event = structuralEvent(c, { kind: "potRenamed", name }, await timeZoneOf(c, undefined));
  const receipt = await renamePotForMember(c.ctx, { _id: c.accountId }, c.membership, { potId: c.pot.potId, event });
  return { householdId: c.pot.potId, name: receipt.name, sequence: receipt.sequence.toString(), eventIds: [event.eventId] };
}

async function addPerson(c: Context, op: Op<"add_person">) {
  const name = cleanText(op.name, "name", 128);
  if (name === undefined) refuse("AGENT_NAME_REQUIRED");
  const memberId = generateUUIDv7(c.now);
  const unitId = generateUUIDv7(c.now);
  const event = structuralEvent(c, { kind: "memberAdded", memberId, unitId, role: "member" }, await timeZoneOf(c, undefined));
  const receipt = await addOrBindPendingMember({
    ctx: c.ctx, account: { _id: c.accountId }, membership: c.membership,
    args: { potId: c.pot.potId, displayName: name, event }, mode: "addUnit",
  });
  return { memberId, unitId, name, joined: false, sequence: receipt.sequence.toString(), eventIds: [event.eventId] };
}

/** As app/src/sync/engine.ts regroupOnline: one entry per group of two or more; everyone else alone. */
async function updateGroups(c: Context, op: Op<"update_groups">) {
  const topology = await loadBudgetGroupTopology(c.ctx, c.pot);
  const contract = await loadClientContract(c.ctx);
  const seen = new Set<string>();
  for (const group of op.groups) {
    if (group.length > contract.maximumBudgetGroupSize) {
      refuse("AGENT_GROUP_TOO_LARGE", `a group can have at most ${contract.maximumBudgetGroupSize} people in this household`);
    }
    for (const memberId of group) {
      const member = topology.members.find((m) => m.memberId === memberId);
      if (!member) refuse("AGENT_UNKNOWN_PERSON", "groups must list member_ids from list_members");
      if (member.archived) refuse("AGENT_PERSON_LEFT", "groups");
      if (seen.has(memberId)) refuse("AGENT_GROUPS_OVERLAP");
      seen.add(memberId);
    }
  }
  const groups = op.groups.filter((members) => members.length > 1).map((members) => {
    const same = topology.groups.find((g) => g.orderedMemberIds.length === members.length
      && members.every((m) => g.orderedMemberIds.includes(m)));
    return same
      ? { groupId: same.groupId, unitId: same.unitId, orderedMemberIds: [...members], defaultShareWeight: 1n }
      : { groupId: generateUUIDv7(c.now), unitId: generateUUIDv7(c.now), orderedMemberIds: [...members], defaultShareWeight: 1n };
  });
  const event = structuralEvent(c, { kind: "groupChanged", groups }, await timeZoneOf(c, undefined), 2n);
  const receipt = await changeBudgetGroupsForMember(c.ctx, c.accountId, c.membership, {
    potId: c.pot.potId, expectedTopologyRevision: topology.revision, event,
  });
  return {
    householdId: c.pot.potId,
    groups: groups.map((g) => ({ unitId: g.unitId, memberIds: g.orderedMemberIds })),
    sequence: receipt.sequence.toString(),
    eventIds: [event.eventId],
  };
}

async function hmac(secret: string, label: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(label)));
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The invite secrets for one agent request. They are derived, not stored: a retried call gets the
 * same code again, and the server keeps only their hashes, as for an invite made in the app.
 */
async function inviteSecrets(connectionId: string, requestId: string): Promise<{ token: string; code: string }> {
  const secret = readInviteTicketSecret(process.env);
  const token = base64url(await hmac(secret, `agent-invite-token:${connectionId}:${requestId}`));
  const codeBytes = await hmac(secret, `agent-invite-code:${connectionId}:${requestId}`);
  const code = Array.from(codeBytes.slice(0, 6), (b) => CODE_ALPHABET[b & 31]).join("");
  return { token, code };
}

const inviteLink = (origin: string, token: string, code: string) => `${origin}/join/${token}?code=${code}`;

async function createInvite(c: Context, op: Op<"create_invite">, connectionId: string, requestId: string, origin: string) {
  const profile = await c.ctx.db.query("potMemberProfiles")
    .withIndex("by_pot_member", (q) => q.eq("potId", c.pot.potId).eq("memberId", op.memberId)).unique();
  if (!profile) refuse("AGENT_UNKNOWN_PERSON", "member_id must be a person from list_members");
  if (profile.state !== "pending") refuse("AGENT_PERSON_JOINED");
  const live = (await c.ctx.db.query("invites").withIndex("by_pot", (q) => q.eq("potId", c.pot.potId)).collect())
    .filter((i) => i.kind === "perMember" && i.pendingMemberId === op.memberId && i.status === "active" && i.expiresAt > c.now);
  if (live.length > 0) {
    if (!op.replaceExisting) refuse("AGENT_INVITE_EXISTS");
    for (const invite of live) await revokeInviteForMember(c.ctx, c.membership, { potId: c.pot.potId, inviteId: invite.inviteId });
  }
  const { token, code } = await inviteSecrets(connectionId, requestId);
  const inviteId = generateUUIDv7(c.now);
  const expiresAt = c.now + inviteLifetimeMillis;
  await issueInviteForMember(c.ctx, { _id: c.accountId }, c.membership, {
    potId: c.pot.potId, inviteId, kind: "perMember", pendingMemberId: op.memberId, token, code, expiresAt,
  });
  const stored = { inviteId, memberId: op.memberId, expiresAt: new Date(expiresAt).toISOString() };
  return { stored, shown: { ...stored, code, link: inviteLink(origin, token, code), replacedEarlierCode: live.length > 0 } };
}

// ---------- the call ----------

/**
 * One write, as the connection's person. Checks, in order: the connection, the switch for this
 * tool, the household scope, a retry of the same request id, the per-minute write limit, active
 * membership; then the shared server functions check everything the app's own writes go through.
 */
export const write = internalMutation({
  args: {
    connectionId: v.id("agentConnections"),
    requestId: v.string(),
    origin: v.string(),
    op: agentWriteOps,
  },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    requireApprovedWriteTarget();
    const now = Date.now();
    const connection = await ctx.db.get(args.connectionId);
    if (!connection || connection.revokedAt !== undefined) refuse("AGENT_DISCONNECTED");
    if (!(await accountIsUsable(ctx, connection.accountId))) refuse("AGENT_DISCONNECTED");
    const permission = agentWriteTools[args.op.tool];
    if (!permissionsOf(connection)[permission]) refuse(switchCodes[permission]);
    if (connection.potId !== undefined && connection.potId !== args.op.potId) refuse("AGENT_NOT_ALLOWED");
    if (!/^[A-Za-z0-9._:-]{8,100}$/.test(args.requestId)) refuse("AGENT_REQUEST_ID_INVALID");

    const inputHash = await sha256Hex(canonicalValue(args.op));
    const earlier = await ctx.db.query("agentRequests")
      .withIndex("by_connection_request", (q) => q.eq("connectionId", args.connectionId).eq("requestId", args.requestId))
      .unique();
    if (earlier && earlier.expiresAt > now) {
      if (earlier.tool !== args.op.tool || earlier.inputHash !== inputHash) refuse("AGENT_REQUEST_ID_REUSED");
      const result = JSON.parse(earlier.result) as Record<string, unknown>;
      if (args.op.tool === "create_invite") {
        const { token, code } = await inviteSecrets(args.connectionId, args.requestId);
        return { ...result, code, link: inviteLink(args.origin, token, code), replayed: true };
      }
      return { ...result, replayed: true };
    }
    if (earlier) await ctx.db.delete(earlier._id);

    const fresh = connection.writeWindowStartedAt === undefined || now - connection.writeWindowStartedAt >= 60_000;
    const count = fresh ? 0 : connection.writeWindowCount ?? 0;
    if (count >= writesPerMinute) throw new ConvexError({ code: "AGENT_WRITE_LIMITED", retryable: true });
    await ctx.db.patch(connection._id, {
      writeWindowStartedAt: fresh ? now : connection.writeWindowStartedAt,
      writeWindowCount: count + 1,
    });

    const membership = await requireActiveMembership(ctx, args.op.potId, connection.accountId);
    const pot = await ctx.db.query("pots").withIndex("by_pot_id", (q) => q.eq("potId", args.op.potId)).unique();
    if (!pot) refuse("POT_MISSING");
    const c: Context = {
      ctx, pot, membership, accountId: connection.accountId, now,
      extendedText: (await loadClientContract(ctx)).extendedText, warnings: [],
    };
    const op = args.op;
    let result: Record<string, unknown>;
    let stored: Record<string, unknown>;
    switch (op.tool) {
      case "add_expense": result = stored = await addExpense(c, op); break;
      case "add_repayment": result = stored = await addRepayment(c, op); break;
      case "edit_record": result = stored = await editRecord(c, op); break;
      case "void_record": result = stored = await voidRecord(c, op); break;
      case "rename_household": result = stored = await renameHousehold(c, op); break;
      case "add_person": result = stored = await addPerson(c, op); break;
      case "update_groups": result = stored = await updateGroups(c, op); break;
      case "create_invite": {
        const made = await createInvite(c, op, args.connectionId, args.requestId, args.origin);
        result = made.shown;
        stored = made.stored;
        break;
      }
    }

    // Attribution: every event this call appended carries the connection's name.
    const via = connection.name.trim().slice(0, 60) || "an agent";
    const appended = await ctx.db.query("events")
      .withIndex("by_pot_sequence", (q) => q.eq("potId", pot.potId).gte("sequence", pot.nextSequence))
      .take(10);
    for (const event of appended) await ctx.db.patch(event._id, { via });

    if (c.warnings.length) {
      result = { ...result, warnings: c.warnings };
      stored = { ...stored, warnings: c.warnings };
    }
    await ctx.db.insert("agentRequests", {
      connectionId: args.connectionId,
      accountId: connection.accountId,
      requestId: args.requestId,
      tool: op.tool,
      inputHash,
      result: JSON.stringify({ ...stored, householdId: pot.potId }),
      createdAt: now,
      expiresAt: now + requestKeepMillis,
    });
    const expired = await ctx.db.query("agentRequests").withIndex("by_expires_at", (q) => q.lt("expiresAt", now)).take(20);
    for (const row of expired) await ctx.db.delete(row._id);
    return { ...result, householdId: pot.potId };
  },
});
