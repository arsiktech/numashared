// "Why is my balance this?": one group's records, in order, with the change and running balance.
import { contentEffect } from './ledger';
import { categoryLabel, groupName, personName } from './names';
import type { ExplainLine, Group, Household, ID, Ledger, LedgerRecord } from './types';

export { categoryLabel } from './names';

/** "Dinner together" (custom title), else the category label; "Repayment"; "Opening balance". */
export function recordLabel(record: LedgerRecord): string {
  if (record.expense) return record.expense.title?.trim() || categoryLabel(record.expense.category);
  if (record.settlement) return 'Repayment';
  return 'Opening balance';
}

function detail(record: LedgerRecord, household: Household, groupId: ID): string {
  const viewer = household.youId;
  const name = (id: ID) => {
    const g = household.groups.find((x: Group) => x.id === id);
    return g ? groupName(g, household.people, viewer) : 'a removed group';
  };
  const parts: string[] = [];
  if (record.expense) {
    parts.push(`${personName(record.expense.payerId, household.people, viewer)} paid`);
  } else if (record.settlement) {
    const { fromGroupId, toGroupId } = record.settlement;
    if (groupId === fromGroupId) parts.push(`to ${name(toGroupId)}`);
    else if (groupId === toGroupId) parts.push(`from ${name(fromGroupId)}`);
    else parts.push(`from ${name(fromGroupId)} to ${name(toGroupId)}`);
    if (record.settlement.reversalOf) parts.push('correction');
  } else if (record.opening) {
    const entries = record.opening.entries;
    parts.push(entries.length === 1
      ? `${name(entries[0].fromGroupId)} owed ${name(entries[0].toGroupId)}`
      : `${entries.length} starting balances`);
  }
  if (record.revisions.length > 1) parts.push('edited');
  if (record.flagged) parts.push('flagged');
  if (record.voided) parts.push('voided');
  return parts.join(' · ');
}

function recordDate(record: LedgerRecord): string {
  return record.expense?.date ?? record.settlement?.date ?? record.opening?.date ?? '';
}

/**
 * Every record that involves `groupId`, in ledger order (by creation time), with its change to
 * that group and the balance after it. Voided records stay in the list with change 0. The last
 * running value equals ledger.balances[groupId].
 */
export function explain(ledger: Ledger, household: Household, groupId: ID): ExplainLine[] {
  const lines: ExplainLine[] = [];
  let running = 0;
  for (const record of ledger.records) {
    const involved = record.voided ? contentEffect(household, record) : record.effect;
    if (!(groupId in involved)) continue;
    const change = record.voided ? 0 : record.effect[groupId];
    running += change;
    lines.push({
      recordId: record.id,
      at: record.createdAt,
      date: recordDate(record),
      label: recordLabel(record),
      detail: detail(record, household, groupId),
      change,
      running,
      voided: record.voided,
    });
  }
  return lines;
}
