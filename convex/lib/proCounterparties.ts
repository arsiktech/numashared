// The owner's position against each other unit, from the same nets get_balances returns.
// Positive minor units means that unit is owed money. A transfer the owner pays is negative
// here (the owner owes that counterparty); a transfer the owner receives is positive.
import { planSettlement } from "./settlementPlan";

export type BalanceUnit = {
  unitId: string;
  label: string;
  /** Integer minor units, as get_balances returns them. */
  minorUnits: string;
  includesYou: boolean;
};

export type CounterpartyLine = {
  unitId: string;
  label: string;
  /** The owner's net with this unit. Negative means the owner owes them. */
  minorUnits: string;
};

export type CounterpartyReading =
  | { status: "ok"; yourMinorUnits: string; counterparties: CounterpartyLine[] }
  | { status: "unavailable" };

const INTEGER = /^-?\d{1,15}$/;

/** One line per counterparty the settlement plan pairs with the owner's units. */
export function counterpartiesFor(units: readonly BalanceUnit[]): CounterpartyReading {
  const yours = units.filter((unit) => unit.includesYou);
  if (yours.length === 0) return { status: "unavailable" };
  const balances: Record<string, number> = {};
  const labels = new Map<string, string>();
  let yourNet = 0n;
  for (const unit of units) {
    if (!INTEGER.test(unit.minorUnits)) return { status: "unavailable" };
    const minor = BigInt(unit.minorUnits);
    if (!Number.isSafeInteger(Number(minor))) return { status: "unavailable" };
    balances[unit.unitId] = (balances[unit.unitId] ?? 0) + Number(minor);
    if (!labels.has(unit.unitId)) labels.set(unit.unitId, unit.label);
    if (unit.includesYou) yourNet += minor;
  }
  const yourIds = new Set(yours.map((unit) => unit.unitId));
  let plan;
  try {
    plan = planSettlement(balances);
  } catch {
    return { status: "unavailable" };
  }
  if (plan.status !== "exact") return { status: "unavailable" };
  const nets = new Map<string, bigint>();
  for (const transfer of plan.transfers) {
    const fromYou = yourIds.has(transfer.fromGroupId);
    const toYou = yourIds.has(transfer.toGroupId);
    if (fromYou === toYou) continue;
    const unitId = fromYou ? transfer.toGroupId : transfer.fromGroupId;
    const signed = BigInt(transfer.amount) * (fromYou ? -1n : 1n);
    nets.set(unitId, (nets.get(unitId) ?? 0n) + signed);
  }
  const counterparties = [...nets]
    .filter(([, amount]) => amount !== 0n)
    .map(([unitId, amount]) => ({ unitId, label: labels.get(unitId) ?? "Unknown", minorUnits: amount.toString() }))
    .sort((a, b) => (a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0));
  const sided = counterparties.reduce((sum, line) => sum + BigInt(line.minorUnits), 0n);
  if (sided !== yourNet) return { status: "unavailable" };
  return { status: "ok", yourMinorUnits: yourNet.toString(), counterparties };
}
