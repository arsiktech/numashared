import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Household } from '@/core/types';

const disk = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: async (key: string) => disk.get(key) ?? null,
  setItem: async (key: string, value: string) => { disk.set(key, value); },
} }));
const store = await import('../store');
const current = () => store.activeHousehold(store.getState())!;

beforeEach(async () => {
  disk.clear();
  store.signOut('erase');
  await store.hydrate();
  store.loadSample();
});

const expense = (h: Household) => {
  const event = h.events.find((e) => e.kind === 'expenseAdded');
  if (event?.kind !== 'expenseAdded') throw new Error('Missing synthetic expense');
  return { recordId: event.recordId, content: event.content };
};
const repayment = (h: Household) => {
  const event = h.events.find((e) => e.kind === 'settlementRecorded');
  if (event?.kind !== 'settlementRecorded') throw new Error('Missing synthetic repayment');
  return { recordId: event.recordId, content: event.content };
};

const writes = {
  add: (h: Household) => store.addExpense(h, expense(h).content, 'Added'),
  revise: (h: Household) => store.reviseExpense(h, expense(h).recordId, expense(h).content, 'Correction', 'Edited'),
  repay: (h: Household) => store.recordSettlement(h, repayment(h).content, 'Repaid'),
  flag: (h: Household) => store.flagSettlement(h, repayment(h).recordId, 'Correction'),
  opening: (h: Household) => store.setOpeningBalance(h, [{ fromGroupId: h.groups[0].id, toGroupId: h.groups[1].id, amount: 100 }]),
  void: (h: Household) => store.voidRecord(h, expense(h).recordId, 'Duplicate', 'Voided'),
  restore: (h: Household) => {
    const event = h.events.find((e) => e.kind === 'recordVoided');
    if (!event) throw new Error('Missing synthetic void');
    return store.restoreRecord(h, event.recordId, 'Restored');
  },
};

describe('frozen history is read-only at the durable append boundary', () => {
  for (const [name, write] of Object.entries(writes)) test(`refuses ${name} without events, balance, success lane or persistence changes`, async () => {
    const h = current();
    store.putHousehold({ ...h, sync: { role: 'member', schema: 2, lastSeq: 9, lastTextRev: 1, frozen: true } });
    const before = JSON.stringify(store.getState());
    await expect(write(current())).rejects.toThrow('This household is read-only. You can still view its history.');
    expect(JSON.stringify(store.getState())).toBe(before);
  });

  test('checks current store membership instead of a draft captured before archival', async () => {
    const stale = current();
    store.putHousehold({ ...stale, sync: { role: 'member', schema: 2, lastSeq: 9, lastTextRev: 1, frozen: true } });
    await expect(store.addExpense(stale, expense(stale).content, 'Added')).rejects.toBeInstanceOf(store.SaveError);
    expect(current().events).toEqual(stale.events);
    expect(store.getState().recent).toEqual([]);
  });

  test('ordinary local and active shared positive saves remain durable and undoable', async () => {
    const local = current();
    const localId = await store.addExpense(local, expense(local).content, 'Local');
    expect(current().events.some((e) => e.id === localId)).toBe(true);
    const h = current();
    store.putHousehold({ ...h, sync: { role: 'member', schema: 2, lastSeq: 9, lastTextRev: 1, frozen: false } });
    const sharedId = await store.addExpense(current(), expense(h).content, 'Shared');
    expect(store.getState().recent.at(-1)?.eventId).toBe(sharedId);
    expect(JSON.parse(disk.get('numa-shared/state/v1')!).households[0].events.some((e: { id: string }) => e.id === sharedId)).toBe(true);
  });
});
