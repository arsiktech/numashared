import { describe, expect, it } from 'vitest';
import { explain } from '../explain';
import { formatMoney } from '../money';
import { sampleHousehold, SAMPLE_IDS } from '../fixtures';
import { reduce } from '../ledger';
import { groupName, standing } from '../names';
import { planSettlement } from '../plan';
import { canUndo } from '../undo';

// 13 Oct 2026, 21:00 local time.
const NOW = new Date(2026, 9, 13, 21, 0).getTime();

describe('canonical fixture: Our place', () => {
  const h = sampleHousehold(NOW);
  const ledger = reduce(h);
  const ys = h.groups.find((g) => g.id === 'ys')!;
  const aj = h.groups.find((g) => g.id === 'aj')!;

  it('is a complete household with synthetic people', () => {
    expect(h.name).toBe('Our place');
    expect(h.currency).toBe('EUR');
    expect(h.people.map((p) => p.name)).toEqual(['Ari', 'Sam', 'Alex', 'Jo']);
    expect(groupName(ys, h.people, h.youId)).toBe('You + Sam');
    expect(groupName(aj, h.people, h.youId)).toBe('Alex + Jo');
    for (const e of h.events) expect(e.at).toBeLessThanOrEqual(NOW);
    for (const viewers of Object.values(h.seen)) for (const at of Object.values(viewers)) expect(at).toBeLessThanOrEqual(NOW);
    // Nothing in the demo is still undoable.
    expect(h.events.some((e) => canUndo(e, NOW))).toBe(false);
  });

  it('ends at You + Sam −75.70, Alex + Jo +75.70', () => {
    expect(ledger.balances).toEqual({ ys: -7570, aj: 7570 });
    expect(standing(ledger.balances.ys, ys, h.people, h.youId)).toEqual({ verb: 'owe', amount: 7570 });
    expect(formatMoney(ledger.balances.ys, h.currency)).toBe('−€75.70');
    expect(planSettlement(ledger.balances)).toEqual({ status: 'exact', transfers: [{ fromGroupId: 'ys', toGroupId: 'aj', amount: 7570 }] });
  });

  it('explains every step for You + Sam', () => {
    const lines = explain(ledger, h, 'ys');
    expect(lines.map(({ label, detail, date, change, running, voided }) => ({ label, detail, date, change, running, voided }))).toEqual([
      { label: 'Opening balance', detail: 'You + Sam owed Alex + Jo', date: '2026-09-30', change: -12000, running: -12000, voided: false },
      { label: 'Repayment', detail: 'to Alex + Jo', date: '2026-10-03', change: 6000, running: -6000, voided: false },
      { label: 'Electricity', detail: 'Sam paid', date: '2026-10-08', change: 4190, running: -1810, voided: false },
      { label: 'Cleaning stuff', detail: 'Jo paid · voided', date: '2026-10-10', change: 0, running: -1810, voided: true },
      { label: 'Dinner together', detail: 'Alex paid · edited', date: '2026-10-11', change: -4800, running: -6610, voided: false },
      { label: 'Internet', detail: 'Jo paid', date: '2026-10-12', change: -3600, running: -10210, voided: false },
      { label: 'Groceries', detail: 'You paid', date: '2026-10-13', change: 2640, running: -7570, voided: false },
    ]);
    expect(lines.map((l) => l.recordId)).toEqual(Object.values(SAMPLE_IDS.records));
  });

  it('explains every step for Alex + Jo, mirroring You + Sam', () => {
    const lines = explain(ledger, h, 'aj');
    expect(lines.map((l) => [l.label, l.detail, l.change, l.running])).toEqual([
      ['Opening balance', 'You + Sam owed Alex + Jo', 12000, 12000],
      ['Repayment', 'from You + Sam', -6000, 6000],
      ['Electricity', 'Sam paid', -4190, 1810],
      ['Cleaning stuff', 'Jo paid · voided', 0, 1810],
      ['Dinner together', 'Alex paid · edited', 4800, 6610],
      ['Internet', 'Jo paid', 3600, 10210],
      ['Groceries', 'You paid', -2640, 7570],
    ]);
  });

  it('keeps records, revisions, void and timelines', () => {
    const r = SAMPLE_IDS.records;
    const dinner = ledger.byId[r.dinner];
    expect(dinner.expense?.amount).toBe(9600);
    expect(dinner.expense?.category).toBe('eating-out');
    expect(dinner.expense?.note).toBe('Jo’s birthday, tip included');
    expect(dinner.revisions).toHaveLength(2);
    expect(dinner.effect).toEqual({ aj: 4800, ys: -4800 });
    const edit = dinner.timeline.find((t) => t.type === 'edited');
    expect(edit).toMatchObject({ by: 'alex', reason: 'Forgot the tip', changes: [{ field: 'amount', from: '€90.00', to: '€96.00' }] });
    const seenDinner = dinner.timeline.filter((t) => t.type === 'seen' && t.at === new Date(2026, 9, 12, 20, 14).getTime());
    expect(seenDinner.map((t) => (t.type === 'seen' ? t.personId : '')).sort()).toEqual(['ari', 'sam']);
    expect(dinner.timeline.map((t) => t.at)).toEqual([...dinner.timeline.map((t) => t.at)].sort((a, b) => a - b));

    const cleaning = ledger.byId[r.cleaning];
    expect(cleaning.voided).toBe(true);
    expect(cleaning.voidReason).toBe('Duplicate');
    expect(cleaning.effect).toEqual({});
    expect(cleaning.timeline.map((t) => t.type)).toEqual(['added', 'voided', 'seen']);

    const repayment = ledger.byId[r.repayment];
    expect(repayment.settlement).toMatchObject({ method: 'bank', note: 'Half of what we owed from September', amount: 6000 });
    expect(repayment.createdBy).toBe('sam');

    const groceries = ledger.byId[r.groceries];
    expect(groceries.expense?.note).toBe('Apples, bread and coffee');
    expect(groceries.timeline.find((t) => t.type === 'seen')).toMatchObject({ personId: 'alex' });
  });

  it('stays valid whatever time of day it is loaded', () => {
    for (const hour of [0, 1, 3, 9, 12, 18, 23]) {
      const now = new Date(2026, 9, 13, hour, 5).getTime();
      const sample = sampleHousehold(now);
      const l = reduce(sample);
      expect(l.balances).toEqual({ ys: -7570, aj: 7570 });
      const order = l.records.map((x) => x.id);
      expect(order).toEqual(Object.values(SAMPLE_IDS.records));
      for (const e of sample.events) expect(e.at).toBeLessThanOrEqual(now);
    }
  });
});
