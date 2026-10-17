// Shared test builders. Synthetic people only.
import type { ExpenseContent, Household, LedgerEvent, Split } from '../types';

/** mulberry32: small, seeded, deterministic. */
export function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
  };
}

/**
 * Three groups: ys = Ari (you) + Sam, aj = Alex + Jo, m = Mia.
 */
export function household(events: LedgerEvent[] = []): Household {
  return {
    id: 'h1',
    name: 'Test home',
    currency: 'EUR',
    createdAt: 0,
    people: [
      { id: 'ari', name: 'Ari', groupId: 'ys', joined: true },
      { id: 'sam', name: 'Sam', groupId: 'ys', joined: true },
      { id: 'alex', name: 'Alex', groupId: 'aj', joined: true },
      { id: 'jo', name: 'Jo', groupId: 'aj', joined: true },
      { id: 'mia', name: 'Mia', groupId: 'm', joined: false },
    ],
    groups: [
      { id: 'ys', color: 'citrus', memberIds: ['ari', 'sam'] },
      { id: 'aj', color: 'lilac', memberIds: ['alex', 'jo'] },
      { id: 'm', color: 'sky', memberIds: ['mia'] },
    ],
    youId: 'ari',
    events,
    seen: {},
    inviteCode: 'ABCDEF',
  };
}

let counter = 0;
export const eid = () => `e${++counter}`;

export function expense(payerId: string, amount: number, split: Split = { mode: 'equal', groupIds: ['ys', 'aj', 'm'], weighting: 'group' }, extra: Partial<ExpenseContent> = {}): ExpenseContent {
  return { payerId, amount, date: '2026-10-01', category: 'groceries', split, ...extra };
}

export const add = (recordId: string, content: ExpenseContent, at = 1000, by = 'ari'): LedgerEvent =>
  ({ id: eid(), at, by, kind: 'expenseAdded', recordId, content });
export const revise = (recordId: string, content: ExpenseContent, at = 2000, by = 'ari'): LedgerEvent =>
  ({ id: eid(), at, by, kind: 'expenseRevised', recordId, content, reason: 'fix' });
export const settle = (recordId: string, from: string, to: string, amount: number, at = 1000, by = 'ari', reversalOf?: string): LedgerEvent =>
  ({ id: eid(), at, by, kind: 'settlementRecorded', recordId, content: { fromGroupId: from, toGroupId: to, amount, date: '2026-10-01', reversalOf } });
export const opening = (recordId: string, entries: { fromGroupId: string; toGroupId: string; amount: number }[], at = 500, by = 'ari'): LedgerEvent =>
  ({ id: eid(), at, by, kind: 'openingBalanceSet', recordId, content: { entries, date: '2026-09-30' } });
export const voidIt = (recordId: string, at = 3000, reason = 'Duplicate', by = 'ari'): LedgerEvent =>
  ({ id: eid(), at, by, kind: 'recordVoided', recordId, reason });
export const restore = (recordId: string, at = 4000, by = 'ari'): LedgerEvent =>
  ({ id: eid(), at, by, kind: 'recordRestored', recordId });
export const flag = (recordId: string, at = 3500, by = 'ari'): LedgerEvent =>
  ({ id: eid(), at, by, kind: 'settlementFlagged', recordId, reason: 'Never arrived' });

export const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);
