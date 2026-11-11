import { describe, expect, test } from 'vitest';
import { sampleHousehold } from '../../core/fixtures';
import type { Household, ID, LedgerEvent } from '../../core/types';
import { promote, pull, stageSync, SyncError, type Access, type Backend } from '../engine';
import type { ListedEvent, WireEvent } from '../wire';

function memoryAccess(...households: Household[]): Access {
  const all = new Map(households.map((h) => [h.id, h]));
  return {
    get: (id) => all.get(id),
    put: (h) => { all.set(h.id, h); },
    remove: (id) => { all.delete(id); },
    all: () => [...all.values()],
  };
}

type Call = { name: string; args: Record<string, unknown> };

function promotingBackend(calls: Call[]): Backend {
  return {
    async query() { throw new Error('No queries expected'); },
    async mutation<T>(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      const events = args.events as WireEvent[];
      return { events: events.map((e, i) => ({ eventId: e.eventId, sequence: BigInt(i + 1) })) } as T;
    },
  };
}

const NOW = Date.UTC(2026, 9, 13, 12);

describe('promoting a household with an edit that has no basis', () => {
  test('gives the edit the basis the store would record, then promotes it', async () => {
    const sample = sampleHousehold(NOW);
    // An edit saved before edits recorded what they replace.
    const local: Household = {
      ...sample,
      events: sample.events.map((e) => (e.kind === 'expenseRevised' ? { ...e, basis: undefined } : e)),
    };
    const access = memoryAccess(local);
    const calls: Call[] = [];
    const id = stageSync(access, local.id, NOW);
    await promote(promotingBackend(calls), access, id);

    expect(calls).toHaveLength(1);
    const h = access.get(id)!;
    expect(h.sync!.setup).toBeUndefined();
    expect(h.sync!.paused).toBeUndefined();
    const edit = h.events.find((e) => e.kind === 'expenseRevised')!;
    const dinner = h.events.find((e) => e.kind === 'expenseAdded' && e.recordId === edit.recordId)!;
    expect(dinner.id).not.toBe('e-dinner');
    expect(edit.kind === 'expenseRevised' && edit.basis).toEqual({ kind: 'parent', parentEventId: dinner.id });
    const sent = (calls[0].args.events as WireEvent[]).find((e) => e.eventId === edit.id)!;
    expect(sent.payload).toMatchObject({ kind: 'expenseRevised', basis: { kind: 'parent', parentEventId: dinner.id } });
  });

  test('pauses the household with the code when an event still cannot be mapped', async () => {
    const orphan: LedgerEvent = {
      id: 'e1', at: NOW - 60_000, by: 'p1', kind: 'expenseRevised', recordId: 'r1',
      content: { payerId: 'p1', amount: 100, date: '2026-10-13', category: 'other', split: { mode: 'equal', groupIds: ['g1'], weighting: 'group' } },
    };
    const local: Household = {
      id: 'h1', name: 'Home', currency: 'EUR', createdAt: NOW - 120_000, youId: 'p1',
      people: [{ id: 'p1', name: 'Ana', groupId: 'g1', joined: true, unitId: 'g1' }],
      groups: [{ id: 'g1', color: 'citrus', memberIds: ['p1'] }],
      events: [orphan], seen: {}, inviteCode: '',
    };
    const access = memoryAccess(local);
    const calls: Call[] = [];
    const id = stageSync(access, local.id, NOW);

    const failure = await promote(promotingBackend(calls), access, id).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(SyncError);
    expect((failure as SyncError).failure).toEqual({ code: 'CLIENT_MISSING_BASIS', retryable: false });
    expect(calls).toHaveLength(0);
    expect(access.get(id)!.sync!.paused?.code).toBe('CLIENT_MISSING_BASIS');
  });
});

describe('pulling a change that conflicts with a queued one', () => {
  test('records the set-aside event once and removes it from the household', async () => {
    const added: LedgerEvent = {
      id: 'server-add', at: NOW - 3_600_000, by: 'p1', seq: 1, kind: 'expenseAdded', recordId: 'r1',
      content: { payerId: 'p1', amount: 1000, date: '2026-10-13', category: 'other', split: { mode: 'equal', groupIds: ['g1', 'g2'], weighting: 'group' } },
    };
    const localVoid: LedgerEvent = { id: 'local-void', at: NOW - 60_000, by: 'p1', kind: 'recordVoided', recordId: 'r1', reason: 'Twice' };
    const h: Household = {
      id: 'h1', name: 'Home', currency: 'EUR', createdAt: NOW - 7_200_000, youId: 'p1',
      people: [
        { id: 'p1', name: 'Ana', groupId: 'g1', joined: true, unitId: 'g1' },
        { id: 'p2', name: 'Ben', groupId: 'g2', joined: true, unitId: 'g2' },
      ],
      groups: [{ id: 'g1', color: 'citrus', memberIds: ['p1'] }, { id: 'g2', color: 'lilac', memberIds: ['p2'] }],
      events: [added, localVoid], seen: {}, inviteCode: '',
      sync: { role: 'owner', schema: 2, lastSeq: 1, lastTextRev: 0 },
    };
    // The other phone voided the same record first.
    const serverVoid: ListedEvent = {
      event: {
        eventId: 'server-void', potId: 'h1', actorMemberId: 'p2', occurredAtMillis: BigInt(NOW - 30_000), originatingTimeZone: 'UTC',
        schemaVersion: 2n, payload: { kind: 'recordVoided', recordId: 'r1' }, textFields: [], authoredText: [],
      },
      serverSequence: 2n,
      textStates: [{ field: 'reason', state: 'present', value: 'Duplicate' }],
    };
    const backend: Backend = {
      async query<T>(name: string) {
        if (name === 'events:listEvents') return { events: [serverVoid], hasMore: false, nextAfterSequence: 2n } as T;
        if (name === 'members:listRoster') {
          return [
            { memberId: 'p1', unitId: 'g1', displayName: 'Ana', role: 'owner', state: 'active' },
            { memberId: 'p2', unitId: 'g2', displayName: 'Ben', role: 'member', state: 'active' },
          ] as T;
        }
        return { changes: [], skippedRevisions: [], hasMore: false, nextAfterRevision: 0n } as T;
      },
      async mutation() { throw new Error('No mutations expected'); },
    };
    const access = memoryAccess(h);

    await pull(backend, access, 'h1');

    const after = access.get('h1')!;
    expect(after.sync!.rejected?.map((r) => [r.eventId, r.code])).toEqual([['local-void', 'LOCAL_ALREADY_VOIDED']]);
    expect(after.events.map((e) => e.id as ID)).toEqual(['server-add', 'server-void']);
  });
});
