import { describe, expect, it } from 'vitest';
import { explain } from '../explain';
import { checkEvent, LedgerError, reduce, validateEvent } from '../ledger';
import { planSettlement } from '../plan';
import type { Cents, ExpenseContent, Household, LedgerEvent, Split } from '../types';
import {
  add, eid, expense, flag, household, opening, prng, restore, revise, settle, sum, voidIt,
} from './helpers';

const codeOf = (h: Household, e: LedgerEvent) => checkEvent(h, e)?.code ?? null;

describe('record effects', () => {
  it('expense: payer group +amount, each group −share, zero-sum', () => {
    const l = reduce(household([add('r1', expense('sam', 9000))]));
    expect(l.byId.r1.effect).toEqual({ ys: 9000 - 3000, aj: -3000, m: -3000 });
    expect(l.balances).toEqual({ ys: 6000, aj: -3000, m: -3000 });
    expect(sum(l.balances)).toBe(0);
  });

  it('payer outside the split still gets the whole amount back', () => {
    const l = reduce(household([add('r1', expense('mia', 1000, { mode: 'equal', groupIds: ['ys', 'aj'], weighting: 'group' }))]));
    expect(l.balances).toEqual({ ys: -500, aj: -500, m: 1000 });
  });

  it('settlement from A to B: A +amount, B −amount', () => {
    const l = reduce(household([settle('s1', 'ys', 'aj', 6000)]));
    expect(l.byId.s1.effect).toEqual({ ys: 6000, aj: -6000 });
    expect(l.balances).toEqual({ ys: 6000, aj: -6000, m: 0 });
  });

  it('opening "from owes to": from −amount, to +amount', () => {
    const l = reduce(household([opening('o1', [{ fromGroupId: 'ys', toGroupId: 'aj', amount: 12000 }, { fromGroupId: 'm', toGroupId: 'aj', amount: 500 }])]));
    expect(l.byId.o1.effect).toEqual({ ys: -12000, aj: 12500, m: -500 });
    expect(sum(l.balances)).toBe(0);
  });

  it('every group has a balance, zero when untouched', () => {
    expect(reduce(household()).balances).toEqual({ ys: 0, aj: 0, m: 0 });
  });
});

