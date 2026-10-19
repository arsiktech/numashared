// Translation between the app's household model and the backend's wire events.
//
// Identity model. Every id is a UUIDv7 shared with the server:
// - a person's id is their server memberId, and `person.unitId` is their personal unit;
// - a group's id IS its settlement unit: the personal unit of a one-person group, or the group
//   unit of a two-person group (whose server group id is `group.serverGroupId`).
// So balances, payers, splits and repayments map onto units without lookup tables.
import { allocateEqual, shares } from '../core/allocate';
import { currencyDigits } from '../core/money';
import { categoryLabel } from '../core/names';
import type {
  Category, Cents, ExpenseContent, Group, GroupColor, Household, ID, LedgerEvent, OpeningEntry,
  PaymentMethod, Person, SettlementContent, Split,
} from '../core/types';
import { GROUP_COLORS } from '../core/types';
import { getContract, type ClientContract } from './contract';
import { wireTimeZone } from './timezones';
import {
  authored, isPresent, type ListedEvent, type TextField, type WireAllocation, type WireEvent,
  type WireExpense, type WireMoney, type WireOpeningEntry, type WirePayload,
} from './wire';

export const CATEGORIES: readonly Category[] = [
  'groceries', 'household', 'rent', 'bills', 'internet', 'eating-out', 'cleaning', 'other',
];
export const METHODS: readonly PaymentMethod[] = ['bizum', 'bank', 'cash', 'other'];

export const SETTLEMENT_TITLE = 'Repayment';
export const OPENING_TITLE = 'Opening balance';
/** Shown for text the author's account deletion erased. */
export const ERASED_TEXT = 'Removed';

// ---------- dates ----------

export function localISO(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * The wire time of a record dated `date`: the moment it was saved when that is the same day,
 * otherwise noon of that day. Reading back gives the same local date in any nearby time zone.
 */
export function occurredAtFor(date: string | undefined, savedAt: number): number {
  if (!date || date === localISO(savedAt)) return savedAt;
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d, 12).getTime();
}

function contentDate(e: LedgerEvent): string | undefined {
  if (e.kind === 'expenseAdded' || e.kind === 'expenseRevised' || e.kind === 'settlementRecorded' || e.kind === 'openingBalanceSet') {
    return e.content.date;
  }
  return undefined;
}

/** Fixes the wire time and zone of a new event, so a resend is identical. */
export function stamp<E extends LedgerEvent>(e: E): E {
  if (e.occurredAt !== undefined && e.tz) return e;
  return { ...e, occurredAt: occurredAtFor(contentDate(e), e.at), tz: wireTimeZone() };
}

// ---------- money ----------

export function wireMoney(currency: string, cents: Cents): WireMoney {
  return { minorUnits: BigInt(cents), currency: { code: currency, exponent: BigInt(currencyDigits(currency)) } };
}

const cents = (m: WireMoney): Cents => {
  const n = Number(m.minorUnits);
  if (!Number.isSafeInteger(n)) throw new MappingError('amount-out-of-range');
  return n;
};

export class MappingError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'MappingError'; }
}

// ---------- app event -> wire ----------

function groupOf(h: Household, personId: ID): Group {
  const p = h.people.find((x) => x.id === personId);
  const g = p && h.groups.find((x) => x.id === p.groupId);
  if (!g) throw new MappingError('unknown-person');
  return g;
}

function expenseToWire(h: Household, c: ExpenseContent, schema: number): WireExpense {
  const payerUnitId = groupOf(h, c.payerId).id;
  const parts = shares(c, h.groups, h.people);
  const allocations: WireAllocation[] = Object.entries(parts).map(([unitId, share]) => ({
    unitId, amount: wireMoney(h.currency, share),
  }));
  const nonzero = allocations.filter((a) => a.amount.minorUnits > 0n);
  const personal = nonzero.length === 1 && allocations.length === 1 && nonzero[0].unitId !== payerUnitId;
  return {
    expenseKind: personal ? 'personal' : 'shared',
    amount: wireMoney(h.currency, c.amount),
    payerUnitId,
    ...(schema >= 2 ? { payerMemberId: c.payerId } : {}),
    allocations,
  };
}

