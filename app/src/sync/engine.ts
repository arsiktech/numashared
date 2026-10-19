// The sync engine. Pure async functions over a `Backend` (the Convex client, or convex-test in
// tests) and an `Access` to the household store. The server is the record: it validates and
// sequences every event; this device keeps its own events queued until the server accepts them.
//
// Order of work for one household: promote it if it only exists here, pull everything new,
// then send queued events one at a time (after their undo window) in the order they were made.
import { LedgerError, reduce } from '../core/ledger';
import { currencyDigits } from '../core/money';
import { UNDO_WINDOW_MS } from '../core/undo';
import type { Group, Household, ID, InviteInfo, LedgerEvent, Person, SyncMeta } from '../core/types';
import { maxGroupSize } from './contract';
import {
  applyRoster, applyStructure, dropUnusedArchived, fromWire, isPersonReferenced, MappingError, redact, STRUCTURAL_KINDS, stamp, toWire,
  type RosterEntry,
} from './mapping';
import { TERMINAL_EVENT_CODES } from './terminal';
import { wireTimeZone } from './timezones';
import { isUuidv7, uuidv7 } from './uuid';
import type { ListedEvent, TextField, WireEvent, WireSettlementGroup } from './wire';

export interface Backend {
  query<T = unknown>(name: string, args: Record<string, unknown>): Promise<T>;
  mutation<T = unknown>(name: string, args: Record<string, unknown>): Promise<T>;
}

export interface Access {
  get(id: ID): Household | undefined;
  /** Replaces the household with the same id, or adds it. */
  put(h: Household): void;
  remove(id: ID): void;
  all(): Household[];
}

export type Failure = { code: string; retryable: boolean };

const CODE = /^[A-Z0-9_]{1,64}$/;

/** The server's `{ code, retryable }` from any thrown error. Network trouble is retryable. */
export function failureOf(error: unknown): Failure {
  const seen = new Set<unknown>();
  const scan = (v: unknown): Failure | null => {
    if (!v || typeof v !== 'object' || seen.has(v)) return null;
    seen.add(v);
    const o = v as Record<string, unknown>;
    if (typeof o.code === 'string' && CODE.test(o.code) && typeof o.retryable === 'boolean') {
      return { code: o.code, retryable: o.retryable };
    }
    for (const k of ['data', 'error', 'cause']) {
      const found = scan(o[k]);
      if (found) return found;
    }
    return null;
  };
  const found = scan(error);
  if (found) return found;
  if (error instanceof MappingError) return { code: `CLIENT_${error.code.toUpperCase().replace(/-/g, '_')}`, retryable: false };
  const data = (error as { data?: unknown } | null)?.data;
  if (typeof data === 'string' && CODE.test(data)) return { code: data, retryable: false };
  return { code: 'TRANSPORT_UNAVAILABLE', retryable: true };
}

export class SyncError extends Error {
  constructor(readonly failure: Failure) { super(failure.code); this.name = 'SyncError'; }
}

/** Waiting this long after saving keeps Undo purely local. */
export const SEND_DELAY_MS = UNDO_WINDOW_MS;
const DAY = 24 * 60 * 60 * 1000;

// ---------- preparing a local household for the server ----------

export class PrepareError extends Error {
  constructor(readonly code: 'group-too-large' | 'too-many-people') { super(code); this.name = 'PrepareError'; }
}

/**
 * Gives a local household server-ready identities: UUIDv7 ids everywhere, a personal unit per
 * person, one-person groups keyed by that unit, and server ids for two-person groups. Returns the
 * household unchanged when it already has them. References inside events are rewritten too.
 */
