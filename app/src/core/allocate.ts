// Exact integer allocation, ported from Allocation.swift (MinorUnitAllocator).
// Every unit except the last gets floor(total * weight / totalWeight); the last unit in the
// caller's order gets the residual, so the parts always sum exactly to the total.
import type { Cents, ExpenseContent, Group, ID, Person } from './types';

export type AllocationErrorCode =
  | 'empty'
  | 'duplicate-unit'
  | 'negative-total'
  | 'non-integer-total'
  | 'non-positive-weight'
  | 'unknown-group'
  | 'exact-sum-mismatch'
  | 'invalid-share';

export class AllocationError extends Error {
  readonly code: AllocationErrorCode;
  readonly unitId?: ID;
  constructor(code: AllocationErrorCode, message: string, unitId?: ID) {
    super(message);
    this.name = 'AllocationError';
    this.code = code;
    this.unitId = unitId;
  }
}

export type Weight = { id: ID; weight: number };

/** Splits `amount` by weight, remainder to the last id. Sums exactly to `amount`. */
export function allocateEqual(amount: Cents, weights: Weight[]): Record<ID, Cents> {
  if (weights.length === 0) throw new AllocationError('empty', 'Nothing to split between.');
  if (!Number.isSafeInteger(amount)) throw new AllocationError('non-integer-total', `Amount must be integer cents, got ${amount}.`);
  if (amount < 0) throw new AllocationError('negative-total', 'Amount cannot be negative.');

  const seen = new Set<ID>();
  let totalWeight = 0n;
  for (const { id, weight } of weights) {
    if (seen.has(id)) throw new AllocationError('duplicate-unit', `Listed twice: ${id}.`, id);
    seen.add(id);
    if (!Number.isSafeInteger(weight) || weight <= 0) {
      throw new AllocationError('non-positive-weight', `Weight must be a positive integer for ${id}.`, id);
    }
    totalWeight += BigInt(weight);
  }

  const total = BigInt(amount);
  const result: Record<ID, Cents> = {};
  let used = 0n;
  weights.forEach(({ id, weight }, index) => {
    const portion = index === weights.length - 1 ? total - used : (total * BigInt(weight)) / totalWeight;
    used += portion;
    result[id] = Number(portion);
  });
  return result;
}

/**
 * Each group's share of an expense. Equal splits allocate over `split.groupIds` in their listed
 * order (weight 1 per group, or the group's member count when weighting is 'person'); exact
 * splits are validated to cover known groups with non-negative integer cents summing to the amount.
 */
export function shares(content: ExpenseContent, groups: Group[], people: Person[]): Record<ID, Cents> {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const split = content.split;
  if (split.mode === 'equal') {
    const weights = split.groupIds.map((id) => {
      const group = byId.get(id);
      if (!group) throw new AllocationError('unknown-group', `Unknown group ${id}.`, id);
      const weight = split.weighting === 'person'
        ? group.memberIds.filter((m) => people.some((p) => p.id === m)).length
        : 1;
      return { id, weight };
    });
    return allocateEqual(content.amount, weights);
  }

  const entries = Object.entries(split.shares);
  if (entries.length === 0) throw new AllocationError('empty', 'Nothing to split between.');
  let sum = 0;
  const result: Record<ID, Cents> = {};
  for (const [id, share] of entries) {
    if (!byId.has(id)) throw new AllocationError('unknown-group', `Unknown group ${id}.`, id);
    if (!Number.isSafeInteger(share) || share < 0) {
      throw new AllocationError('invalid-share', `Share must be non-negative integer cents for ${id}.`, id);
    }
    sum += share;
    result[id] = share;
  }
  if (sum !== content.amount) {
    throw new AllocationError('exact-sum-mismatch', `Shares add up to ${sum}, not ${content.amount}.`);
  }
  return result;
}
