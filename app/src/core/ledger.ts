// The ledger reducer: folds a household's append-only events, in array order, into records,
// timelines and zero-sum group balances. Invalid events are rejected with a typed LedgerError;
// nothing is skipped silently.
import { AllocationError, shares } from './allocate';
import { formatMoney, MAX_AMOUNT } from './money';
import { categoryLabel, groupName, personName } from './names';
import type {
  Category, Cents, ExpenseContent, FieldChange, Group, Household, ID, Ledger, LedgerEvent,
  LedgerRecord, OpeningContent, PaymentMethod, Person, RevisionBasis, SettlementContent, Split, TimelineEntry,
} from './types';

export type LedgerErrorCode =
  | 'invalid-household'   // people and group membership disagree, or ids repeat
  | 'unknown-kind'
  | 'duplicate-event'
  | 'duplicate-record'
  | 'unknown-record'
  | 'wrong-record-kind'   // revising a non-expense, flagging a non-settlement
  | 'invalid-time'
  | 'invalid-amount'      // amount <= 0
  | 'non-integer-amount'
  | 'amount-too-large'    // over MAX_AMOUNT
  | 'invalid-date'
  | 'invalid-category'
  | 'invalid-method'
  | 'unknown-person'
  | 'unknown-group'
  | 'invalid-split'
  | 'split-mismatch'      // exact shares do not sum to the amount
  | 'same-group'          // settlement or opening entry from a group to itself
  | 'empty-opening'
  | 'unknown-revision'    // an edit whose parent version isn't known
  | 'invalid-resolution'  // keeping a version of two that aren't in conflict
  | 'already-voided'
  | 'not-voided'          // restore without void
  | 'record-voided'       // revising or flagging a voided record
  | 'already-flagged'
  | 'missing-reason'      // void without a non-blank reason
  | 'invalid-reversal'
  | 'has-reversals'       // voiding a flagged repayment that live corrections point at
  | 'overflow';

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;
  readonly eventId?: ID;
  constructor(code: LedgerErrorCode, message: string, eventId?: ID) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    this.eventId = eventId;
  }
}

const CATEGORIES: readonly Category[] = [
  'groceries', 'household', 'rent', 'bills', 'internet', 'eating-out', 'cleaning', 'other',
];
const METHODS: readonly PaymentMethod[] = ['bizum', 'bank', 'cash', 'other'];

type Ctx = {
  household: Household;
  people: Map<ID, Person>;
  groups: Map<ID, Group>;
  eventId: ID;
};

type Working = {
  record: LedgerRecord;
  /** Effect of the current content, ignoring the voided flag. */
  fullEffect: Record<ID, Cents>;
  /** Revisions nobody has built on yet, oldest first. More than one means the record is contested. */
  heads: ID[];
  /** Each revision's content and effect, by event id. */
  versions: Map<ID, { content: ExpenseContent | OpeningContent; effect: Record<ID, Cents> }>;
  /** Contests already settled ("a|b" sorted), to the event that settled them. */
  resolved: Map<string, ID>;
};

type State = {
  eventIds: Set<ID>;
  records: Map<ID, Working>;
  eventToRecord: Map<ID, ID>;
};

function fail(ctx: Pick<Ctx, 'eventId'>, code: LedgerErrorCode, message: string): never {
  throw new LedgerError(code, message, ctx.eventId);
}

// ---------- household integrity ----------

function context(household: Household): Omit<Ctx, 'eventId'> {
  const people = new Map<ID, Person>();
  const groups = new Map<ID, Group>();
  const bad = (message: string): never => { throw new LedgerError('invalid-household', message); };
  for (const g of household.groups) {
    if (groups.has(g.id)) bad(`Group ${g.id} appears twice.`);
    groups.set(g.id, g);
  }
  for (const p of household.people) {
    if (people.has(p.id)) bad(`Person ${p.id} appears twice.`);
    people.set(p.id, p);
    const g = groups.get(p.groupId);
    if (!g || !g.memberIds.includes(p.id)) bad(`Person ${p.id} is not a member of group ${p.groupId}.`);
  }
  for (const g of household.groups) {
    if (new Set(g.memberIds).size !== g.memberIds.length) bad(`Group ${g.id} lists a member twice.`);
    for (const m of g.memberIds) {
      if (people.get(m)?.groupId !== g.id) bad(`Group ${g.id} lists ${m}, who belongs elsewhere.`);
    }
  }
  return { household, people, groups };
}

// ---------- content validation ----------