describe('void, restore and revise', () => {
  it('void removes the effect, restore brings it back', () => {
    const h = household([add('r1', expense('sam', 9000)), voidIt('r1', 3000, '  Duplicate  ')]);
    let l = reduce(h);
    expect(l.byId.r1.voided).toBe(true);
    expect(l.byId.r1.voidReason).toBe('Duplicate');
    expect(l.byId.r1.effect).toEqual({});
    expect(l.balances).toEqual({ ys: 0, aj: 0, m: 0 });

    l = reduce({ ...h, events: [...h.events, restore('r1')] });
    expect(l.byId.r1.voided).toBe(false);
    expect(l.byId.r1.voidReason).toBeUndefined();
    expect(l.balances).toEqual({ ys: 6000, aj: -3000, m: -3000 });
    expect(l.byId.r1.timeline.map((t) => t.type)).toEqual(['added', 'voided', 'restored']);
  });

  it('void works on repayments and opening balances too', () => {
    const l = reduce(household([
      settle('s1', 'ys', 'aj', 6000), opening('o1', [{ fromGroupId: 'ys', toGroupId: 'aj', amount: 100 }]),
      voidIt('s1'), voidIt('o1'),
    ]));
    expect(l.balances).toEqual({ ys: 0, aj: 0, m: 0 });
  });

  it('revise replaces the effect and keeps every revision', () => {
    const before = expense('alex', 9000, undefined, { title: 'Dinner' });
    const after = { ...before, amount: 9600, payerId: 'jo', category: 'eating-out' as const };
    const l = reduce(household([add('r1', before, 1000, 'alex'), revise('r1', after, 2000, 'alex')]));
    const r = l.byId.r1;
    expect(r.expense).toEqual(after);
    expect(r.revisions.map((v) => (v.content as ExpenseContent).amount)).toEqual([9000, 9600]);
    expect(r.updatedAt).toBe(2000);
    expect(r.effect).toEqual({ aj: 9600 - 3200, ys: -3200, m: -3200 });
    const edited = r.timeline.find((t) => t.type === 'edited');
    expect(edited).toMatchObject({
      reason: 'fix',
      changes: [
        { field: 'amount', from: '€90.00', to: '€96.00' },
        { field: 'payer', from: 'Alex', to: 'Jo' },
        { field: 'category', from: 'Groceries', to: 'Eating out' },
      ],
    });
  });

  it('revising a split reports the split change', () => {
    const before = expense('ari', 1000);
    const after = { ...before, split: { mode: 'exact', shares: { ys: 400, aj: 600 } } as Split };
    const r = reduce(household([add('r1', before), revise('r1', after)])).byId.r1;
    expect(r.effect).toEqual({ ys: 600, aj: -600 });
    const edited = r.timeline.find((t) => t.type === 'edited');
    expect(edited && edited.type === 'edited' && edited.changes).toEqual([
      { field: 'split', from: 'Equal: You + Sam, Alex + Jo, Mia', to: 'You + Sam €4.00, Alex + Jo €6.00' },
    ]);
  });

  it('a voided, revised then restored expense uses the latest content', () => {
    const l = reduce(household([
      add('r1', expense('sam', 900)), voidIt('r1'), restore('r1'), revise('r1', expense('sam', 300), 5000),
    ]));
    expect(l.balances).toEqual({ ys: 200, aj: -100, m: -100 });
  });

  it('flags a repayment without changing its effect', () => {
    const l = reduce(household([settle('s1', 'ys', 'aj', 6000), flag('s1')]));
    expect(l.byId.s1.flagged).toBe(true);
    expect(l.balances.ys).toBe(6000);
  });

  it('a correction of a flagged repayment goes the other way and cannot exceed it', () => {
    const h = household([settle('s1', 'ys', 'aj', 6000), flag('s1'), settle('c1', 'aj', 'ys', 4000, 5000, 'ari', 's1')]);
    expect(reduce(h).balances).toEqual({ ys: 2000, aj: -2000, m: 0 });
    expect(codeOf(h, settle('c2', 'aj', 'ys', 2000, 6000, 'ari', 's1'))).toBeNull();
    expect(codeOf(h, settle('c2', 'aj', 'ys', 2001, 6000, 'ari', 's1'))).toBe('invalid-reversal');
    expect(codeOf(h, settle('c2', 'ys', 'aj', 100, 6000, 'ari', 's1'))).toBe('invalid-reversal');
    expect(codeOf(h, voidIt('s1'))).toBe('has-reversals');
    const unflagged = household([settle('s1', 'ys', 'aj', 6000)]);
    expect(codeOf(unflagged, settle('c1', 'aj', 'ys', 100, 6000, 'ari', 's1'))).toBe('invalid-reversal');
  });
});

describe('timeline', () => {
  it('merges seen entries and sorts by time', () => {
    const e1 = add('r1', expense('sam', 900), 1000, 'sam');
    const e2 = voidIt('r1', 3000);
    const h: Household = { ...household([e1, e2]), seen: { [e1.id]: { ari: 2000, jo: 5000 }, [e2.id]: { sam: 4000 }, unknown: { ari: 1 } } as Household['seen'] };
    const t = reduce(h).byId.r1.timeline;
    expect(t.map((x) => [x.type, x.at])).toEqual([['added', 1000], ['seen', 2000], ['voided', 3000], ['seen', 4000], ['seen', 5000]]);
    expect(t[1]).toEqual({ type: 'seen', at: 2000, personId: 'ari', eventId: e1.id });
  });

  it('orders records by creation time', () => {
    const l = reduce(household([add('late', expense('sam', 100), 9000), add('early', expense('sam', 100), 1000)]));
    expect(l.records.map((r) => r.id)).toEqual(['early', 'late']);
  });
});