export function prepareForSync(h: Household, now = Date.now()): Household {
  if (h.groups.some((g) => g.memberIds.length > maxGroupSize())) throw new PrepareError('group-too-large');
  if (h.people.length > 64) throw new PrepareError('too-many-people');
  const map = new Map<string, string>();
  const id = (old: string) => {
    if (isUuidv7(old)) return old;
    let next = map.get(old);
    if (!next) { next = uuidv7(now); map.set(old, next); }
    return next;
  };
  const people: Person[] = h.people.map((p) => ({ ...p, id: id(p.id), unitId: p.unitId ?? undefined }));
  const groups: Group[] = h.groups.map((g) => {
    const memberIds = g.memberIds.map(id);
    if (memberIds.length === 1) {
      const person = people.find((p) => p.id === memberIds[0])!;
      const unit = person.unitId ?? id(g.id);
      person.unitId = unit;
      map.set(g.id, unit);
      return { id: unit, color: g.color, memberIds };
    }
    return { id: id(g.id), color: g.color, memberIds, serverGroupId: g.serverGroupId ?? uuidv7(now) };
  });
  for (const p of people) {
    p.groupId = map.get(p.groupId) ?? id(p.groupId);
    if (!p.unitId) p.unitId = uuidv7(now);
  }
  const g = (x: string) => map.get(x) ?? id(x);
  const events = h.events.map((e) => remapEvent(stamp(e), id, g));
  const seen: Household['seen'] = {};
  for (const [eid, by] of Object.entries(h.seen)) {
    seen[id(eid)] = Object.fromEntries(Object.entries(by).map(([pid, at]) => [id(pid), at]));
  }
  return { ...h, id: id(h.id), youId: id(h.youId), people, groups, events, seen };
}

function remapEvent(e: LedgerEvent, id: (s: string) => string, g: (s: string) => string): LedgerEvent {
  const base = { ...e, id: id(e.id), by: id(e.by), recordId: id(e.recordId) };
  switch (e.kind) {
    case 'expenseAdded':
    case 'expenseRevised': {
      const c = e.content;
      const split = c.split.mode === 'equal'
        ? { ...c.split, groupIds: c.split.groupIds.map(g) }
        : { mode: 'exact' as const, shares: Object.fromEntries(Object.entries(c.split.shares).map(([k, v]) => [g(k), v])) };
      const next = { ...base, content: { ...c, payerId: id(c.payerId), split } } as LedgerEvent;
      if (next.kind === 'expenseRevised' && next.basis?.kind === 'parent') next.basis = { kind: 'parent', parentEventId: id(next.basis.parentEventId) };
      return next;
    }
    case 'settlementRecorded':
      return { ...base, kind: 'settlementRecorded', content: { ...e.content, fromGroupId: g(e.content.fromGroupId), toGroupId: g(e.content.toGroupId), ...(e.content.reversalOf ? { reversalOf: id(e.content.reversalOf) } : {}) } };
    case 'openingBalanceSet':
      return { ...base, kind: 'openingBalanceSet', content: { ...e.content, entries: e.content.entries.map((x) => ({ ...x, fromGroupId: g(x.fromGroupId), toGroupId: g(x.toGroupId) })) } };
    case 'openingRevised':
      return {
        ...base, kind: 'openingRevised',
        ...(e.basis?.kind === 'parent' ? { basis: { kind: 'parent', parentEventId: id(e.basis.parentEventId) } } : {}),
        content: { ...e.content, entries: e.content.entries.map((x) => ({ ...x, fromGroupId: g(x.fromGroupId), toGroupId: g(x.toGroupId) })) },
      };
    default:
      return base as LedgerEvent;
  }
}

// ---------- promotion ----------

type Setup = NonNullable<SyncMeta['setup']>;

function structuralEnvelope(h: Household, setup: Setup, eventId: ID, schema: 1 | 2, payload: WireEvent['payload']): WireEvent {
  return {
    eventId, potId: h.id, actorMemberId: h.youId,
    occurredAtMillis: BigInt(setup.at), originatingTimeZone: setup.tz, schemaVersion: BigInt(schema),
    payload, textFields: [], authoredText: [],
  };
}

function couples(h: Household): WireSettlementGroup[] {
  return h.groups.filter((g) => g.memberIds.length > 1).map((g) => ({
    groupId: g.serverGroupId!, unitId: g.id, orderedMemberIds: [...g.memberIds], defaultShareWeight: 1n,
  }));
}

/** Everyone, you first: the order of personal units on the server. */
const peopleOrder = (h: Household) => [h.people.find((p) => p.id === h.youId)!, ...h.people.filter((p) => p.id !== h.youId)];

