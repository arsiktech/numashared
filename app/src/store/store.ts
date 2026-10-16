// Local-first household store. Every change is an appended ledger event, validated by the core
// before it is accepted. State persists on the device; sync plugs in behind `syncState` later.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';
import {
  canUndoInHousehold, reduce, validateEvent, sampleHousehold,
} from '@/core';
import type {
  Category, ExpenseContent, Household, ID, LedgerEvent, OpeningEntry, PaymentMethod, Person, Group,
  SettlementContent, Split,
} from '@/core/types';
import { GROUP_COLORS, MAX_GROUPS } from '@/core/types';
import { newId, inviteCode, todayISO } from './ids';
import { stamp } from '../sync/mapping';
import { isSending } from '../sync/engine';

export type Appearance = 'system' | 'light' | 'dark';

export type Prefs = { hideAmounts: boolean; appearance: Appearance; notifications: boolean };

export type State = {
  version: 1;
  households: Household[];
  activeId: ID | null;
  prefs: Prefs;
  /** Households locked on sign-out ("Lock and sign out") stay on the device but hidden. */
  locked: boolean;
  /** Event ids created on this device in this session, newest last: the Undo lane reads these. */
  recent: { eventId: ID; householdId: ID; at: number; label: string }[];
  /** Simulated failure switch for QA of the Save failed state (never set in normal use). */
  failNextSave: boolean;
};

const STORAGE_KEY = 'numa-shared/state/v1';

const initial: State = {
  version: 1,
  households: [],
  activeId: null,
  prefs: { hideAmounts: false, appearance: 'system', notifications: true },
  locked: false,
  recent: [],
  failNextSave: false,
};

let state: State = initial;
let hydrated = false;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
  schedulePersist();
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist() {
  if (!hydrated) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const { recent: _recent, failNextSave: _f, ...rest } = state;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(rest)).catch(() => {});
  }, 150);
}

export async function hydrate(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<State>;
      if (saved.version === 1 && Array.isArray(saved.households)) {
        state = { ...initial, ...saved, recent: [], failNextSave: false } as State;
      }
    }
  } catch {
    // A broken saved state must never block the app; start empty.
  }
  hydrated = true;
  emit();
}

export const isHydrated = () => hydrated;

function set(next: State) {
  state = next;
  emit();
}

export function getState() { return state; }

export function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state), () => selector(state));
}

// ---------- selectors ----------

export const activeHousehold = (s: State): Household | null =>
  s.locked ? null : s.households.find((h) => h.id === s.activeId) ?? null;

const ledgerCache = new WeakMap<Household, ReturnType<typeof reduce>>();
export function ledgerOf(h: Household) {
  let l = ledgerCache.get(h);
  if (!l) { l = reduce(h); ledgerCache.set(h, l); }
  return l;
}

export const you = (h: Household): Person => h.people.find((p) => p.id === h.youId)!;
export const yourGroup = (h: Household): Group => h.groups.find((g) => g.id === you(h).groupId)!;
export const personById = (h: Household, id: ID) => h.people.find((p) => p.id === id);
export const groupById = (h: Household, id: ID) => h.groups.find((g) => g.id === id);
export const groupOfPerson = (h: Household, personId: ID) => groupById(h, personById(h, personId)!.groupId)!;

// ---------- household lifecycle ----------

export type NewHouseholdInput = { name: string; currency: string; youName: string; others: string[] };

export function createHousehold(input: NewHouseholdInput): ID {
  const now = Date.now();
  const people: Person[] = [];
  const groups: Group[] = [];
  const add = (name: string, joined: boolean) => {
    const gid = newId('g');
    const pid = newId('p');
    groups.push({ id: gid, color: GROUP_COLORS[groups.length % GROUP_COLORS.length], memberIds: [pid] });
    // A one-person group's id is that person's settlement unit.
    people.push({ id: pid, name: name.trim(), groupId: gid, joined, joinedAt: joined ? now : undefined, unitId: gid });
    return pid;
  };
  const youId = add(input.youName || 'You', true);
  for (const n of input.others.filter((x) => x.trim()).slice(0, MAX_GROUPS - 1)) add(n, false);
  const h: Household = {
    id: newId('h'), name: input.name.trim() || 'Our place', currency: input.currency, createdAt: now,
    people, groups, youId, events: [], seen: {}, inviteCode: inviteCode(),
  };
  set({ ...state, households: [...state.households, h], activeId: h.id, locked: false });
  return h.id;
}