describe('validation', () => {
  const base = household([add('r1', expense('sam', 900)), settle('s1', 'ys', 'aj', 500), opening('o1', [{ fromGroupId: 'ys', toGroupId: 'aj', amount: 100 }])]);
  const cases: [string, LedgerEvent, string][] = [
    ['unknown record (revise)', revise('nope', expense('sam', 1)), 'unknown-record'],
    ['unknown record (void)', voidIt('nope'), 'unknown-record'],
    ['revising a repayment', revise('s1', expense('sam', 1)), 'wrong-record-kind'],
    ['revising an opening balance', revise('o1', expense('sam', 1)), 'wrong-record-kind'],
    ['flagging an expense', flag('r1'), 'wrong-record-kind'],
    ['zero amount', add('r2', expense('sam', 0)), 'invalid-amount'],
    ['negative amount', add('r2', expense('sam', -100)), 'invalid-amount'],
    ['fractional cents', add('r2', expense('sam', 10.5)), 'non-integer-amount'],
    ['NaN amount', add('r2', expense('sam', Number.NaN)), 'non-integer-amount'],
    ['huge amount', add('r2', expense('sam', 1e13)), 'amount-too-large'],
    ['zero repayment', settle('s2', 'ys', 'aj', 0), 'invalid-amount'],
    ['fractional repayment', settle('s2', 'ys', 'aj', 0.5), 'non-integer-amount'],
    ['zero opening', opening('o2', [{ fromGroupId: 'ys', toGroupId: 'aj', amount: 0 }]), 'invalid-amount'],
    ['unknown payer', add('r2', expense('zoe', 100)), 'unknown-person'],
    ['unknown author', add('r2', expense('sam', 100), 1000, 'zoe'), 'unknown-person'],
    ['unknown group in equal split', add('r2', expense('sam', 100, { mode: 'equal', groupIds: ['ys', 'zz'], weighting: 'group' })), 'unknown-group'],
    ['unknown group in exact split', add('r2', expense('sam', 100, { mode: 'exact', shares: { zz: 100 } })), 'unknown-group'],
    ['unknown group in repayment', settle('s2', 'ys', 'zz', 100), 'unknown-group'],
    ['unknown group in opening', opening('o2', [{ fromGroupId: 'zz', toGroupId: 'aj', amount: 100 }]), 'unknown-group'],
    ['exact shares not summing', add('r2', expense('sam', 100, { mode: 'exact', shares: { ys: 50, aj: 49 } })), 'split-mismatch'],
    ['negative exact share', add('r2', expense('sam', 100, { mode: 'exact', shares: { ys: 150, aj: -50 } })), 'invalid-split'],
    ['empty equal split', add('r2', expense('sam', 100, { mode: 'equal', groupIds: [], weighting: 'group' })), 'invalid-split'],
    ['duplicate group in split', add('r2', expense('sam', 100, { mode: 'equal', groupIds: ['ys', 'ys'], weighting: 'group' })), 'invalid-split'],
    ['repayment to itself', settle('s2', 'ys', 'ys', 100), 'same-group'],
    ['opening to itself', opening('o2', [{ fromGroupId: 'aj', toGroupId: 'aj', amount: 100 }]), 'same-group'],
    ['empty opening', opening('o2', []), 'empty-opening'],
    ['restore without void', restore('r1'), 'not-voided'],
    ['void without a reason', voidIt('r1', 3000, '   '), 'missing-reason'],
    ['record id reused', add('s1', expense('sam', 100)), 'duplicate-record'],
    ['bad date', add('r2', expense('sam', 100, undefined, { date: '13/10/2026' })), 'invalid-date'],
    ['bad category', add('r2', expense('sam', 100, undefined, { category: 'pets' as never })), 'invalid-category'],
  ];
  for (const [name, event, code] of cases) {
    it(`rejects ${name} with ${code}`, () => {
      expect(() => validateEvent(base, event)).toThrow(LedgerError);
      expect(codeOf(base, event)).toBe(code);
    });
  }

  it('rejects double void, revising a voided expense and double flags', () => {
    const voided = { ...base, events: [...base.events, voidIt('r1')] };
    expect(codeOf(voided, voidIt('r1', 5000))).toBe('already-voided');
    expect(codeOf(voided, revise('r1', expense('sam', 1)))).toBe('record-voided');
    const flagged = { ...base, events: [...base.events, flag('s1')] };
    expect(codeOf(flagged, flag('s1', 6000))).toBe('already-flagged');
  });

  it('rejects a repeated event id', () => {
    const e = add('r9', expense('sam', 100));
    const h = { ...base, events: [...base.events, e] };
    expect(codeOf(h, { ...add('r10', expense('sam', 100)), id: e.id })).toBe('duplicate-event');
  });

  it('rejects an inconsistent household', () => {
    const h = base;
    const broken = { ...h, people: h.people.map((p) => (p.id === 'mia' ? { ...p, groupId: 'ys' } : p)) };
    expect(() => reduce(broken)).toThrow(expect.objectContaining({ code: 'invalid-household' }));
  });

  it('reports the failing event id and does not mutate the household', () => {
    const bad = settle('s2', 'ys', 'ys', 100);
    const snapshot = JSON.stringify(base);
    try {
      validateEvent(base, bad);
      expect.unreachable();
    } catch (e) {
      expect((e as LedgerError).eventId).toBe(bad.id);
    }
    expect(JSON.stringify(base)).toBe(snapshot);
    expect(validateEvent(base, add('r2', expense('sam', 100)))).toBeUndefined();
  });

  it('reduce throws on invalid history (no silent skips)', () => {
    expect(() => reduce(household([add('r1', expense('sam', 900)), voidIt('r1'), voidIt('r1', 4000)])))
      .toThrow(expect.objectContaining({ code: 'already-voided' }));
  });
});