/**
 * Readies a household that so far lives only on this device: fixes identities and the setup
 * stamps (so a retried upload is byte-identical) and stores it. Returns its (possibly new) id.
 */
export function stageSync(access: Access, householdId: ID, now = Date.now()): ID {
  const local = access.get(householdId);
  if (!local) throw new Error('Household not found.');
  if (local.sync) return local.id;
  const h = prepareForSync(local, now);
  const ready = h.events.filter((e) => now - e.at >= SEND_DELAY_MS).slice(0, Math.max(0, 97 - h.people.length));
  const setup: Setup = {
    at: now,
    tz: wireTimeZone(),
    renameEventId: uuidv7(now),
    memberEventIds: Object.fromEntries(h.people.map((p) => [p.id, uuidv7(now)])),
    groupEventId: uuidv7(now),
    financialEventIds: ready.map((e) => e.id),
  };
  // The id may have changed: drop the old copy so the household is not listed twice.
  if (h.id !== local.id) access.remove(local.id);
  access.put({ ...h, sync: { role: 'owner', schema: 2, lastSeq: 0, lastTextRev: 0, setup } });
  return h.id;
}

/** Stages and promotes a local household; you become its owner. */
export async function startSync(backend: Backend, access: Access, householdId: ID, now = Date.now()): Promise<ID> {
  const id = stageSync(access, householdId, now);
  await promote(backend, access, id);
  return id;
}

export async function promote(backend: Backend, access: Access, householdId: ID): Promise<void> {
  const h = access.get(householdId);
  const setup = h?.sync?.setup;
  if (!h || !setup) return;
  const order = peopleOrder(h);
  const you = order[0];
  const events: WireEvent[] = [
    structuralEnvelope(h, setup, setup.renameEventId, 1, { kind: 'potRenamed', name: h.name }),
    ...order.map((p) => structuralEnvelope(h, setup, setup.memberEventIds[p.id], 1, {
      kind: 'memberAdded', memberId: p.id, unitId: p.unitId!, role: p.id === h.youId ? 'owner' : 'member',
    })),
    structuralEnvelope(h, setup, setup.groupEventId, 2, { kind: 'groupChanged', groups: couples(h) }),
    ...setup.financialEventIds.map((eid) => toWire(h, h.id, 2, h.events.find((e) => e.id === eid)!)),
  ];
  let result: { events: { eventId: string; sequence: bigint }[] };
  try {
    result = await backend.mutation('pots:promoteLocalPot', {
      configuration: {
        potId: h.id,
        currency: { code: h.currency, exponent: BigInt(currencyDigits(h.currency)) },
        orderedUnitIds: order.map((p) => p.unitId!),
        ownerMemberId: you.id,
        minimumReaderSchemaVersion: 1n,
      },
      ownerDisplayName: displayName(you.name),
      events,
      legacyMigrationEventIds: [],
      budgetGroupPromotion: {
        ownerBindingEventId: setup.memberEventIds[you.id],
        startingSequence: 1n,
        members: order.map((p) => ({ memberId: p.id, displayName: displayName(p.name) })),
      },
    });
  } catch (error) {
    const f = failureOf(error);
    if (!f.retryable) pause(access, householdId, f.code);
    throw new SyncError(f);
  }
  const seqById = new Map(result.events.map((x) => [x.eventId, Number(x.sequence)]));
  const latest = access.get(householdId)!;
  access.put({
    ...latest,
    events: ordered(latest.events.map((e) => (seqById.has(e.id) ? { ...e, seq: seqById.get(e.id) } : e))),
    sync: { ...latest.sync!, setup: undefined, paused: undefined },
  });
}

const displayName = (name: string) => (name.trim() ? name.trim().slice(0, 128) : 'Someone');

// ---------- ordering and local consistency ----------

/** Server-accepted events by sequence, then this device's queued events in the order made. */
function ordered(events: LedgerEvent[]): LedgerEvent[] {
  const confirmed = events.filter((e) => e.seq !== undefined).sort((a, b) => a.seq! - b.seq!);
  return [...confirmed, ...events.filter((e) => e.seq === undefined)];
}