function expenseText(c: ExpenseContent, contract: ClientContract, extra: Partial<Record<TextField, string | undefined>> = {}) {
  return authored({
    title: isPresent(c.title) ? c.title : categoryLabel(c.category),
    category: c.category,
    ...(contract.extendedText ? { note: c.note, ...extra } : {}),
  });
}

/** Opening entries as signed per-unit amounts: positive means that group is owed money. */
export function openingToWire(currency: string, entries: OpeningEntry[]): WireOpeningEntry[] {
  const net = new Map<ID, number>();
  for (const e of entries) {
    net.set(e.fromGroupId, (net.get(e.fromGroupId) ?? 0) - e.amount);
    net.set(e.toGroupId, (net.get(e.toGroupId) ?? 0) + e.amount);
  }
  return [...net].filter(([, v]) => v !== 0).map(([unitId, v]) => ({ unitId, amount: wireMoney(currency, v) }));
}

/** Signed per-unit amounts back to "who owes whom" pairs (largest debts first). Same effect. */
export function openingFromWire(entries: WireOpeningEntry[]): OpeningEntry[] {
  const debtors = entries.map((e) => ({ id: e.unitId, v: cents(e.amount) })).filter((x) => x.v < 0)
    .map((x) => ({ id: x.id, left: -x.v })).sort((a, b) => b.left - a.left);
  const creditors = entries.map((e) => ({ id: e.unitId, v: cents(e.amount) })).filter((x) => x.v > 0)
    .map((x) => ({ id: x.id, left: x.v })).sort((a, b) => b.left - a.left);
  const out: OpeningEntry[] = [];
  for (const d of debtors) {
    for (const c of creditors) {
      if (d.left === 0) break;
      const take = Math.min(d.left, c.left);
      if (take === 0) continue;
      out.push({ fromGroupId: d.id, toGroupId: c.id, amount: take });
      d.left -= take;
      c.left -= take;
    }
  }
  return out;
}

/**
 * One local event as the server stores it. Under the old contract (see contract.ts) notes, edit
 * reasons and repayment details stay on this phone: Swift build 11 can't read them.
 */
export function toWire(h: Household, potId: ID, schema: number, input: LedgerEvent, contract = getContract()): WireEvent {
  const e = stamp(input);
  let payload: WirePayload;
  let text: ReturnType<typeof authored>;
  switch (e.kind) {
    case 'expenseAdded':
      payload = { kind: 'expenseAdded', recordId: e.recordId, content: expenseToWire(h, e.content, schema) };
      text = expenseText(e.content, contract);
      break;
    case 'expenseRevised':
      if (!e.basis) throw new MappingError('missing-basis');
      payload = {
        kind: 'expenseRevised', recordId: e.recordId, basis: e.basis,
        content: { kind: 'expense', ...expenseToWire(h, e.content, schema) },
      };
      text = expenseText(e.content, contract, { reason: e.reason });
      break;
    case 'settlementRecorded':
      payload = {
        kind: 'settlementRecorded', recordId: e.recordId,
        content: {
          amount: wireMoney(h.currency, e.content.amount),
          fromUnitId: e.content.fromGroupId,
          toUnitId: e.content.toGroupId,
          ...(e.content.reversalOf ? { reversalOfRecordId: e.content.reversalOf } : {}),
        },
      };
      text = authored(contract.extendedText
        ? { title: SETTLEMENT_TITLE, category: e.content.method, note: e.content.note }
        : { title: SETTLEMENT_TITLE });
      break;
    case 'settlementFlagged':
      payload = { kind: 'settlementFlagged', recordId: e.recordId };
      text = authored({ reason: e.reason });
      break;
    case 'openingBalanceSet':
      payload = { kind: 'openingBalanceSet', recordId: e.recordId, content: { entries: openingToWire(h.currency, e.content.entries) } };
      text = authored({ title: OPENING_TITLE, note: e.content.note });
      break;
    case 'recordVoided':
      payload = { kind: 'recordVoided', recordId: e.recordId };
      text = authored({ reason: e.reason });
      break;
    case 'recordRestored':
      payload = { kind: 'recordRestored', recordId: e.recordId };
      text = authored({});
      break;
  }
  return {
    eventId: e.id,
    potId,
    actorMemberId: e.by,
    occurredAtMillis: BigInt(e.occurredAt!),
    originatingTimeZone: e.tz!,
    schemaVersion: BigInt(schema),
    payload,
    ...text,
  };
}

