// Review blocker 4: after a session expires and someone else signs in, the first account's shared
// households must not show. They come back only for the account they belong to.
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Household } from '@/core/types';

const disk = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => disk.get(k) ?? null,
    setItem: async (k: string, v: string) => { disk.set(k, v); },
  },
}));

const store = await import('../store');

const shared = (id: string, accountId?: string): Household => {
  const h = store.getState().households.find((x) => !x.sync) ?? null;
  return {
    ...(h ?? ({} as Household)), id, name: `House ${id}`,
    sync: { accountId, role: 'owner', schema: 2, lastSeq: 1, lastTextRev: 0 },
  };
};
const names = () => store.getState().households.map((h) => h.id).sort();

beforeEach(async () => {
  disk.clear();
  store.signOut('erase');
  await store.hydrate();
  store.showAccount(null);
  store.loadSample();
});

describe('households follow the signed-in account', () => {
  test('expiry hides them, another account never sees them, the owner gets them back', () => {
    const sampleId = store.getState().households[0].id;
    store.showAccount('A');
    store.putHousehold(shared('pot-a', 'A'));
    expect(names()).toEqual(['pot-a', sampleId].sort());

    store.showAccount(null); // the session expired
    expect(names()).toEqual([sampleId]);

    store.showAccount('B');
    store.putHousehold(shared('pot-b', 'B'));
    expect(names()).toEqual(['pot-b', sampleId].sort());

    // A sync for A that finishes late can't put A's household on B's screen.
    store.putHousehold(shared('pot-a', 'A'));
    expect(names()).toEqual(['pot-b', sampleId].sort());

    store.showAccount('A');
    expect(names()).toEqual(['pot-a', sampleId].sort());
    expect(store.getState().households.find((h) => h.id === 'pot-a')?.sync?.accountId).toBe('A');
  });

  test('copies from before accounts were recorded wait until the server confirms whose they are', () => {
    store.putHousehold(shared('pot-old'));
    store.showAccount(null);
    expect(names()).not.toContain('pot-old');
    store.showAccount('B');
    store.claimParked('B', ['pot-other']);
    expect(names()).not.toContain('pot-old');
    store.claimParked('B', ['pot-old']);
    expect(names()).toContain('pot-old');
    expect(store.getState().households.find((h) => h.id === 'pot-old')?.sync?.accountId).toBe('B');
  });

  test('signing out removes that account’s households from the device, shown or parked', () => {
    store.showAccount('A');
    store.putHousehold(shared('pot-a', 'A'));
    store.showAccount('B');
    store.forgetAccount('A');
    store.showAccount('A');
    expect(names()).not.toContain('pot-a');
  });
});