describe('zero-sum invariant under random event sequences', () => {
  type Oracle = { kind: 'expense' | 'settlement' | 'opening'; voided: boolean; flagged: boolean; effect: Record<string, Cents>; settlement?: { from: string; to: string; amount: number; reversalOf?: string } };

  // Independent re-implementation of the money rules for cross-checking.
  function oracleEffect(h: Household, c: ExpenseContent): Record<string, Cents> {
    const payerGroup = h.people.find((p) => p.id === c.payerId)!.groupId;
    const parts: [string, number][] = c.split.mode === 'exact'
      ? Object.entries(c.split.shares)
      : (() => {
        const split = c.split as Extract<Split, { mode: 'equal' }>;
        const w = split.groupIds.map((g) => (split.weighting === 'person' ? h.groups.find((x) => x.id === g)!.memberIds.length : 1));
        const W = w.reduce((a, b) => a + b, 0);
        let used = 0;
        return split.groupIds.map((g, i): [string, number] => {
          const part = i === w.length - 1 ? c.amount - used : Math.floor((c.amount * w[i]) / W);
          used += part;
          return [g, part];
        });
      })();
    const e: Record<string, Cents> = { [payerGroup]: c.amount };
    for (const [g, p] of parts) e[g] = (e[g] ?? 0) - p;
    return e;
  }

  it('holds for 500 seeded cases and matches an independent oracle', () => {
    const groups = ['ys', 'aj', 'm'];
    const people = ['ari', 'sam', 'alex', 'jo', 'mia'];
    let rejected = 0;
    for (let seed = 1; seed <= 500; seed++) {
      const r = prng(seed);
      let h = household();
      const oracle = new Map<string, Oracle>();
      const steps = r.int(1, 30);
      let t = 1000;
      for (let s = 0; s < steps; s++) {
        t += r.int(1, 100000);
        const by = r.pick(people);
        const randomSplit = (amount: number): Split => {
          const roll = r.next();
          if (roll < 0.6) {
            const ids = groups.filter(() => r.next() < 0.7);
            const list = ids.length ? ids : [r.pick(groups)];
            return { mode: 'equal', groupIds: r.next() < 0.5 ? list : [...list].reverse(), weighting: r.next() < 0.5 ? 'group' : 'person' };
          }
          const a = r.int(0, amount);
          const b = r.int(0, amount - a);
          const shares: Record<string, number> = { ys: a, aj: b, m: amount - a - b };
          if (roll > 0.95) shares.m += 1; // deliberately wrong sum
          return { mode: 'exact', shares };
        };
        const randomExpense = (): ExpenseContent => {
          const amount = r.next() < 0.03 ? r.pick([0, -5, 12.5]) : r.int(1, 500000);
          return { payerId: r.pick(people), amount, date: '2026-10-01', category: 'other', split: randomSplit(Math.max(1, Math.floor(amount))) };
        };
        const ids = [...oracle.keys()];
        const expenses = ids.filter((id) => oracle.get(id)!.kind === 'expense');
        const settlements = ids.filter((id) => oracle.get(id)!.kind === 'settlement');
        const voided = ids.filter((id) => oracle.get(id)!.voided);
        const roll = r.next();
        let event: LedgerEvent;
        if (roll < 0.35) {
          event = { id: eid(), at: t, by, kind: 'expenseAdded', recordId: `x${s}`, content: randomExpense() };
        } else if (roll < 0.45) {
          const from = r.pick(groups);
          const to = r.next() < 0.05 ? from : r.pick(groups.filter((g) => g !== from));
          event = { id: eid(), at: t, by, kind: 'settlementRecorded', recordId: `x${s}`, content: { fromGroupId: from, toGroupId: to, amount: r.int(1, 100000), date: '2026-10-02' } };
        } else if (roll < 0.5) {
          event = opening(`x${s}`, [{ fromGroupId: 'ys', toGroupId: r.pick(['aj', 'm']), amount: r.int(1, 90000) }, { fromGroupId: 'm', toGroupId: 'aj', amount: r.int(1, 90000) }], t, by);
        } else if (roll < 0.65 && expenses.length) {
          event = { id: eid(), at: t, by, kind: 'expenseRevised', recordId: r.pick(expenses), content: randomExpense() };
        } else if (roll < 0.78 && ids.length) {
          event = voidIt(r.pick(ids), t, r.next() < 0.05 ? '' : 'Mistake', by);
        } else if (roll < 0.88 && (voided.length || ids.length)) {
          event = restore(r.pick(voided.length && r.next() < 0.8 ? voided : ids), t, by);
        } else if (roll < 0.94 && settlements.length) {
          event = flag(r.pick(settlements), t, by);
        } else if (settlements.length) {
          const target = oracle.get(r.pick(settlements))!;
          const sid = [...oracle.entries()].find(([, v]) => v === target)![0];
          const amt = r.int(1, target.settlement!.amount);
          event = settle(`x${s}`, target.settlement!.to, target.settlement!.from, amt, t, by, sid);
        } else {
          event = revise('missing', randomExpense(), t, by);
        }

        // Independent acceptance rules.
        const expectOk = (() => {
          const o = 'recordId' in event ? oracle.get(event.recordId) : undefined;
          const validExpense = (c: ExpenseContent) => Number.isInteger(c.amount) && c.amount > 0
            && (c.split.mode === 'equal' || sum(c.split.shares) === c.amount);
          switch (event.kind) {
            case 'expenseAdded': return !o && validExpense(event.content);
            case 'expenseRevised': return !!o && o.kind === 'expense' && !o.voided && validExpense(event.content);
            case 'openingBalanceSet': return !o;
            case 'settlementRecorded': {
              if (o || event.content.fromGroupId === event.content.toGroupId) return false;
              const rev = event.content.reversalOf;
              if (rev === undefined) return true;
              const target = oracle.get(rev)!;
              let used = event.content.amount;
              for (const v of oracle.values()) if (!v.voided && v.settlement?.reversalOf === rev) used += v.settlement.amount;
              return target.flagged && !target.voided && used <= target.settlement!.amount;
            }
            case 'recordVoided': {
              if (!o || o.voided || event.reason.trim() === '') return false;
              const recordId = event.recordId;
              return ![...oracle.values()].some((v) => !v.voided && v.settlement?.reversalOf === recordId);
            }
            case 'recordRestored': {
              if (!o || !o.voided) return false;
              const rev = o.settlement?.reversalOf;
              if (rev === undefined) return true;
              const target = oracle.get(rev)!;
              let used = o.settlement!.amount;
              for (const v of oracle.values()) if (v !== o && !v.voided && v.settlement?.reversalOf === rev) used += v.settlement.amount;
              return target.flagged && !target.voided && used <= target.settlement!.amount;
            }
            case 'settlementFlagged': return !!o && o.kind === 'settlement' && !o.voided && !o.flagged;
          }
          return false;
        })();

        const error = checkEvent(h, event);
        expect(error === null, `seed ${seed} step ${s} ${event.kind}: ${error?.code}`).toBe(expectOk);
        if (error) { rejected++; continue; }
        h = { ...h, events: [...h.events, event] };

        switch (event.kind) {
          case 'expenseAdded': oracle.set(event.recordId, { kind: 'expense', voided: false, flagged: false, effect: oracleEffect(h, event.content) }); break;
          case 'expenseRevised': oracle.get(event.recordId)!.effect = oracleEffect(h, event.content); break;
          case 'settlementRecorded': {
            const c = event.content;
            oracle.set(event.recordId, { kind: 'settlement', voided: false, flagged: false, effect: { [c.fromGroupId]: c.amount, [c.toGroupId]: -c.amount }, settlement: { from: c.fromGroupId, to: c.toGroupId, amount: c.amount, reversalOf: c.reversalOf } });
            break;
          }
          case 'openingBalanceSet': {
            const e: Record<string, Cents> = {};
            for (const x of event.content.entries) {
              e[x.fromGroupId] = (e[x.fromGroupId] ?? 0) - x.amount;
              e[x.toGroupId] = (e[x.toGroupId] ?? 0) + x.amount;
            }
            oracle.set(event.recordId, { kind: 'opening', voided: false, flagged: false, effect: e });
            break;
          }
          case 'recordVoided': oracle.get(event.recordId)!.voided = true; break;
          case 'recordRestored': oracle.get(event.recordId)!.voided = false; break;
          case 'settlementFlagged': oracle.get(event.recordId)!.flagged = true; break;
        }
      }

      const ledger = reduce(h);
      expect(sum(ledger.balances)).toBe(0);
      expect(Object.keys(ledger.balances).sort()).toEqual([...groups].sort());
      const expected: Record<string, number> = { ys: 0, aj: 0, m: 0 };
      for (const o of oracle.values()) {
        if (o.voided) continue;
        for (const [g, v] of Object.entries(o.effect)) expected[g] += v;
      }
      expect(ledger.balances).toEqual(expected);
      for (const rec of ledger.records) {
        expect(sum(rec.effect)).toBe(0);
        if (rec.voided) expect(rec.effect).toEqual({});
      }
      for (const g of groups) {
        const lines = explain(ledger, h, g);
        expect(lines.length ? lines[lines.length - 1].running : 0).toBe(ledger.balances[g]);
      }
      const plan = planSettlement(ledger.balances);
      expect(plan.status).toBe('exact');
      if (plan.status === 'exact') {
        const after = { ...ledger.balances };
        for (const tr of plan.transfers) { after[tr.fromGroupId] += tr.amount; after[tr.toGroupId] -= tr.amount; }
        expect(Object.values(after).every((v) => v === 0)).toBe(true);
      }
    }
    expect(rejected).toBeGreaterThan(50); // the generator does exercise invalid events
  });
});