// ---------- wire -> app event ----------

/** Rebuilds the app's split from exact allocations, recognising equal splits so edits feel natural. */
export function splitFromAllocations(amount: Cents, allocations: { unitId: ID; cents: Cents }[], groups: Group[], people: Person[]): Split {
  const ids = allocations.map((a) => a.unitId);
  const same = (r: Record<ID, Cents>) => allocations.every((a) => r[a.unitId] === a.cents);
  if (ids.length && new Set(ids).size === ids.length && ids.every((id) => groups.some((g) => g.id === id))) {
    try { if (same(allocateEqual(amount, ids.map((id) => ({ id, weight: 1 }))))) return { mode: 'equal', groupIds: ids, weighting: 'group' }; } catch { /* exact below */ }
    try {
      const weights = ids.map((id) => ({ id, weight: groups.find((g) => g.id === id)!.memberIds.filter((m) => people.some((p) => p.id === m)).length }));
      if (weights.some((w) => w.weight > 1) && same(allocateEqual(amount, weights))) return { mode: 'equal', groupIds: ids, weighting: 'person' };
    } catch { /* exact below */ }
  }
  const sharesById: Record<ID, Cents> = {};
  for (const a of allocations) sharesById[a.unitId] = a.cents;
  return { mode: 'exact', shares: sharesById };
}

type Texts = Partial<Record<TextField, string>>;

function texts(listed: ListedEvent): { values: Texts; redacted: Set<TextField> } {
  const values: Texts = {};
  const redacted = new Set<TextField>();
  for (const t of listed.textStates) {
    if (t.state === 'present') values[t.field] = t.value;
    else redacted.add(t.field);
  }
  return { values, redacted };
}

function expenseFromWire(h: Household, w: WireExpense, t: Texts, date: string): ExpenseContent {
  const amount = cents(w.amount);
  const payerGroup = h.groups.find((g) => g.id === w.payerUnitId);
  const payerId = w.payerMemberId ?? payerGroup?.memberIds[0];
  if (!payerId) throw new MappingError('unknown-payer');
  const category = (CATEGORIES as readonly string[]).includes(t.category ?? '') ? (t.category as Category) : 'other';
  let title: string | undefined = t.title;
  if (title === categoryLabel(category)) title = undefined;
  if (title === undefined && t.category && category === 'other' && t.category !== 'other') title = t.category;
  return {
    payerId,
    amount,
    date,
    category,
    ...(title !== undefined ? { title } : {}),
    ...(t.note !== undefined ? { note: t.note } : {}),
    split: splitFromAllocations(amount, w.allocations.map((a) => ({ unitId: a.unitId, cents: cents(a.amount) })), h.groups, h.people),
  };
}

/**
 * The app event for a pulled server event, or null for structural events (people, groups and the
 * name are applied separately) and for anything this app cannot represent.
 */
