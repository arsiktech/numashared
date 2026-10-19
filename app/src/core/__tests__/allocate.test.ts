import { describe, expect, it } from 'vitest';
import { AllocationError, allocateEqual, shares } from '../allocate';
import { expense, household, sum } from './helpers';

describe('allocateEqual (ported from AllocationTests.swift)', () => {
  it('splits by weight in integer minor units', () => {
    expect(allocateEqual(12000, [{ id: 'am', weight: 2 }, { id: 'sam', weight: 1 }, { id: 'leo', weight: 1 }]))
      .toEqual({ am: 6000, sam: 3000, leo: 3000 });
  });

  it('gives the remainder to the last unit; a single unit gets everything', () => {
    const equal = allocateEqual(10000, [{ id: 'am', weight: 1 }, { id: 'sam', weight: 1 }, { id: 'leo', weight: 1 }]);
    expect(equal).toEqual({ am: 3333, sam: 3333, leo: 3334 });
    expect(allocateEqual(9999, [{ id: 'sam', weight: 1 }])).toEqual({ sam: 9999 });
  });

  it('splits 101 over ten units as 10 x 9 then 11', () => {
    const units = Array.from({ length: 10 }, (_, i) => ({ id: `dynamic-${i}`, weight: 1 }));
    const a = allocateEqual(101, units);
    expect(sum(a)).toBe(101);
    expect(units.slice(0, 9).map((u) => a[u.id])).toEqual(Array(9).fill(10));
    expect(a['dynamic-9']).toBe(11);
  });

  it('puts the whole residual on the last unit, even when more than one cent', () => {
    // floor(2 * 1 / 3) = 0 for the first two; Swift's rule gives the last unit 2.
    expect(allocateEqual(2, [{ id: 'a', weight: 1 }, { id: 'b', weight: 1 }, { id: 'c', weight: 1 }])).toEqual({ a: 0, b: 0, c: 2 });
    expect(allocateEqual(1000, [{ id: 'two', weight: 2 }, { id: 'one', weight: 1 }])).toEqual({ two: 666, one: 334 });
    expect(allocateEqual(0, [{ id: 'a', weight: 1 }, { id: 'b', weight: 1 }])).toEqual({ a: 0, b: 0 });
  });

  it('follows the caller order, not id order', () => {
    expect(allocateEqual(100, [{ id: 'z', weight: 1 }, { id: 'a', weight: 1 }, { id: 'm', weight: 1 }])).toEqual({ z: 33, a: 33, m: 34 });
    expect(allocateEqual(100, [{ id: 'm', weight: 1 }, { id: 'z', weight: 1 }, { id: 'a', weight: 1 }])).toEqual({ m: 33, z: 33, a: 34 });
  });

  it('keeps typed validation errors', () => {
    const code = (f: () => unknown) => {
      try { f(); } catch (e) { return (e as AllocationError).code; }
      return null;
    };
    expect(code(() => allocateEqual(100, [{ id: 'am', weight: 1 }, { id: 'am', weight: 1 }]))).toBe('duplicate-unit');
    expect(code(() => allocateEqual(100, [{ id: 'sam', weight: 0 }]))).toBe('non-positive-weight');
    expect(code(() => allocateEqual(100, [{ id: 'sam', weight: 1.5 }]))).toBe('non-positive-weight');
    expect(code(() => allocateEqual(100, []))).toBe('empty');
    expect(code(() => allocateEqual(-1, [{ id: 'a', weight: 1 }]))).toBe('negative-total');
    expect(code(() => allocateEqual(1.5, [{ id: 'a', weight: 1 }]))).toBe('non-integer-total');
  });

  it('preserves the exact sum across a deterministic fuzz (Swift LCRandom seed)', () => {
    // Same 64-bit LCG as the Swift test.
    let state = 0x4e554d41n;
    const next = () => {
      state = (2862933555777941757n * state + 3037000493n) & 0xffffffffffffffffn;
      return state;
    };
    for (let i = 0; i < 3000; i++) {
      const total = Number(next() % 2000001n);
      const weights = ['am', 'sam', 'leo'].map((id) => ({ id, weight: Number(next() % 9n) + 1 }));
      const a = allocateEqual(total, weights);
      expect(sum(a)).toBe(total);
      for (const v of Object.values(a)) {
        expect(Number.isSafeInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('stays exact for amounts where amount * weight exceeds 2^53', () => {
    const a = allocateEqual(999999999999, [{ id: 'a', weight: 9007 }, { id: 'b', weight: 13 }]);
    expect(sum(a)).toBe(999999999999);
    expect(a.a).toBe(Number((999999999999n * 9007n) / 9020n));
  });
});

describe('shares', () => {
  const h = household();
  it('equal by group gives each listed group weight 1, in listed order', () => {
    expect(shares(expense('ari', 1000), h.groups, h.people)).toEqual({ ys: 333, aj: 333, m: 334 });
    expect(shares(expense('ari', 1000, { mode: 'equal', groupIds: ['m', 'aj', 'ys'], weighting: 'group' }), h.groups, h.people))
      .toEqual({ m: 333, aj: 333, ys: 334 });
  });
  it('equal by person weights each group by its member count', () => {
    expect(shares(expense('ari', 1000, { mode: 'equal', groupIds: ['ys', 'aj', 'm'], weighting: 'person' }), h.groups, h.people))
      .toEqual({ ys: 400, aj: 400, m: 200 });
    expect(shares(expense('ari', 1000, { mode: 'equal', groupIds: ['ys', 'm'], weighting: 'person' }), h.groups, h.people))
      .toEqual({ ys: 666, m: 334 });
  });
  it('exact shares must cover known groups and sum to the amount', () => {
    expect(shares(expense('ari', 1000, { mode: 'exact', shares: { ys: 700, aj: 300 } }), h.groups, h.people)).toEqual({ ys: 700, aj: 300 });
    expect(() => shares(expense('ari', 1000, { mode: 'exact', shares: { ys: 700, aj: 200 } }), h.groups, h.people))
      .toThrow(expect.objectContaining({ code: 'exact-sum-mismatch' }));
    expect(() => shares(expense('ari', 1000, { mode: 'exact', shares: { ys: 700, zz: 300 } }), h.groups, h.people))
      .toThrow(expect.objectContaining({ code: 'unknown-group' }));
    expect(() => shares(expense('ari', 1000, { mode: 'exact', shares: { ys: 1100, aj: -100 } }), h.groups, h.people))
      .toThrow(expect.objectContaining({ code: 'invalid-share' }));
    expect(() => shares(expense('ari', 1000, { mode: 'equal', groupIds: ['ys', 'zz'], weighting: 'group' }), h.groups, h.people))
      .toThrow(AllocationError);
  });
});
