// Review blocker 3: a save is reported only once it is on the device, and a failed write is shown.
import { beforeEach, describe, expect, test, vi } from 'vitest';

const disk = vi.hoisted(() => ({ data: new Map<string, string>(), fail: false, writes: [] as string[] }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => disk.data.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      await new Promise((r) => setTimeout(r, 5));
      if (disk.fail) throw new Error('disk full');
      disk.writes.push(v);
      disk.data.set(k, v);
    },
  },
}));

const store = await import('../store');

import type { ExpenseContent, Household } from '@/core/types';

const sampleContent = (h: Household): ExpenseContent => {
  const e = h.events.find((x) => x.kind === 'expenseAdded');
  if (e?.kind !== 'expenseAdded') throw new Error('sample has no expense');
  return e.content;
};
const onDisk = () => JSON.parse([...disk.data.values()][0] ?? '{}') as { households?: { events: { id: string }[] }[] };

beforeEach(async () => {
  disk.data.clear();
  disk.writes.length = 0;
  disk.fail = false;
  await store.hydrate();
  store.loadSample();
});

describe('durable saves', () => {
  test('an expense resolves only after it is written, and survives a restart', async () => {
    const h = store.activeHousehold(store.getState())!;
    const saving = store.addExpense(h, sampleContent(h), 'Added');
    // Not yet in the undo lane: nothing has reached the disk.
    expect(store.getState().recent.some((r) => r.label === 'Added')).toBe(false);
    const id = await saving;
    expect(onDisk().households!.some((x) => x.events.some((e) => e.id === id))).toBe(true);
    expect(store.getState().recent.at(-1)?.eventId).toBe(id);
  });

  test('a failed write takes the expense back out and says so', async () => {
    const h = store.activeHousehold(store.getState())!;
    const before = h.events.length;
    const lane = store.getState().recent.length;
    disk.fail = true;
    await expect(store.addExpense(h, sampleContent(h), 'Added'))
      .rejects.toBeInstanceOf(store.SaveError);
    expect(store.activeHousehold(store.getState())!.events).toHaveLength(before);
    expect(store.getState().recent).toHaveLength(lane);
  });

  test('writes land in order, so an older snapshot never overwrites a newer one', async () => {
    const h = store.activeHousehold(store.getState())!;
    const content = sampleContent(h);
    const [a, b] = await Promise.all([store.addExpense(h, content, 'A'), store.addExpense(store.activeHousehold(store.getState())!, content, 'B')]);
    const last = JSON.parse(disk.writes.at(-1)!) as { households: { events: { id: string }[] }[] };
    const ids = last.households.flatMap((x) => x.events.map((e) => e.id));
    expect(ids).toContain(a);
    expect(ids).toContain(b);
  });
});