export function fromWire(h: Household, listed: ListedEvent): LedgerEvent | null {
  const ev = listed.event;
  const occurredAt = Number(ev.occurredAtMillis);
  const base = {
    id: ev.eventId,
    at: listed.recordedAtMillis ?? occurredAt,
    by: ev.actorMemberId,
    seq: Number(listed.serverSequence),
    occurredAt,
    tz: ev.originatingTimeZone,
  };
  const date = localISO(occurredAt);
  const { values: t, redacted } = texts(listed);
  const p = ev.payload;
  switch (p.kind) {
    case 'expenseAdded':
      return { ...base, kind: 'expenseAdded', recordId: p.recordId, content: expenseFromWire(h, p.content, t, date) };
    case 'expenseRevised':
      if (p.content.kind !== 'expense') throw new MappingError('opening-revision-unsupported');
      return {
        ...base, kind: 'expenseRevised', recordId: p.recordId, basis: p.basis,
        content: expenseFromWire(h, p.content, t, date),
        ...(t.reason !== undefined ? { reason: t.reason } : {}),
      };
    case 'settlementRecorded': {
      const method = (METHODS as readonly string[]).includes(t.category ?? '') ? (t.category as PaymentMethod) : undefined;
      const content: SettlementContent = {
        fromGroupId: p.content.fromUnitId,
        toGroupId: p.content.toUnitId,
        amount: cents(p.content.amount),
        date,
        ...(method ? { method } : {}),
        ...(t.note !== undefined ? { note: t.note } : {}),
        ...(p.content.reversalOfRecordId ? { reversalOf: p.content.reversalOfRecordId } : {}),
      };
      return { ...base, kind: 'settlementRecorded', recordId: p.recordId, content };
    }
    case 'settlementFlagged':
      return { ...base, kind: 'settlementFlagged', recordId: p.recordId, ...(t.reason !== undefined ? { reason: t.reason } : {}) };
    case 'openingBalanceSet':
      return {
        ...base, kind: 'openingBalanceSet', recordId: p.recordId,
        content: { entries: openingFromWire(p.content.entries), date, ...(t.note !== undefined ? { note: t.note } : {}) },
      };
    case 'recordVoided':
      return { ...base, kind: 'recordVoided', recordId: p.recordId, reason: t.reason ?? (redacted.has('reason') ? ERASED_TEXT : ERASED_TEXT) };
    case 'recordRestored':
      return { ...base, kind: 'recordRestored', recordId: p.recordId };
    default:
      return null;
  }
}

/** Applies one erased text field to an already-mapped event. */
export function redact(e: LedgerEvent, field: TextField): LedgerEvent {
  switch (e.kind) {
    case 'expenseAdded':
    case 'expenseRevised': {
      const content = { ...e.content };
      if (field === 'title') delete content.title;
      if (field === 'note') delete content.note;
      if (field === 'category') content.category = 'other';
      const next = { ...e, content } as LedgerEvent;
      if (field === 'reason' && next.kind === 'expenseRevised') next.reason = ERASED_TEXT;
      return next;
    }
    case 'settlementRecorded': {
      const content = { ...e.content };
      if (field === 'note') delete content.note;
      if (field === 'category') delete content.method;
      return { ...e, content };
    }
    case 'openingBalanceSet': {
      const content = { ...e.content };
      if (field === 'note') delete content.note;
      return { ...e, content };
    }
    case 'recordVoided':
      return field === 'reason' ? { ...e, reason: ERASED_TEXT } : e;
    case 'settlementFlagged':
      return field === 'reason' ? { ...e, reason: ERASED_TEXT } : e;
    default:
      return e;
  }
}

// ---------- structure: people, groups and the name from structural events ----------

export type Structure = { name?: string; people: Person[]; groups: Group[] };