function checkAmount(ctx: Ctx, amount: unknown): void {
  if (typeof amount !== 'number' || !Number.isInteger(amount)) fail(ctx, 'non-integer-amount', `Amount must be integer cents, got ${String(amount)}.`);
  if (amount <= 0) fail(ctx, 'invalid-amount', 'Amount must be more than zero.');
  if (amount > MAX_AMOUNT) fail(ctx, 'amount-too-large', 'Amount is over the limit.');
}

function checkDate(ctx: Ctx, date: unknown): void {
  const m = typeof date === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) : null;
  const ok = m !== null && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31;
  if (!ok) fail(ctx, 'invalid-date', `Date must be YYYY-MM-DD, got ${String(date)}.`);
}

function checkPerson(ctx: Ctx, id: ID): Person {
  const p = ctx.people.get(id);
  if (!p) fail(ctx, 'unknown-person', `Unknown person ${id}.`);
  return p;
}

function checkGroup(ctx: Ctx, id: ID): Group {
  const g = ctx.groups.get(id);
  if (!g) fail(ctx, 'unknown-group', `Unknown group ${id}.`);
  return g;
}

function addTo(ctx: Pick<Ctx, 'eventId'>, effect: Record<ID, Cents>, id: ID, delta: Cents): void {
  const next = (effect[id] ?? 0) + delta;
  if (!Number.isSafeInteger(next)) fail(ctx, 'overflow', 'Balance is out of range.');
  effect[id] = next;
}

/** Validates an expense and returns its effect: payer's group +amount, each group −its share. */
function expenseEffect(ctx: Ctx, content: ExpenseContent): Record<ID, Cents> {
  checkAmount(ctx, content.amount);
  checkDate(ctx, content.date);
  if (!CATEGORIES.includes(content.category)) fail(ctx, 'invalid-category', `Unknown category ${String(content.category)}.`);
  const payer = checkPerson(ctx, content.payerId);
  const split = content.split;
  if (!split || (split.mode !== 'equal' && split.mode !== 'exact')) fail(ctx, 'invalid-split', 'Unknown split.');
  if (split.mode === 'equal' && split.weighting !== 'group' && split.weighting !== 'person') {
    fail(ctx, 'invalid-split', 'Unknown split weighting.');
  }
  let parts: Record<ID, Cents>;
  try {
    parts = shares(content, ctx.household.groups, ctx.household.people);
  } catch (e) {
    if (!(e instanceof AllocationError)) throw e;
    if (e.code === 'unknown-group') fail(ctx, 'unknown-group', e.message);
    if (e.code === 'exact-sum-mismatch') fail(ctx, 'split-mismatch', e.message);
    fail(ctx, 'invalid-split', e.message);
  }
  const effect: Record<ID, Cents> = {};
  addTo(ctx, effect, payer.groupId, content.amount);
  for (const [groupId, share] of Object.entries(parts)) addTo(ctx, effect, groupId, -share);
  return effect;
}

/** Settlement from A to B: A paid B back, so A +amount and B −amount. */
function settlementEffect(ctx: Ctx, state: State, content: SettlementContent, selfId: ID): Record<ID, Cents> {
  checkAmount(ctx, content.amount);
  checkDate(ctx, content.date);
  checkGroup(ctx, content.fromGroupId);
  checkGroup(ctx, content.toGroupId);
  if (content.fromGroupId === content.toGroupId) fail(ctx, 'same-group', 'A repayment needs two different groups.');
  if (content.method !== undefined && !METHODS.includes(content.method)) fail(ctx, 'invalid-method', `Unknown method ${String(content.method)}.`);
  if (content.reversalOf !== undefined) checkReversal(ctx, state, content, selfId);
  return { [content.fromGroupId]: content.amount, [content.toGroupId]: -content.amount };
}

/**
 * A correction of a flagged repayment: opposite direction, linked, and the live corrections of
 * one repayment never add up to more than it.
 */
function checkReversal(ctx: Ctx, state: State, content: SettlementContent, selfId: ID): void {
  const target = state.records.get(content.reversalOf!)?.record;
  const bad = (why: string): never => fail(ctx, 'invalid-reversal', why);
  if (!target || target.kind !== 'settlement' || !target.settlement) return bad('Corrects an unknown repayment.');
  if (!target.flagged) bad('Only a flagged repayment can be corrected.');
  if (target.voided) bad('The corrected repayment is voided.');
  const original = target.settlement;
  if (content.fromGroupId !== original.toGroupId || content.toGroupId !== original.fromGroupId) {
    bad('A correction goes in the opposite direction.');
  }
  let corrected = content.amount;
  for (const { record } of state.records.values()) {
    if (record.id !== selfId && !record.voided && record.settlement?.reversalOf === target.id) {
      corrected += record.settlement.amount;
    }
  }
  if (corrected > original.amount) bad('Corrections exceed the original repayment.');
}