/**
 * Drops events the local ledger cannot apply, so a surprise from the server never breaks the
 * app: a server event this app can't show is counted as unreadable; a queued local event that
 * conflicts with what arrived is set aside as rejected.
 */
export function settle(h: Household, now = Date.now()): Household {
  let cur = h;
  for (let i = 0; i < 500; i++) {
    try {
      reduce(cur);
      return cur;
    } catch (e) {
      if (!(e instanceof LedgerError) || !e.eventId) {
        if (cur.events.length === 0) return cur;
        // A household-level problem: keep only server events and stop guessing.
        return { ...cur, events: cur.events.filter((x) => x.seq !== undefined).slice(0, -1) };
      }
      const bad = cur.events.find((x) => x.id === e.eventId);
      if (!bad) return cur;
      const meta = cur.sync;
      cur = {
        ...cur,
        events: cur.events.filter((x) => x.id !== bad.id),
        sync: meta && (bad.seq !== undefined
          ? { ...meta, unreadable: (meta.unreadable ?? 0) + 1 }
          : { ...meta, rejected: [...(meta.rejected ?? []), { eventId: bad.id, code: `LOCAL_${e.code.toUpperCase().replace(/-/g, '_')}`, label: labelOf(bad), at: now }] }),
      };
    }
  }
  return cur;
}

export function labelOf(e: LedgerEvent): string {
  switch (e.kind) {
    case 'expenseAdded': return e.content.title ?? 'An expense';
    case 'expenseRevised': return 'An edit';
    case 'settlementRecorded': return 'A repayment';
    case 'settlementFlagged': return 'A flag';
    case 'openingBalanceSet': return 'An opening balance';
    case 'openingRevised': return 'An opening balance change';
    case 'recordVoided': return 'A void';
    case 'recordRestored': return 'A restore';
  }
}

function pause(access: Access, id: ID, code: string) {
  const h = access.get(id);
  if (!h?.sync) return;
  access.put({ ...h, sync: { ...h.sync, paused: { code, at: Date.now() } } });
}

export function resume(access: Access, id: ID) {
  const h = access.get(id);
  if (!h?.sync?.paused) return;
  access.put({ ...h, sync: { ...h.sync, paused: undefined } });
}

// ---------- sending ----------

const inFlight = new Set<ID>();
export const isSending = (eventId: ID) => inFlight.has(eventId);

/**
 * Sends queued events one at a time, oldest first, once their undo window has closed. Stops at
 * the first event still inside its window so the server sees events in the order they were made.
 * Returns when the queue is empty, waiting, or blocked.
 */
export async function flush(backend: Backend, access: Access, householdId: ID, now = () => Date.now()): Promise<'done' | 'waiting' | 'retry' | 'paused'> {
  for (;;) {
    const h = access.get(householdId);
    if (!h?.sync || h.sync.setup) return 'waiting';
    if (h.sync.paused) return 'paused';
    const next = h.events.find((e) => e.seq === undefined);
    if (!next) return 'done';
    if (now() - next.at < SEND_DELAY_MS) return 'waiting';
    const stamped = stamp(next);
    if (stamped !== next) access.put({ ...h, events: h.events.map((e) => (e.id === next.id ? stamped : e)) });
    inFlight.add(next.id);
    try {
      const wire = toWire(access.get(householdId)!, h.id, h.sync.schema, stamped);
      const res = await backend.mutation<{ events: { eventId: string; sequence: bigint }[] }>('events:appendEvents', { potId: h.id, events: [wire] });
      const seq = Number(res.events[0].sequence);
      const latest = access.get(householdId)!;
      access.put({ ...latest, events: ordered(latest.events.map((e) => (e.id === next.id ? { ...e, seq } : e))) });
    } catch (error) {
      const f = failureOf(error);
      if (f.retryable) return 'retry';
      const latest = access.get(householdId)!;
      if (TERMINAL_EVENT_CODES.has(f.code) || f.code.startsWith('CLIENT_')) {
        // This event can never be accepted: set it aside, and anything that depended on it.
        access.put(settle({
          ...latest,
          events: latest.events.filter((e) => e.id !== next.id),
          sync: { ...latest.sync!, rejected: [...(latest.sync!.rejected ?? []), { eventId: next.id, code: f.code, label: labelOf(next), at: now() }] },
        }));
        continue;
      }
      pause(access, householdId, f.code);
      return 'paused';
    } finally {
      inFlight.delete(next.id);
    }
  }
}