export function loadSample(): ID {
  const h = sampleHousehold(Date.now());
  const others = state.households.filter((x) => x.id !== h.id);
  set({ ...state, households: [...others, h], activeId: h.id, locked: false });
  return h.id;
}

export function switchHousehold(id: ID) { set({ ...state, activeId: id, locked: false }); }

function updateHousehold(id: ID, fn: (h: Household) => Household) {
  set({ ...state, households: state.households.map((h) => (h.id === id ? fn(h) : h)) });
}

export function renameHousehold(id: ID, name: string) { updateHousehold(id, (h) => ({ ...h, name })); }

/** For the sync runtime: replace (or add) a household as the server shaped it. */
export function putHousehold(h: Household) {
  const exists = state.households.some((x) => x.id === h.id);
  set({
    ...state,
    households: exists ? state.households.map((x) => (x.id === h.id ? h : x)) : [...state.households, h],
    activeId: state.activeId ?? h.id,
  });
}

export function removeHousehold(id: ID) {
  const rest = state.households.filter((h) => h.id !== id);
  set({ ...state, households: rest, activeId: state.activeId === id ? (rest[0]?.id ?? null) : state.activeId });
}

/** The currency is fixed once the first financial record exists. */
export function setCurrency(id: ID, currency: string) {
  updateHousehold(id, (h) => (h.events.length ? h : { ...h, currency }));
}

export function hasFinancialHistory(h: Household) { return h.events.length > 0; }

/** Regroup people. Allowed only before the first financial record (core contract). */
export function setGroups(id: ID, groups: { memberIds: ID[] }[]) {
  updateHousehold(id, (h) => regroup(h, groups));
}

/**
 * The household with people arranged into `groups` (one or two people each). A one-person group is
 * keyed by that person's settlement unit; a pair keeps its ids while it holds the same two people.
 */
export function regroup(h: Household, groups: { memberIds: ID[] }[]): Household {
  if (hasFinancialHistory(h)) throw new Error('Groups are fixed once money is recorded.');
  const kept = groups.filter((g) => g.memberIds.length).slice(0, MAX_GROUPS);
  if (kept.some((g) => g.memberIds.length > 2)) throw new Error('A group is one or two people.');
  const used = new Set<Group['color']>();
  const prior = kept.map((g) => h.groups.find((old) => old.memberIds.includes(g.memberIds[0])));
  const next: Group[] = kept.map((g, i) => {
    const before = prior[i] && prior.indexOf(prior[i]) === i ? prior[i] : undefined;
    const color = before && !used.has(before.color) ? before.color : GROUP_COLORS.find((x) => !used.has(x) && !prior.some((p, j) => j > i && p?.color === x))!;
    used.add(color);
    if (g.memberIds.length === 1) {
      const person = h.people.find((p) => p.id === g.memberIds[0]);
      return { id: person?.unitId ?? before?.id ?? newId('g'), color, memberIds: g.memberIds };
    }
    const samePair = h.groups.find((old) => old.memberIds.length === 2 && g.memberIds.every((m) => old.memberIds.includes(m)));
    return samePair
      ? { id: samePair.id, serverGroupId: samePair.serverGroupId ?? newId('sg'), color, memberIds: g.memberIds }
      : { id: newId('g'), serverGroupId: newId('sg'), color, memberIds: g.memberIds };
  });
  const people = h.people.map((p) => ({ ...p, groupId: next.find((g) => g.memberIds.includes(p.id))!.id }));
  return { ...h, groups: next, people };
}

export function setGroupColor(id: ID, groupId: ID, color: Group['color']) {
  updateHousehold(id, (h) => {
    if (h.groups.some((g) => g.id !== groupId && g.color === color)) return h;
    return { ...h, groups: h.groups.map((g) => (g.id === groupId ? { ...g, color } : g)) };
  });
}

export function addPerson(id: ID, name: string): ID | null {
  let pid: ID | null = null;
  updateHousehold(id, (h) => {
    if (h.groups.length >= MAX_GROUPS) return h;
    const used = new Set(h.groups.map((g) => g.color));
    const color = GROUP_COLORS.find((c) => !used.has(c))!;
    const gid = newId('g');
    pid = newId('p');
    return {
      ...h,
      groups: [...h.groups, { id: gid, color, memberIds: [pid] }],
      people: [...h.people, { id: pid, name: name.trim(), groupId: gid, joined: false, unitId: gid }],
    };
  });
  return pid;
}