function openingEffect(ctx: Ctx, content: OpeningContent): Record<ID, Cents> {
  checkDate(ctx, content.date);
  if (!Array.isArray(content.entries) || content.entries.length === 0) fail(ctx, 'empty-opening', 'An opening balance needs at least one entry.');
  const effect: Record<ID, Cents> = {};
  for (const e of content.entries) {
    checkGroup(ctx, e.fromGroupId);
    checkGroup(ctx, e.toGroupId);
    if (e.fromGroupId === e.toGroupId) fail(ctx, 'same-group', 'An opening entry needs two different groups.');
    checkAmount(ctx, e.amount);
    addTo(ctx, effect, e.fromGroupId, -e.amount);
    addTo(ctx, effect, e.toGroupId, e.amount);
  }
  return effect;
}

// ---------- revision diff ----------

function describeSplit(split: Split, ctx: Ctx): string {
  const { household } = ctx;
  const name = (id: ID) => {
    const g = ctx.groups.get(id);
    return g ? groupName(g, household.people, household.youId) : id;
  };
  if (split.mode === 'equal') {
    return `Equal${split.weighting === 'person' ? ' per person' : ''}: ${split.groupIds.map(name).join(', ')}`;
  }
  return Object.entries(split.shares)
    .map(([id, c]) => `${name(id)} ${formatMoney(c, household.currency)}`)
    .join(', ');
}

function splitKey(split: Split): string {
  return split.mode === 'equal'
    ? JSON.stringify(['equal', split.weighting, split.groupIds])
    : JSON.stringify(['exact', Object.entries(split.shares).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))]);
}

function diff(ctx: Ctx, from: ExpenseContent, to: ExpenseContent): FieldChange[] {
  const { household } = ctx;
  const changes: FieldChange[] = [];
  const push = (field: FieldChange['field'], a: string, b: string) => { if (a !== b) changes.push({ field, from: a, to: b }); };
  push('amount', formatMoney(from.amount, household.currency), formatMoney(to.amount, household.currency));
  push('payer', personName(from.payerId, household.people, household.youId), personName(to.payerId, household.people, household.youId));
  push('category', categoryLabel(from.category), categoryLabel(to.category));
  push('title', from.title ?? '', to.title ?? '');
  push('note', from.note ?? '', to.note ?? '');
  push('date', from.date, to.date);
  if (splitKey(from.split) !== splitKey(to.split)) push('split', describeSplit(from.split, ctx), describeSplit(to.split, ctx));
  return changes;
}

// ---------- fold ----------

