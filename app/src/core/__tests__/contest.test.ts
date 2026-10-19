// Review item 14: two edits of the same version are a contest, as on the server. The newest
// counts until someone keeps one; keeping one ends the contest everywhere.
import { describe, expect, it } from 'vitest';
import { reduce } from '../ledger';
import type { LedgerEvent } from '../types';
import { add, expense, household, revise } from './helpers';

describe('concurrent edits', () => {
  const created = add('r1', expense('sam', 9000));
  const fromParent = (e: LedgerEvent, by: string, at: number): LedgerEvent => ({
    ...e, by, at, basis: { kind: 'parent', parentEventId: created.id },
  } as LedgerEvent);
  const mine = fromParent(revise('r1', expense('sam', 6000)), 'ari', 2000);
  const theirs = fromParent(revise('r1', expense('sam', 3000)), 'sam', 2001);

  it('marks the record contested and counts the newer edit meanwhile', () => {
    const r = reduce(household([created, mine, theirs])).byId.r1;
    expect(r.contested).toEqual([mine.id, theirs.id]);
    expect(r.expense!.amount).toBe(3000);
  });

  it('keeping one version ends the contest with that version', () => {
    const [firstEventId, secondEventId] = [mine.id, theirs.id].sort();
    const keepMine = { ...revise('r1', expense('sam', 6000)), at: 3000, basis: { kind: 'resolution', firstEventId, secondEventId } } as LedgerEvent;
    const r = reduce(household([created, mine, theirs, keepMine])).byId.r1;
    expect(r.contested).toBeUndefined();
    expect(r.expense!.amount).toBe(6000);
  });

  it('an edit built on the latest version is not a contest', () => {
    const next = { ...revise('r1', expense('sam', 5000)), at: 3000, basis: { kind: 'parent', parentEventId: mine.id } } as LedgerEvent;
    const r = reduce(household([created, mine, next])).byId.r1;
    expect(r.contested).toBeUndefined();
    expect(r.expense!.amount).toBe(5000);
  });
});