/** Folds structural events (in sequence order) into people and groups, keeping chosen colors. */
export function applyStructure(prev: Structure, events: ListedEvent[]): Structure {
  let name = prev.name;
  const people = prev.people.map((p) => ({ ...p }));
  let groups = prev.groups.map((g) => ({ ...g, memberIds: [...g.memberIds] }));
  let couples: { groupId: ID; unitId: ID; members: ID[] }[] | null = null;
  for (const { event } of events) {
    const p = event.payload;
    if (p.kind === 'potRenamed') name = p.name;
    else if (p.kind === 'memberAdded') {
      if (!people.some((x) => x.id === p.memberId)) {
        people.push({ id: p.memberId, name: '', groupId: p.unitId, joined: false, unitId: p.unitId });
      }
    } else if (p.kind === 'memberArchived') {
      const person = people.find((x) => x.id === p.memberId);
      if (person) person.archived = true;
    } else if (p.kind === 'groupChanged') {
      couples = p.groups.map((g) => ({ groupId: g.groupId, unitId: g.unitId, members: [...g.orderedMemberIds] }));
    }
  }
  // Recompute groups when membership or couples changed.
  const current = couples ?? groups.filter((g) => g.serverGroupId).map((g) => ({ groupId: g.serverGroupId!, unitId: g.id, members: g.memberIds }));
  const coupled = new Set(current.flatMap((c) => c.members));
  const next: Group[] = [];
  for (const person of people) {
    if (coupled.has(person.id)) {
      const c = current.find((x) => x.members.includes(person.id))!;
      if (!next.some((g) => g.id === c.unitId)) {
        next.push({ id: c.unitId, serverGroupId: c.groupId, memberIds: c.members.filter((m) => people.some((x) => x.id === m)), color: 'citrus' });
      }
      person.groupId = c.unitId;
    } else {
      const unit = person.unitId ?? person.groupId;
      next.push({ id: unit, memberIds: [person.id], color: 'citrus' });
      person.groupId = unit;
    }
  }
  // Keep colors already chosen on this device; give new groups the first unused color.
  const used = new Set<GroupColor>();
  const colored = next.map((g) => {
    const before = groups.find((o) => o.id === g.id)?.color;
    if (before && !used.has(before)) { used.add(before); return { ...g, color: before }; }
    return { ...g, color: undefined as GroupColor | undefined };
  });
  groups = colored.map((g, i) => {
    if (g.color) return g as Group;
    const color = GROUP_COLORS.find((x) => !used.has(x)) ?? GROUP_COLORS[i % GROUP_COLORS.length];
    used.add(color);
    return { ...g, color };
  });
  return { name, people, groups };
}

export type RosterEntry = {
  memberId: ID;
  unitId: ID | null;
  budgetUnitId?: ID | null;
  displayName: string | null;
  role: 'owner' | 'member';
  state: 'pending' | 'active' | 'archived';
};

/** Names and joined state from the roster. Erased names read "Former member". */
export function applyRoster(people: Person[], roster: RosterEntry[]): Person[] {
  return people.map((p) => {
    const r = roster.find((x) => x.memberId === p.id);
    if (!r) return p;
    const name = r.displayName ?? (r.state === 'archived' ? 'Former member' : 'Unknown member');
    return { ...p, name, joined: r.state === 'active', archived: r.state === 'archived' || p.archived };
  });
}

// ---------- people nobody has used ----------

/** Whether any record mentions this person, or the group they pay through alone. */
export function isPersonReferenced(h: Household, personId: ID): boolean {
  const person = h.people.find((p) => p.id === personId);
  const group = person && h.groups.find((g) => g.id === person.groupId);
  const soloGroup = group && group.memberIds.length === 1 ? group.id : undefined;
  return h.events.some((e) => {
    if (e.by === personId) return true;
    if (e.kind === 'expenseAdded' || e.kind === 'expenseRevised') {
      const c = e.content;
      if (c.payerId === personId) return true;
      if (!soloGroup) return false;
      return c.split.mode === 'equal' ? c.split.groupIds.includes(soloGroup) : soloGroup in c.split.shares;
    }
    if (e.kind === 'settlementRecorded') return e.content.fromGroupId === soloGroup || e.content.toGroupId === soloGroup;
    if (e.kind === 'openingBalanceSet') return e.content.entries.some((x) => x.fromGroupId === soloGroup || x.toGroupId === soloGroup);
    return false;
  });
}

/** Removed people that no record mentions disappear from the household (and their own group). */
export function dropUnusedArchived(h: Household): Household {
  const gone = h.people.filter((p) => p.archived && p.id !== h.youId && !isPersonReferenced(h, p.id)).map((p) => p.id);
  if (!gone.length) return h;
  const groups = h.groups
    .map((g) => ({ ...g, memberIds: g.memberIds.filter((m) => !gone.includes(m)) }))
    .filter((g) => g.memberIds.length > 0);
  return { ...h, people: h.people.filter((p) => !gone.includes(p.id)), groups };
}