function apply(base: Omit<Ctx, 'eventId'>, state: State, event: LedgerEvent): void {
  const ctx: Ctx = { ...base, eventId: event.id };
  if (state.eventIds.has(event.id)) fail(ctx, 'duplicate-event', `Event ${event.id} is already recorded.`);
  if (typeof event.at !== 'number' || !Number.isFinite(event.at)) fail(ctx, 'invalid-time', 'Event time is missing.');
  checkPerson(ctx, event.by);

  const existing = (): Working => {
    const w = state.records.get(event.recordId);
    if (!w) fail(ctx, 'unknown-record', `Unknown record ${event.recordId}.`);
    return w;
  };
  const create = (kind: LedgerRecord['kind'], content: ExpenseContent | SettlementContent | OpeningContent, fullEffect: Record<ID, Cents>) => {
    const record: LedgerRecord = {
      id: event.recordId, kind, createdAt: event.at, createdBy: event.by, updatedAt: event.at,
      revisions: [{ eventId: event.id, at: event.at, by: event.by, content }],
      voided: false, flagged: false, effect: {},
      timeline: [{ type: 'added', at: event.at, by: event.by, eventId: event.id }],
    };
    if (kind === 'expense') record.expense = content as ExpenseContent;
    if (kind === 'settlement') record.settlement = content as SettlementContent;
    if (kind === 'opening') record.opening = content as OpeningContent;
    state.records.set(record.id, {
      record, fullEffect, heads: [event.id], resolved: new Map(),
      versions: new Map(kind === 'settlement' ? [] : [[event.id, { content: content as ExpenseContent | OpeningContent, effect: fullEffect }]]),
    });
  };
  /**
   * A new revision, placed the way the server places it: on its parent, or settling a contest
   * between two versions. The newest standing version counts.
   */
  const revise = (w: Working, content: ExpenseContent | OpeningContent, effect: Record<ID, Cents>, basis: RevisionBasis | undefined) => {
    const b: RevisionBasis = basis ?? { kind: 'parent', parentEventId: w.heads[w.heads.length - 1] };
    if (b.kind === 'parent') {
      if (!w.versions.has(b.parentEventId)) fail(ctx, 'unknown-revision', 'This edit builds on a version that doesn’t exist.');
      w.heads = w.heads.filter((x) => x !== b.parentEventId);
      for (const [pair, by] of w.resolved) if (by === b.parentEventId) w.resolved.set(pair, event.id);
    } else {
      const { firstEventId: one, secondEventId: two } = b;
      if (!w.versions.has(one) || !w.versions.has(two)) fail(ctx, 'invalid-resolution', 'This choice names a version that doesn’t exist.');
      const pair = [one, two].sort().join('|');
      if (w.heads.includes(one) && w.heads.includes(two)) {
        w.heads = w.heads.filter((x) => x !== one && x !== two);
      } else {
        const prior = w.resolved.get(pair);
        if (!prior) fail(ctx, 'invalid-resolution', 'These two versions aren’t in conflict.');
        w.heads = w.heads.filter((x) => x !== prior);
      }
      w.resolved.set(pair, event.id);
    }
    w.heads.push(event.id);
    w.versions.set(event.id, { content, effect });
    const applied = w.versions.get(w.heads[w.heads.length - 1])!;
    w.fullEffect = applied.effect;
    if (w.heads.length > 1) w.record.contested = [...w.heads];
    else delete w.record.contested;
    return applied.content;
  };
  const touch = (r: LedgerRecord) => { r.updatedAt = Math.max(r.updatedAt, event.at); };

  switch (event.kind) {
    case 'expenseAdded':
    case 'settlementRecorded':
    case 'openingBalanceSet': {
      if (state.records.has(event.recordId)) fail(ctx, 'duplicate-record', `Record ${event.recordId} already exists.`);
      if (event.kind === 'expenseAdded') create('expense', event.content, expenseEffect(ctx, event.content));
      else if (event.kind === 'settlementRecorded') create('settlement', event.content, settlementEffect(ctx, state, event.content, event.recordId));
      else create('opening', event.content, openingEffect(ctx, event.content));
      break;
    }
    case 'expenseRevised': {
      const w = existing();
      const r = w.record;
      if (r.kind !== 'expense' || !r.expense) fail(ctx, 'wrong-record-kind', 'Only expenses can be edited.');
      if (r.voided) fail(ctx, 'record-voided', 'Restore this expense before editing it.');
      const effect = expenseEffect(ctx, event.content);
      const parent = event.basis?.kind === 'parent' ? w.versions.get(event.basis.parentEventId)?.content as ExpenseContent | undefined : undefined;
      r.timeline.push({ type: 'edited', at: event.at, by: event.by, eventId: event.id, reason: event.reason, changes: diff(ctx, parent ?? r.expense, event.content) });
      r.revisions.push({ eventId: event.id, at: event.at, by: event.by, content: event.content });
      r.expense = revise(w, event.content, effect, event.basis) as ExpenseContent;
      touch(r);
      break;
    }
    case 'openingRevised': {
      const w = existing();
      const r = w.record;
      if (r.kind !== 'opening' || !r.opening) fail(ctx, 'wrong-record-kind', 'Only an opening balance can take this change.');
      if (r.voided) fail(ctx, 'record-voided', 'Restore this opening balance before changing it.');
      const effect = openingEffect(ctx, event.content);
      r.timeline.push({ type: 'edited', at: event.at, by: event.by, eventId: event.id, changes: [] });
      r.revisions.push({ eventId: event.id, at: event.at, by: event.by, content: event.content });
      r.opening = revise(w, event.content, effect, event.basis) as OpeningContent;
      touch(r);
      break;
    }
    case 'settlementFlagged': {
      const r = existing().record;
      if (r.kind !== 'settlement') fail(ctx, 'wrong-record-kind', 'Only repayments can be flagged.');
      if (r.voided) fail(ctx, 'record-voided', 'This repayment is voided.');
      if (r.flagged) fail(ctx, 'already-flagged', 'This repayment is already flagged.');
      r.flagged = true;
      r.timeline.push({ type: 'flagged', at: event.at, by: event.by, eventId: event.id, reason: event.reason });
      touch(r);
      break;
    }
    case 'recordVoided': {
      const r = existing().record;
      if (r.voided) fail(ctx, 'already-voided', 'This record is already voided.');
      if (typeof event.reason !== 'string' || event.reason.trim() === '') fail(ctx, 'missing-reason', 'Say why this is voided.');
      for (const { record } of state.records.values()) {
        if (!record.voided && record.settlement?.reversalOf === r.id) {
          fail(ctx, 'has-reversals', 'Void its corrections before voiding this repayment.');
        }
      }
      r.voided = true;
      r.voidReason = event.reason.trim();
      r.timeline.push({ type: 'voided', at: event.at, by: event.by, eventId: event.id, reason: r.voidReason });
      touch(r);
      break;
    }
    case 'recordRestored': {
      const r = existing().record;
      if (!r.voided) fail(ctx, 'not-voided', 'Only a voided record can be restored.');
      if (r.settlement?.reversalOf !== undefined) checkReversal(ctx, state, r.settlement, r.id);
      r.voided = false;
      delete r.voidReason;
      r.timeline.push({ type: 'restored', at: event.at, by: event.by, eventId: event.id });
      touch(r);
      break;
    }
    default:
      fail(ctx, 'unknown-kind', `Unknown event kind ${String((event as { kind?: unknown }).kind)}.`);
  }
  state.eventIds.add(event.id);
  state.eventToRecord.set(event.id, event.recordId);
}

