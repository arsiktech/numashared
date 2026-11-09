// Changes a connected AI agent makes show as the person's, "via" the agent (convex/agentWrites.ts),
// and Settings, AI agents shows one switch per kind of change.
import { describe, expect, test, vi } from 'vitest';
import { reduce } from '@/core/ledger';
import type { Household } from '@/core/types';
import { AGENT_SWITCHES, READ_ONLY, permissionSummary, withPermission } from '@/features/agents/permissions';
import { fromWire } from '@/sync/mapping';
import type { ListedEvent } from '@/sync/wire';

vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: async () => null, setItem: async () => {} } }));

const { addedByLine, authorName } = await import('../hooks');
const { threadItems } = await import('../history/model');

const ANA = '01890f5e-7b00-7000-8000-0000000000a1';
const LEO = '01890f5e-7b00-7000-8000-0000000000b1';
const ANA_UNIT = '01890f5e-7b00-7000-8000-0000000000a2';
const LEO_UNIT = '01890f5e-7b00-7000-8000-0000000000b2';
const RECORD = '01890f5e-7b00-7000-8000-0000000000c1';
const eur = (cents: number) => ({ minorUnits: BigInt(cents), currency: { code: 'EUR', exponent: 2n } });

function house(): Household {
  return {
    id: 'pot', name: 'Casa', currency: 'EUR', createdAt: 1, youId: ANA,
    people: [{ id: ANA, name: 'Ana', groupId: ANA_UNIT, joined: true }, { id: LEO, name: 'Leo', groupId: LEO_UNIT, joined: true }],
    groups: [{ id: ANA_UNIT, color: 'citrus', memberIds: [ANA] }, { id: LEO_UNIT, color: 'lilac', memberIds: [LEO] }],
    events: [], seen: {},
  } as unknown as Household;
}

function listed(seq: number, by: string, payload: ListedEvent['event']['payload'], text: Array<[string, string]>, via?: string): ListedEvent {
  return {
    event: {
      eventId: `01890f5e-7b00-7000-8000-00000000000${seq}`, potId: 'pot', actorMemberId: by,
      occurredAtMillis: 1_760_000_000_000n, originatingTimeZone: 'Europe/Madrid', schemaVersion: 1n,
      payload, textFields: text.map(([f]) => f) as never, authoredText: [],
    },
    serverSequence: BigInt(seq),
    recordedAtMillis: 1_760_000_000_000 + seq,
    ...(via === undefined ? {} : { via }),
    textStates: text.map(([field, value]) => ({ field, state: 'present', value })) as never,
  };
}

describe('agent attribution', () => {
  const h = house();
  const added = fromWire(h, listed(1, LEO, {
    kind: 'expenseAdded', recordId: RECORD,
    content: { expenseKind: 'shared', amount: eur(1000), payerUnitId: ANA_UNIT, allocations: [{ unitId: ANA_UNIT, amount: eur(500) }, { unitId: LEO_UNIT, amount: eur(500) }] },
  }, [['title', 'Bread'], ['category', 'groceries']], 'Claude'))!;
  const voided = fromWire(h, listed(2, ANA, { kind: 'recordVoided', recordId: RECORD }, [['reason', 'Twice']], 'Codex'))!;
  const plain = fromWire(h, listed(3, ANA, { kind: 'recordRestored', recordId: RECORD }, []))!;

  test('a listed event keeps the agent name; an app-made one has none', () => {
    expect(added.via).toBe('Claude');
    expect(plain.via).toBeUndefined();
    expect(fromWire(h, listed(4, ANA, { kind: 'recordRestored', recordId: RECORD }, [], '   '))!.via).toBeUndefined();
  });

  test('the record and its timeline say who and via what', () => {
    const ledger = reduce({ ...h, events: [added, voided, plain] });
    const record = ledger.records[0]!;
    expect(record).toMatchObject({ createdBy: LEO, createdVia: 'Claude' });
    expect(record.timeline.map((t) => ('via' in t ? t.via : undefined))).toEqual(['Claude', 'Codex', undefined]);
    const lines = threadItems({ ...h, events: [added, voided, plain] }, ledger.records, 'changes', '').map((i) => i.kind === 'change' ? i.text : '');
    expect(lines).toEqual(['You via Codex voided “Bread”: Twice', 'You restored “Bread”']);
    // The bubble footer: someone else's agent added an expense you paid.
    expect(addedByLine(h, record, ANA)).toBe(' · added by Leo via Claude');
    expect(addedByLine(h, { createdBy: ANA, createdVia: 'Claude' }, ANA)).toBe(' · added by You via Claude');
    expect(addedByLine(h, { createdBy: ANA }, ANA)).toBe('');
    expect(authorName(h, LEO)).toBe('Leo');
    // Searching for the agent finds what it added.
    expect(threadItems({ ...h, events: [added] }, reduce({ ...h, events: [added] }).records, 'all', 'claude')).toHaveLength(1);
  });
});

describe('agent switches', () => {
  test('three switches, labelled as the server names them in refusals', () => {
    expect(AGENT_SWITCHES.map((s) => s.key)).toEqual(['addRecords', 'editRecords', 'manageHousehold']);
    expect(AGENT_SWITCHES.map((s) => s.label)).toEqual(['Add expenses and repayments', 'Edit and void records', 'Manage the household']);
    // Nothing a switch could turn on deletes, leaves or removes.
    expect(AGENT_SWITCHES.some((s) => /delete|leave|remove/i.test(`${s.label} ${s.sub ?? ''}`))).toBe(false);
  });

  test('a summary under the agent name follows the switches', () => {
    expect(permissionSummary(READ_ONLY)).toBe('Can only read');
    const all = { addRecords: true, editRecords: true, manageHousehold: true };
    expect(permissionSummary(all)).toBe('Can read, add, edit and manage the household');
    expect(permissionSummary(withPermission(all, 'editRecords', false))).toBe('Can read, add and manage the household');
    expect(permissionSummary(withPermission(READ_ONLY, 'addRecords', true))).toBe('Can read and add');
    expect(withPermission(READ_ONLY, 'manageHousehold', true)).toEqual({ addRecords: false, editRecords: false, manageHousehold: true });
  });
});
