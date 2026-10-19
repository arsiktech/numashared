import { describe, expect, it } from 'vitest';
import { sampleHousehold } from '../fixtures';
import { categoryLabel, groupName, isPlural, personName, standing } from '../names';
import { canDeleteLocalEvent, canUndo, canUndoInHousehold, UNDO_WINDOW_MS, undoRemainingMs } from '../undo';
import type { Group, LedgerEvent, Person } from '../types';
import { expense, eid } from './helpers';

const people: Person[] = [
  { id: 'ari', name: 'Ari', groupId: 'ys', joined: true },
  { id: 'sam', name: 'Sam', groupId: 'ys', joined: true },
  { id: 'alex', name: 'Alex', groupId: 'aj', joined: true },
  { id: 'jo', name: 'Jo', groupId: 'aj', joined: true },
  { id: 'mia', name: 'Mia', groupId: 'm', joined: false },
  { id: 'solo', name: 'Solo', groupId: 's', joined: true },
];
const ys: Group = { id: 'ys', color: 'citrus', memberIds: ['sam', 'ari'] };
const aj: Group = { id: 'aj', color: 'lilac', memberIds: ['alex', 'jo'] };
const m: Group = { id: 'm', color: 'sky', memberIds: ['mia'] };
const you: Group = { id: 's', color: 'mint', memberIds: ['solo'] };

describe('names', () => {
  it('puts You first inside the viewer group', () => {
    expect(groupName(ys, people, 'ari')).toBe('You + Sam');
    expect(groupName(ys, people, 'sam')).toBe('You + Ari');
    expect(groupName(you, people, 'solo')).toBe('You');
    expect(groupName(aj, people, 'ari')).toBe('Alex + Jo');
    expect(groupName(m, people, 'ari')).toBe('Mia');
    expect(groupName(ys, people, 'mia')).toBe('Sam + Ari');
    expect(personName('ari', people, 'ari')).toBe('You');
    expect(personName('jo', people, 'ari')).toBe('Jo');
  });

  it('agrees the verb with the group', () => {
    expect(isPlural(ys, people, 'ari')).toBe(true);
    expect(isPlural(you, people, 'solo')).toBe(true);
    expect(isPlural(aj, people, 'ari')).toBe(true);
    expect(isPlural(m, people, 'ari')).toBe(false);
    expect(standing(-5820, ys, people, 'ari')).toEqual({ verb: 'owe', amount: 5820 });
    expect(standing(-1320, m, people, 'ari')).toEqual({ verb: 'owes', amount: 1320 });
    expect(standing(-100, you, people, 'solo')).toEqual({ verb: 'owe', amount: 100 });
    expect(standing(1320, m, people, 'ari')).toEqual({ verb: 'gets back', amount: 1320 });
    expect(standing(7140, aj, people, 'ari')).toEqual({ verb: 'get back', amount: 7140 });
    expect(standing(0, m, people, 'ari')).toEqual({ verb: 'square', amount: 0 });
  });

  it('labels categories', () => {
    expect(categoryLabel('eating-out')).toBe('Eating out');
    expect(categoryLabel('groceries')).toBe('Groceries');
    expect(categoryLabel('internet')).toBe('Internet');
  });
});

describe('undo policy', () => {
  const ev = { at: 1_000_000 };
  it('allows undo in [0, 8 s) by default', () => {
    expect(UNDO_WINDOW_MS).toBe(8000);
    expect(canUndo(ev, ev.at)).toBe(true);
    expect(canUndo(ev, ev.at + 7999)).toBe(true);
    expect(canUndo(ev, ev.at + 8000)).toBe(false);
    expect(canUndo(ev, ev.at - 1)).toBe(false);
    expect(undoRemainingMs(ev, ev.at + 3000)).toBe(5000);
    expect(undoRemainingMs(ev, ev.at + 9000)).toBe(0);
  });

  it('keeps the window a parameter (Swift used 6 s)', () => {
    expect(canUndo(ev, ev.at + 5999, 6000)).toBe(true);
    expect(canUndo(ev, ev.at + 6000, 6000)).toBe(false);
  });

  it('ports the Swift rule: active session, held locally, inside the window', () => {
    const savedAt = 1_000_000;
    const at = (ms: number, dispatchState: 'heldLocally' | 'dispatching' | 'dispatched' = 'heldLocally', undoSessionIsActive = true) =>
      canDeleteLocalEvent({ savedAt, now: savedAt + ms, dispatchState, undoSessionIsActive, windowMs: 6000 });
    expect(at(5999)).toBe(true);
    expect(at(6000)).toBe(false);
    expect(at(2000, 'dispatched')).toBe(false);
    expect(at(2000, 'dispatching')).toBe(false);
    expect(at(2000, 'heldLocally', false)).toBe(false);
    expect(at(-1)).toBe(false);
    expect(canDeleteLocalEvent({ savedAt, now: savedAt + 7999, dispatchState: 'heldLocally', undoSessionIsActive: true })).toBe(true);
  });

  it('only undoes your own event that nothing later depends on', () => {
    const now = new Date(2026, 9, 13, 21, 0).getTime();
    const h = sampleHousehold(now);
    const mine: LedgerEvent = { id: eid(), at: now, by: 'ari', kind: 'expenseAdded', recordId: 'new', content: expense('ari', 500, { mode: 'equal', groupIds: ['ys', 'aj'], weighting: 'group' }) };
    const withMine = { ...h, events: [...h.events, mine] };
    expect(canUndoInHousehold(withMine, mine.id, now + 1000)).toBe(true);
    expect(canUndoInHousehold(withMine, mine.id, now + 8000)).toBe(false);
    expect(canUndoInHousehold(withMine, 'missing', now)).toBe(false);

    const theirs = { ...mine, id: eid(), by: 'sam', recordId: 'new2' };
    expect(canUndoInHousehold({ ...h, events: [...h.events, theirs] }, theirs.id, now + 1000)).toBe(false);

    const edit: LedgerEvent = { id: eid(), at: now + 500, by: 'ari', kind: 'recordVoided', recordId: 'new', reason: 'Oops' };
    const edited = { ...withMine, events: [...withMine.events, edit] };
    expect(canUndoInHousehold(edited, mine.id, now + 1000)).toBe(false);
    expect(canUndoInHousehold(edited, edit.id, now + 1000)).toBe(true);
  });
});