// ---------- pulling ----------

type EventsPage = { events: ListedEvent[]; hasMore: boolean; nextAfterSequence: bigint };
type TextPage = { changes: { eventId: string; field: TextField; revision: bigint }[]; skippedRevisions: bigint[]; hasMore: boolean; nextAfterRevision: bigint };

/** Pulls new server events, names and erased text into the household. */
export async function pull(backend: Backend, access: Access, householdId: ID, opts: { archived?: boolean } = {}): Promise<void> {
  const start = access.get(householdId);
  if (!start?.sync || start.sync.setup) return;
  const listed: ListedEvent[] = [];
  let after = BigInt(start.sync.lastSeq);
  for (;;) {
    const page = await backend.query<EventsPage>('events:listEvents', { potId: householdId, afterSequence: after });
    listed.push(...page.events);
    if (page.events.length === 0 || page.nextAfterSequence <= after) break;
    after = page.nextAfterSequence;
    if (!page.hasMore) break;
  }
  const roster = opts.archived ? null : await backend.query<RosterEntry[]>('members:listRoster', { potId: householdId });

  const h0 = access.get(householdId)!;
  const shape = (events: ListedEvent[]): Household => {
    const structure = applyStructure({ name: h0.name, people: h0.people, groups: h0.groups }, events);
    const people = roster ? applyRoster(structure.people, roster) : structure.people;
    return { ...h0, name: structure.name || h0.name, people, groups: structure.groups };
  };
  const role = roster?.find((r) => r.memberId === h0.youId)?.role ?? h0.sync!.role;

  // A money event this app can't read stops the pull right before it: skipping it would leave
  // balances wrong while the app says it is up to date. The cursor stays there and sync pauses
  // until an app that can read it catches up.
  let shaped = shape(listed);
  const incoming: LedgerEvent[] = [];
  let stuck: string | null = null;
  for (let i = 0; i < listed.length; i++) {
    const l = listed[i];
    let e: LedgerEvent | null = null;
    try {
      e = fromWire(shaped, l);
      if (!e && !STRUCTURAL_KINDS.has(l.event.payload.kind)) throw new MappingError(`unsupported-${l.event.payload.kind}`);
    } catch {
      stuck = 'UNREADABLE_EVENT';
      after = i === 0 ? BigInt(start.sync.lastSeq) : BigInt(listed[i - 1].serverSequence);
      listed.length = i;
      shaped = shape(listed);
      break;
    }
    if (e) incoming.push(e);
  }
  const unreadable = shaped.sync!.unreadable ?? 0;
  const byId = new Map(shaped.events.map((e) => [e.id, e]));
  for (const e of incoming) {
    const mine = byId.get(e.id);
    // Our own queued event came back: keep its content, take the server's sequence and time.
    byId.set(e.id, mine && mine.seq === undefined ? { ...mine, seq: e.seq, at: e.at } : mine ?? e);
  }
  let next: Household = settle({
    ...shaped,
    events: ordered([...byId.values()]),
    sync: {
      ...shaped.sync!, role, lastSeq: Number(after), unreadable,
      ...(stuck ? { paused: { code: stuck, at: Date.now() } } : shaped.sync!.paused?.code === 'UNREADABLE_EVENT' ? { paused: undefined } : {}),
    },
  });

  // Erased text (account deletion) arrives as redactions of events already pulled above.
  let rev = BigInt(next.sync!.lastTextRev);
  for (;;) {
    const page = await backend.query<TextPage>('events:listTextChangesWithSkippedRevisions', { potId: householdId, afterRevision: rev });
    for (const change of page.changes) {
      next = { ...next, events: next.events.map((e) => (e.id === change.eventId ? redact(e, change.field) : e)) };
    }
    if (page.nextAfterRevision <= rev) break;
    rev = page.nextAfterRevision;
    if (!page.hasMore) break;
  }
  next = { ...next, sync: { ...next.sync!, lastTextRev: Number(rev) } };

  // Keep anything the device added meanwhile (pull awaited the network).
  const latest = access.get(householdId)!;
  const extra = latest.events.filter((e) => e.seq === undefined && !next.events.some((x) => x.id === e.id));
  access.put(dropUnusedArchived(settle({ ...next, events: [...next.events, ...extra], seen: latest.seen })));
}

