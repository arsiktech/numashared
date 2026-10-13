import { describe, expect, it } from 'vitest';
import { PlanInputError, planSettlement, STANDARD_PLANNING_LIMITS, transfersFor } from '../plan';
import type { Transfer } from '../types';
import { prng } from './helpers';

function settles(balances: Record<string, number>, transfers: Transfer[]) {
  const after = { ...balances };
  for (const t of transfers) {
    expect(t.amount).toBeGreaterThan(0);
    after[t.fromGroupId] += t.amount;
    after[t.toGroupId] -= t.amount;
  }
  return Object.values(after).every((v) => v === 0);
}

/** Independent oracle: min transfers = active units − max number of disjoint zero-sum subsets. */
function minimumTransfers(values: number[]): number {
  const v = values.filter((x) => x !== 0);
  const n = v.length;
  const sums = new Array<number>(1 << n).fill(0);
  const dp = new Array<number>(1 << n).fill(0);
  for (let mask = 1; mask < 1 << n; mask++) {
    const low = Math.log2(mask & -mask);
    sums[mask] = sums[mask & (mask - 1)] + v[low];
    let best = 0;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) best = Math.max(best, dp[mask ^ (1 << i)]);
    dp[mask] = best + (sums[mask] === 0 ? 1 : 0);
  }
  return n - dp[(1 << n) - 1];
}

