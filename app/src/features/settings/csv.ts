// CSV export of a household's ledger: one row per record, voided and edited ones included, with
// the edit history and void reason in the note. Amounts are exact decimal strings from cents.
import { categoryLabel, currencyDigits, groupName } from '@/core';
import type { Household, ID, LedgerRecord } from '@/core/types';
import { ledgerOf } from '@/store/store';

export type Range = 'month' | 'all';

const HEADER = ['date', 'what', 'category', 'amount', 'paid_by', 'split', 'status', 'note', 'recorded_by'];

/** 5280 -> "52.80" (EUR), 1200 -> "1200" (JPY). No grouping separators, so spreadsheets read it. */
export function plainAmount(cents: number, currency: string) {
  const d = currencyDigits(currency);
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const scale = 10 ** d;
  const whole = Math.floor(abs / scale);
  const frac = d ? `.${String(abs % scale).padStart(d, '0')}` : '';
  return `${neg ? '-' : ''}${whole}${frac}`;
}

const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

function recordDate(r: LedgerRecord) {
  return r.expense?.date ?? r.settlement?.date ?? r.opening?.date ?? '';
}

export function recordsInRange(h: Household, range: Range, now = new Date()) {
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return ledgerOf(h).records
    .filter((r) => range === 'all' || recordDate(r).startsWith(month))
    .sort((a, b) => (recordDate(b).localeCompare(recordDate(a))) || b.createdAt - a.createdAt);
}

export function buildCsv(h: Household, records: LedgerRecord[]) {
  // Real names throughout: an export is read outside the app, where "You" means nothing.
  const person = (id: ID) => h.people.find((p) => p.id === id)?.name ?? 'Someone';
  const group = (id: ID) => {
    const g = h.groups.find((x) => x.id === id);
    return g ? groupName(g, h.people, '') : 'Unknown group';
  };
  const amt = (c: number) => plainAmount(c, h.currency);
  const rows = records.map((r) => {
    const notes: string[] = [];
    let what = '', category = '', amount = 0, paidBy = '', split = '';
    if (r.kind === 'expense') {
      const e = r.expense!;
      what = e.title || categoryLabel(e.category);
      category = categoryLabel(e.category);
      amount = e.amount;
      paidBy = person(e.payerId);
      split = e.split.mode === 'equal'
        ? `equal${e.split.weighting === 'person' ? ' per person' : ''}: ${e.split.groupIds.map(group).join(' / ')}`
        : `exact: ${Object.entries(e.split.shares).map(([g, c]) => `${group(g)} ${amt(c)}`).join(' / ')}`;
      if (e.note) notes.push(e.note);
    } else if (r.kind === 'settlement') {
      const s = r.settlement!;
      what = 'Repayment';
      category = 'Repayment';
      amount = s.amount;
      paidBy = group(s.fromGroupId);
      split = `to ${group(s.toGroupId)}${s.method ? ` by ${s.method}` : ''}`;
      if (s.note) notes.push(s.note);
      if (r.flagged) notes.push('Flagged as not received');
    } else {
      const o = r.opening!;
      what = 'Opening balance';
      category = 'Opening balance';
      amount = o.entries.reduce((a, x) => a + x.amount, 0);
      paidBy = o.entries.map((x) => group(x.fromGroupId)).join(' / ');
      split = `owed to ${o.entries.map((x) => `${group(x.toGroupId)} ${amt(x.amount)}`).join(' / ')}`;
      if (o.note) notes.push(o.note);
    }
    for (const t of r.timeline) {
      if (t.type === 'edited') {
        const change = t.changes.map((ch) => `${ch.field} ${ch.from} -> ${ch.to}`).join(', ');
        notes.push(`Edited by ${person(t.by)}${change ? `: ${change}` : ''}${t.reason ? ` (${t.reason})` : ''}`);
      }
      if (t.type === 'voided') notes.push(`Voided by ${person(t.by)}: ${t.reason}`);
      if (t.type === 'restored') notes.push(`Restored by ${person(t.by)}`);
    }
    const status = r.voided ? 'voided' : r.revisions.length > 1 ? 'edited' : 'shared';
    return [recordDate(r), what, category, amt(amount), paidBy, split, status, notes.join('; '), person(r.createdBy)];
  });
  return [HEADER, ...rows].map((row) => row.map(cell).join(',')).join('\n');
}

export const csvFileName = (h: Household) =>
  `numa-shared-${h.name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'household'}.csv`;