// ---------- the account's households ----------

export type PotSummary = {
  potId: ID;
  currency: { code: string; exponent: bigint };
  memberId: ID;
  role: 'owner' | 'member';
  minimumReaderSchemaVersion: bigint;
  lastSequence: bigint;
  lastTextRevision: bigint;
  isArchived: boolean;
};

/** Brings in households this account belongs to that are not on this device yet. */
export async function adoptPots(backend: Backend, access: Access, pots?: PotSummary[]): Promise<ID[]> {
  const list = pots ?? await backend.query<PotSummary[]>('pots:listMyPots', {});
  const added: ID[] = [];
  for (const pot of list) {
    if (pot.isArchived || access.get(pot.potId)) continue;
    const skeleton: Household = {
      id: pot.potId,
      name: 'Household',
      currency: pot.currency.code,
      createdAt: Date.now(),
      people: [],
      groups: [],
      youId: pot.memberId,
      events: [],
      seen: {},
      inviteCode: '',
      sync: { role: pot.role, schema: pot.minimumReaderSchemaVersion >= 2n ? 2 : 1, lastSeq: 0, lastTextRev: 0 },
    };
    // Build it fully before showing it.
    const staging: Household[] = [skeleton];
    const scratch: Access = {
      get: (id) => staging.find((x) => x.id === id),
      put: (h) => { staging[0] = h; },
      remove: () => {},
      all: () => staging,
    };
    await pull(backend, scratch, pot.potId);
    const built = staging[0];
    if (built.people.some((p) => p.id === built.youId)) {
      access.put(built);
      added.push(built.id);
    }
  }
  return added;
}

/** Pull then send for one household; promotes first if needed. */
export async function syncHousehold(backend: Backend, access: Access, householdId: ID): Promise<void> {
  const h = access.get(householdId);
  if (!h?.sync) return;
  if (h.sync.setup) await promote(backend, access, householdId);
  await pull(backend, access, householdId);
  await flush(backend, access, householdId);
}

// ---------- invites and joining ----------

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function random(n: number): Uint8Array {
  const b = new Uint8Array(n);
  // Invite secrets must come from a secure generator; there is deliberately no fallback.
  if (typeof globalThis.crypto?.getRandomValues !== 'function') throw new Error('No secure random generator');
  globalThis.crypto.getRandomValues(b);
  return b;
}

export function base64url(bytes: Uint8Array): string {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = [abc[(n >> 18) & 63], abc[(n >> 12) & 63], abc[(n >> 6) & 63], abc[n & 63]];
    out += chars.slice(0, i + 2 < bytes.length ? 4 : i + 1 < bytes.length ? 3 : 2).join('');
  }
  return out;
}

export const newInviteCode = () => Array.from(random(6), (b) => CODE_ALPHABET[b & 31]).join('');

/**
 * Makes sure every invited person who hasn't joined has a personal invite code (owner only).
 * Each code works once, for that person, for about a month.
 */