/** Folds every event in array order. Throws LedgerError on the first invalid event. */
export function reduce(household: Household): Ledger {
  const base = context(household);
  const state: State = { eventIds: new Set(), records: new Map(), eventToRecord: new Map() };
  for (const event of household.events) apply(base, state, event);

  for (const [eventId, viewers] of Object.entries(household.seen ?? {})) {
    const recordId = state.eventToRecord.get(eventId);
    const w = recordId === undefined ? undefined : state.records.get(recordId);
    if (!w) continue;
    for (const [personId, at] of Object.entries(viewers)) {
      w.record.timeline.push({ type: 'seen', at, personId, eventId });
    }
  }

  const records = [...state.records.values()]
    .map(({ record, fullEffect }) => {
      record.effect = record.voided ? {} : { ...fullEffect };
      record.timeline = record.timeline
        .map((entry, index) => ({ entry, index }))
        .sort((a, b) => a.entry.at - b.entry.at || a.index - b.index)
        .map(({ entry }) => entry);
      return record;
    })
    .map((record, index) => ({ record, index }))
    .sort((a, b) => a.record.createdAt - b.record.createdAt || a.index - b.index)
    .map(({ record }) => record);

  const balances: Record<ID, Cents> = {};
  for (const g of household.groups) balances[g.id] = 0;
  for (const record of records) {
    for (const [groupId, delta] of Object.entries(record.effect)) {
      addTo({ eventId: record.id }, balances, groupId, delta);
    }
  }

  const byId: Record<ID, LedgerRecord> = {};
  for (const r of records) byId[r.id] = r;
  return { records, byId, balances };
}

/**
 * Checks that `event` can be appended to `household`. Throws the same LedgerError that reduce
 * would throw after appending it; returns nothing when the event is valid.
 */
export function validateEvent(household: Household, event: LedgerEvent): void {
  reduce({ ...household, events: [...household.events, event] });
}

/** Non-throwing variant of validateEvent, for forms that show the reason inline. */
export function checkEvent(household: Household, event: LedgerEvent): LedgerError | null {
  try {
    validateEvent(household, event);
    return null;
  } catch (e) {
    if (e instanceof LedgerError) return e;
    throw e;
  }
}

/**
 * The effect a record's current content would have, ignoring whether it is voided. Explain uses
 * it to show voided records to the groups they involved.
 */
export function contentEffect(household: Household, record: LedgerRecord): Record<ID, Cents> {
  const base = context(household);
  const ctx: Ctx = { ...base, eventId: record.id };
  if (record.expense) return expenseEffect(ctx, record.expense);
  if (record.opening) return openingEffect(ctx, record.opening);
  if (record.settlement) {
    const s = record.settlement;
    return { [s.fromGroupId]: s.amount, [s.toGroupId]: -s.amount };
  }
  return {};
}
