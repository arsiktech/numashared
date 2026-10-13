// Exact minimum-transfer settlement plan, ported from SettlementPlanner.swift.
// Search: take the largest debtor (ties by id), try paying each distinct creditor balance
// (largest first, ties by id) as much as possible, recurse, memoize by state. The best plan has
// the fewest transfers; equal-length plans compare transfer by transfer: larger amount first,
// then from id, then to id. Fixed work limits make the result identical on every device; past
// them the plan is 'unavailable', never a greedy guess.
import type { Cents, ID, PlanOutcome, Transfer } from './types';

export type PlanningLimits = {
  maxActiveUnits: number;
  maxExpandedStates: number;
  maxInspectedBranches: number;
  maxRecursionDepth: number;
};

/** Same values as SettlementPlanningLimits.standard. */
export const STANDARD_PLANNING_LIMITS: Readonly<PlanningLimits> = {
  maxActiveUnits: 128,
  maxExpandedStates: 4096,
  maxInspectedBranches: 32768,
  maxRecursionDepth: 128,
};

/** Thrown for input the ledger can never produce (non-zero sum, non-integer cents). */
export class PlanInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanInputError';
  }
}

class LimitExceeded extends Error {}

function preferred(candidate: Transfer[], current: Transfer[]): boolean {
  if (candidate.length !== current.length) return candidate.length < current.length;
  for (let i = 0; i < candidate.length; i++) {
    const a = candidate[i];
    const b = current[i];
    if (a.amount !== b.amount) return a.amount > b.amount;
    if (a.fromGroupId !== b.fromGroupId) return a.fromGroupId < b.fromGroupId;
    if (a.toGroupId !== b.toGroupId) return a.toGroupId < b.toGroupId;
  }
  return false;
}

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function planSettlement(
  balances: Record<ID, Cents>,
  limits: PlanningLimits = STANDARD_PLANNING_LIMITS,
): PlanOutcome {
  const entries = Object.entries(balances);
  let sum = 0;
  for (const [id, v] of entries) {
    if (!Number.isSafeInteger(v)) throw new PlanInputError(`Balance for ${id} is not integer cents.`);
    sum += v;
  }
  const active = entries.filter(([, v]) => v !== 0);
  if (active.length > limits.maxActiveUnits) return { status: 'unavailable' };
  if (!Number.isSafeInteger(sum) || sum !== 0) throw new PlanInputError('Balances do not sum to zero.');

  active.sort(([a], [b]) => byId(a, b));
  const ids = active.map(([id]) => id);
  const memo = new Map<string, Transfer[]>();
  let expandedStates = 0;
  let inspectedBranches = 0;

  const solve = (values: number[], depth: number): Transfer[] => {
    if (values.every((v) => v === 0)) return [];
    const key = values.join(',');
    const cached = memo.get(key);
    if (cached) return cached;
    if (depth >= limits.maxRecursionDepth) throw new LimitExceeded();
    if (expandedStates >= limits.maxExpandedStates) throw new LimitExceeded();
    expandedStates += 1;

    const indices = values.map((_, i) => i);
    const debtor = indices
      .filter((i) => values[i] < 0)
      .sort((a, b) => (values[a] === values[b] ? byId(ids[a], ids[b]) : values[a] - values[b]))[0];
    if (debtor === undefined) throw new PlanInputError('Balances do not sum to zero.');
    const creditors = indices
      .filter((i) => values[i] > 0)
      .sort((a, b) => (values[a] === values[b] ? byId(ids[a], ids[b]) : values[b] - values[a]));

    let best: Transfer[] | null = null;
    const seen = new Set<number>();
    for (const creditor of creditors) {
      if (inspectedBranches >= limits.maxInspectedBranches) throw new LimitExceeded();
      inspectedBranches += 1;
      // Equal creditor balances are interchangeable; the first (lowest id) wins the tie.
      if (seen.has(values[creditor])) continue;
      seen.add(values[creditor]);
      const amount = Math.min(-values[debtor], values[creditor]);
      const next = values.slice();
      next[debtor] += amount;
      next[creditor] -= amount;
      const candidate = [{ fromGroupId: ids[debtor], toGroupId: ids[creditor], amount }, ...solve(next, depth + 1)];
      if (best === null || preferred(candidate, best)) best = candidate;
    }
    if (best === null) throw new PlanInputError('Balances do not sum to zero.');
    memo.set(key, best);
    return best;
  };

  try {
    return { status: 'exact', transfers: solve(active.map(([, v]) => v), 0) };
  } catch (e) {
    if (e instanceof LimitExceeded) return { status: 'unavailable' };
    throw e;
  }
}

/** The plan's transfers that involve one group (paying or receiving). Empty when unavailable. */
export function transfersFor(plan: PlanOutcome, groupId: ID): Transfer[] {
  if (plan.status !== 'exact') return [];
  return plan.transfers.filter((t) => t.fromGroupId === groupId || t.toGroupId === groupId);
}