// ---------- ledger writes ----------

export class SaveError extends Error {}

function append(householdId: ID, event: LedgerEvent, label: string) {
  if (state.failNextSave) {
    set({ ...state, failNextSave: false });
    throw new SaveError('Couldn’t save just now.');
  }
  const h = state.households.find((x) => x.id === householdId);
  if (!h) throw new SaveError('Household not found.');
  validateEvent(h, event);
  const next: Household = { ...h, events: [...h.events, stamp(event)] };
  set({
    ...state,
    households: state.households.map((x) => (x.id === householdId ? next : x)),
    recent: [...state.recent.slice(-9), { eventId: event.id, householdId, at: event.at, label }],
  });
  return event.id;
}

const base = (h: Household) => ({ id: newId('e'), at: Date.now(), by: h.youId });

export function addExpense(h: Household, content: ExpenseContent, label: string) {
  return append(h.id, { ...base(h), kind: 'expenseAdded', recordId: newId('r'), content }, label);
}

export function reviseExpense(h: Household, recordId: ID, content: ExpenseContent, reason: string | undefined, label: string) {
  // The edit replaces the revision currently applied: the latest one for this record.
  const head = [...h.events].reverse().find((e) => e.recordId === recordId && (e.kind === 'expenseAdded' || e.kind === 'expenseRevised'));
  const basis = head ? { kind: 'parent' as const, parentEventId: head.id } : undefined;
  return append(h.id, { ...base(h), kind: 'expenseRevised', recordId, content, reason, basis }, label);
}

export function recordSettlement(h: Household, content: SettlementContent, label: string) {
  return append(h.id, { ...base(h), kind: 'settlementRecorded', recordId: newId('r'), content }, label);
}

export function flagSettlement(h: Household, recordId: ID, reason?: string) {
  return append(h.id, { ...base(h), kind: 'settlementFlagged', recordId, reason }, 'Repayment flagged');
}

export function setOpeningBalance(h: Household, entries: OpeningEntry[], note?: string) {
  return append(h.id, {
    ...base(h), kind: 'openingBalanceSet', recordId: newId('r'), content: { entries, note, date: todayISO() },
  }, 'Opening balance');
}

export function voidRecord(h: Household, recordId: ID, reason: string, label: string) {
  return append(h.id, { ...base(h), kind: 'recordVoided', recordId, reason }, label);
}

export function restoreRecord(h: Household, recordId: ID, label: string) {
  return append(h.id, { ...base(h), kind: 'recordRestored', recordId }, label);
}

/** Undo removes an event only while it is inside its window and has not been shared. */
export function undo(eventId: ID): boolean {
  const r = state.recent.find((x) => x.eventId === eventId);
  if (!r) return false;
  const h = state.households.find((x) => x.id === r.householdId);
  const ev = h?.events.find((e) => e.id === eventId);
  if (!h || !ev || ev.seq !== undefined || isSending(eventId) || !canUndoInHousehold(h, eventId, Date.now())) return false;
  const next = { ...h, events: h.events.filter((e) => e.id !== eventId) };
  set({
    ...state,
    households: state.households.map((x) => (x.id === h.id ? next : x)),
    recent: state.recent.filter((x) => x.eventId !== eventId),
  });
  return true;
}

export function markSeen(householdId: ID, eventIds: ID[]) {
  const h = state.households.find((x) => x.id === householdId);
  if (!h) return;
  let changed = false;
  const seen = { ...h.seen };
  for (const id of eventIds) {
    if (seen[id]?.[h.youId]) continue;
    seen[id] = { ...(seen[id] ?? {}), [h.youId]: Date.now() };
    changed = true;
  }
  if (changed) updateHousehold(householdId, (x) => ({ ...x, seen }));
}

// ---------- prefs and session ----------

export function setPrefs(p: Partial<Prefs>) { set({ ...state, prefs: { ...state.prefs, ...p } }); }

export function signOut(mode: 'lock' | 'erase') {
  if (mode === 'lock') set({ ...state, locked: true });
  else set({ ...initial, prefs: state.prefs });
}

export function unlock() { set({ ...state, locked: false }); }

export function leaveHousehold(id: ID) {
  const rest = state.households.filter((h) => h.id !== id);
  set({ ...state, households: rest, activeId: rest[0]?.id ?? null });
}

export function failNextSaveForQA() { set({ ...state, failNextSave: true }); }

export type { Category, PaymentMethod, Split };