describe('planSettlement', () => {
  it('(a) You + Sam −58.20, Alex + Jo +71.40, Mia −13.20: exactly 2 transfers', () => {
    const balances = { ys: -5820, aj: 7140, m: -1320 };
    const plan = planSettlement(balances);
    expect(plan).toEqual({
      status: 'exact',
      transfers: [
        { fromGroupId: 'ys', toGroupId: 'aj', amount: 5820 },
        { fromGroupId: 'm', toGroupId: 'aj', amount: 1320 },
      ],
    });
  });

  it('(b) five singles +34 / −22 / +12 / −34 / +10: 3 transfers', () => {
    const balances = { a: 3400, b: -2200, c: 1200, d: -3400, e: 1000 };
    const plan = planSettlement(balances);
    expect(plan).toEqual({
      status: 'exact',
      transfers: [
        { fromGroupId: 'd', toGroupId: 'a', amount: 3400 },
        { fromGroupId: 'b', toGroupId: 'c', amount: 1200 },
        { fromGroupId: 'b', toGroupId: 'e', amount: 1000 },
      ],
    });
    expect(minimumTransfers(Object.values(balances))).toBe(3);
  });

  it('beats a greedy largest-to-largest matcher where pairing matters', () => {
    const greedy = (values: number[]) => {
      const v = [...values];
      let count = 0;
      for (;;) {
        const d = v.indexOf(Math.min(...v));
        const c = v.indexOf(Math.max(...v));
        if (v[d] === 0) return count;
        const amount = Math.min(-v[d], v[c]);
        v[d] += amount;
        v[c] -= amount;
        count++;
      }
    };
    // Greedy pays −7 to +5 first and needs 4 transfers; the exact plan pairs 5 with −5 and needs 3.
    const values = [5, 4, 3, -5, -7];
    expect(greedy(values)).toBe(4);
    expect(minimumTransfers(values)).toBe(3);
    const balances = Object.fromEntries(values.map((x, i) => [`g${i}`, x]));
    const plan = planSettlement(balances);
    expect(plan.status === 'exact' && plan.transfers.length).toBe(3);
    expect(plan.status === 'exact' && settles(balances, plan.transfers)).toBe(true);
  });

  it('is empty when everyone is square, and ignores zero balances', () => {
    expect(planSettlement({})).toEqual({ status: 'exact', transfers: [] });
    expect(planSettlement({ a: 0, b: 0 })).toEqual({ status: 'exact', transfers: [] });
    expect(planSettlement({ a: 0, b: -5, c: 5 })).toEqual({ status: 'exact', transfers: [{ fromGroupId: 'b', toGroupId: 'c', amount: 5 }] });
  });

  it('breaks ties deterministically by id, independent of key order', () => {
    const a = planSettlement({ x: -100, b: 50, a: 50 });
    const b = planSettlement({ a: 50, b: 50, x: -100 });
    expect(a).toEqual(b);
    expect(a).toEqual({
      status: 'exact',
      transfers: [
        { fromGroupId: 'x', toGroupId: 'a', amount: 50 },
        { fromGroupId: 'x', toGroupId: 'b', amount: 50 },
      ],
    });
  });

  it('matches the brute-force minimum on 400 random small cases', () => {
    const r = prng(42);
    for (let i = 0; i < 400; i++) {
      const n = r.int(2, 7);
      const values = Array.from({ length: n - 1 }, () => (r.next() < 0.3 ? r.pick([-1000, 1000, 500, -500]) : r.int(-5000, 5000)));
      values.push(-values.reduce((a, b) => a + b, 0));
      const balances = Object.fromEntries(values.map((v, k) => [`g${k}`, v]));
      const plan = planSettlement(balances);
      expect(plan.status).toBe('exact');
      if (plan.status !== 'exact') continue;
      expect(settles(balances, plan.transfers)).toBe(true);
      expect(plan.transfers.length).toBe(minimumTransfers(values));
      expect(planSettlement(balances)).toEqual(plan);
    }
  });

  it('(c) returns unavailable past its limits instead of guessing', () => {
    const balances = { ys: -5820, aj: 7140, m: -1320 };
    expect(planSettlement(balances, { ...STANDARD_PLANNING_LIMITS, maxActiveUnits: 2 })).toEqual({ status: 'unavailable' });
    expect(planSettlement(balances, { ...STANDARD_PLANNING_LIMITS, maxExpandedStates: 1 })).toEqual({ status: 'unavailable' });
    expect(planSettlement(balances, { ...STANDARD_PLANNING_LIMITS, maxInspectedBranches: 1 })).toEqual({ status: 'unavailable' });
    expect(planSettlement(balances, { ...STANDARD_PLANNING_LIMITS, maxRecursionDepth: 1 })).toEqual({ status: 'unavailable' });
    // Exactly enough budget still succeeds.
    expect(planSettlement(balances, { ...STANDARD_PLANNING_LIMITS, maxRecursionDepth: 2 }).status).toBe('exact');

    // 129 active units exceed the standard limit outright.
    const many: Record<string, number> = {};
    for (let i = 0; i < 128; i++) many[`u${String(i).padStart(3, '0')}`] = i + 1;
    many.sink = -((128 * 129) / 2);
    expect(planSettlement(many)).toEqual({ status: 'unavailable' });

    // A wide, irregular household exhausts the standard search budget.
    const r = prng(7);
    const wide: Record<string, number> = {};
    let total = 0;
    for (let i = 0; i < 40; i++) {
      const v = (i % 2 ? 1 : -1) * r.int(1000, 99999);
      wide[`w${String(i).padStart(2, '0')}`] = v;
      total += v;
    }
    wide.w99 = -total;
    expect(planSettlement(wide)).toEqual({ status: 'unavailable' });
  });

  it('rejects input the ledger can never produce', () => {
    expect(() => planSettlement({ a: 100, b: -99 })).toThrow(PlanInputError);
    expect(() => planSettlement({ a: 0.5, b: -0.5 })).toThrow(PlanInputError);
  });

  it('transfersFor filters one group', () => {
    const plan = planSettlement({ a: 3400, b: -2200, c: 1200, d: -3400, e: 1000 });
    expect(transfersFor(plan, 'b')).toEqual([
      { fromGroupId: 'b', toGroupId: 'c', amount: 1200 },
      { fromGroupId: 'b', toGroupId: 'e', amount: 1000 },
    ]);
    expect(transfersFor(plan, 'a')).toEqual([{ fromGroupId: 'd', toGroupId: 'a', amount: 3400 }]);
    expect(transfersFor({ status: 'unavailable' }, 'a')).toEqual([]);
  });
});