export async function issueInvites(backend: Backend, access: Access, householdId: ID, now = Date.now()): Promise<void> {
  const h = access.get(householdId);
  if (!h?.sync || h.sync.setup || h.sync.role !== 'owner') return;
  for (const person of h.people) {
    const cur = access.get(householdId)!;
    if (person.id === cur.youId || person.joined || person.archived) continue;
    const existing = cur.sync!.invites?.[person.id];
    if (existing && existing.expiresAt > now + DAY && existing.issued) continue;
    const invite: InviteInfo = existing && !existing.issued && existing.expiresAt > now + DAY
      ? existing
      : { inviteId: uuidv7(now), code: newInviteCode(), token: base64url(random(32)), expiresAt: now + 29 * DAY };
    access.put({ ...cur, sync: { ...cur.sync!, invites: { ...cur.sync!.invites, [person.id]: invite } } });
    const send = () => backend.mutation('members:issueInvite', {
      potId: householdId, inviteId: invite.inviteId, kind: 'perMember', pendingMemberId: person.id,
      token: invite.token, code: invite.code, expiresAt: invite.expiresAt,
    });
    try {
      await send();
    } catch (error) {
      const f = failureOf(error);
      if (f.retryable) throw new SyncError(f);
      if (f.code === 'INVITE_PENDING_MEMBER_ALREADY_ACTIVE') {
        // Another device issued this person's code; its code isn't readable here. Replace it.
        const live = await backend.query<{ inviteId: string; kind: string; pendingMemberId?: string }[]>('members:listInvites', { potId: householdId });
        for (const old of live.filter((x) => x.kind === 'perMember' && x.pendingMemberId === person.id)) {
          await backend.mutation('members:revokeInvite', { potId: householdId, inviteId: old.inviteId });
        }
        await send();
      } else {
        const latest = access.get(householdId)!;
        const invites = { ...latest.sync!.invites };
        delete invites[person.id];
        access.put({ ...latest, sync: { ...latest.sync!, invites } });
        if (f.code === 'MEMBER_ALREADY_CLAIMED') continue;
        throw new SyncError(f);
      }
    }
    const latest = access.get(householdId)!;
    access.put({ ...latest, sync: { ...latest.sync!, invites: { ...latest.sync!.invites, [person.id]: { ...invite, issued: true } } } });
  }
}

export type InvitePreview =
  | { status: 'active'; kind: 'perMember' | 'potLink'; potName: string | null; expiresAt: number; minimumReaderSchemaVersion: number; claimTicket: string }
  | { status: 'invalid' | 'expired' | 'revoked' | 'used' | 'rateLimited' | 'unavailable' };

/** Looks up an invite code (or a full invite link) on the server's public join endpoint. */
export async function resolveInvite(siteUrl: string, input: string, fetchImpl: typeof fetch = fetch): Promise<InvitePreview> {
  const link = /\/join\/([A-Za-z0-9_-]+)(?:\?code=([A-Za-z0-9]{6}))?/.exec(input);
  const path = link ? (link[2] ? `${link[1]}?code=${link[2]}` : link[1]) : input.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  let res: Response;
  try {
    res = await fetchImpl(`${siteUrl.replace(/\/$/, '')}/join/${path}`, { method: 'POST', headers: { Accept: 'application/json' } });
  } catch {
    return { status: 'unavailable' };
  }
  if (res.status === 429) return { status: 'rateLimited' };
  if (!res.ok) return { status: 'unavailable' };
  try {
    return (await res.json()) as InvitePreview;
  } catch {
    return { status: 'unavailable' };
  }
}

/** Claims a previewed invite. Personal codes join straight away; household links wait for the owner. */
export async function claimInvite(backend: Backend, access: Access, preview: Extract<InvitePreview, { status: 'active' }>, now = Date.now()): Promise<{ status: 'joined'; householdId: ID } | { status: 'pending' }> {
  if (preview.kind === 'potLink') {
    await backend.mutation('members:claimPotLinkInviteWithTicket', { ticket: preview.claimTicket });
    return { status: 'pending' };
  }
  const res = await backend.mutation<{ potId: string; memberId: string }>('members:claimPerMemberInviteWithTicket', {
    ticket: preview.claimTicket,
    event: { eventId: uuidv7(now), occurredAtMillis: BigInt(now), originatingTimeZone: wireTimeZone(), schemaVersion: BigInt(preview.minimumReaderSchemaVersion) },
  });
  await adoptPots(backend, access);
  return { status: 'joined', householdId: res.potId };
}

// ---------- structural changes (online only) ----------

function structuralEvent(h: Household, payload: WireEvent['payload'], now: number): WireEvent {
  return {
    eventId: uuidv7(now), potId: h.id, actorMemberId: h.youId, occurredAtMillis: BigInt(now),
    originatingTimeZone: wireTimeZone(), schemaVersion: BigInt(h.sync!.schema), payload, textFields: [], authoredText: [],
  };
}

export async function addPersonOnline(backend: Backend, access: Access, householdId: ID, name: string, now = Date.now()): Promise<ID> {
  const h = access.get(householdId)!;
  const memberId = uuidv7(now);
  const unitId = uuidv7(now);
  await backend.mutation('members:addPendingMember', {
    potId: h.id, displayName: displayName(name),
    event: structuralEvent(h, { kind: 'memberAdded', memberId, unitId, role: 'member' }, now),
  });
  await pull(backend, access, householdId);
  return memberId;
}

export async function renameOnline(backend: Backend, access: Access, householdId: ID, name: string, now = Date.now()) {
  const h = access.get(householdId)!;
  await backend.mutation('members:renamePot', { potId: h.id, event: structuralEvent(h, { kind: 'potRenamed', name: name.trim().slice(0, 128) }, now) });
  await pull(backend, access, householdId);
}

/** Regroups people before any money is recorded. A group is one to `maxGroupSize()` people. */
export async function regroupOnline(backend: Backend, access: Access, householdId: ID, arrangement: ID[][], now = Date.now()) {
  const h = access.get(householdId)!;
  if (arrangement.some((g) => g.length > maxGroupSize())) throw new PrepareError('group-too-large');
  const topology = await backend.query<{ revision: bigint }>('members:getBudgetGroupTopology', { potId: h.id });
  const groups: WireSettlementGroup[] = arrangement.filter((m) => m.length > 1).map((members) => {
    const same = h.groups.find((g) => g.serverGroupId && g.memberIds.length === members.length && members.every((m) => g.memberIds.includes(m)));
    return same
      ? { groupId: same.serverGroupId!, unitId: same.id, orderedMemberIds: [...members], defaultShareWeight: 1n }
      : { groupId: uuidv7(now), unitId: uuidv7(now), orderedMemberIds: [...members], defaultShareWeight: 1n };
  });
  await backend.mutation('members:changeBudgetGroups', {
    potId: h.id, expectedTopologyRevision: topology.revision,
    event: { ...structuralEvent(h, { kind: 'groupChanged', groups }, now), schemaVersion: 2n },
  });
  await pull(backend, access, householdId);
}

export async function leaveOnline(backend: Backend, access: Access, householdId: ID, now = Date.now()) {
  const h = access.get(householdId)!;
  await backend.mutation('members:leavePot', {
    potId: h.id,
    archiveEvent: structuralEvent(h, { kind: 'memberArchived', memberId: h.youId }, now),
    transferEventId: uuidv7(now),
  });
}

/**
 * Removes someone added by mistake: they haven't joined and no record mentions them. A person in
 * a shared group is first given a group of their own (allowed only before any money is recorded).
 */
export async function removePersonOnline(backend: Backend, access: Access, householdId: ID, personId: ID, now = Date.now()) {
  // Check against the latest roster: someone may have joined since this phone last looked.
  await pull(backend, access, householdId);
  const h = access.get(householdId)!;
  const person = h.people.find((p) => p.id === personId);
  if (!person || person.id === h.youId || person.joined || isPersonReferenced(h, personId)) throw new SyncError({ code: 'PERSON_IN_USE', retryable: false });
  const group = h.groups.find((g) => g.id === person.groupId);
  if (group && group.memberIds.length > 1) {
    await regroupOnline(backend, access, householdId, [
      ...h.groups.map((g) => g.memberIds.filter((m) => m !== personId)).filter((m) => m.length > 0),
      [personId],
    ], now);
  }
  const latest = access.get(householdId)!;
  await backend.mutation('members:archiveMember', {
    potId: latest.id, event: structuralEvent(latest, { kind: 'memberArchived', memberId: personId }, now),
  });
  await pull(backend, access, householdId);
}

/** Deletes a shared household nobody else has joined, for everyone, invites included. */
export async function deleteHouseholdOnline(backend: Backend, access: Access, householdId: ID) {
  for (let i = 0; i < 25; i++) {
    const res = await backend.mutation<{ deleted: boolean }>('pots:deleteHousehold', { potId: householdId });
    if (res.deleted) { access.remove(householdId); return; }
  }
  throw new SyncError({ code: 'HOUSEHOLD_DELETE_INCOMPLETE', retryable: true });
}
