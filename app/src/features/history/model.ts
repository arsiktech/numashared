// The history as a conversation: records become bubbles, repayment cards or system lines, and every
// later change (edit, void, restore, flag) becomes its own centered line at the time it happened.
import { categoryLabel, formatMoney } from '@/core';
import type { FieldChange, Household, ID, LedgerRecord, PaymentMethod } from '@/core/types';
import { groupOfPerson, yourGroup } from '@/store/store';
import { nameOf, personName, recordTitle } from '../hooks';

export type Filter = 'all' | 'expenses' | 'repayments' | 'changes';
export const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'expenses', label: 'Expenses' },
  { id: 'repayments', label: 'Repayments' },
  { id: 'changes', label: 'Changes' },
];

export type ThreadItem =
  | { kind: 'expense'; key: string; at: number; record: LedgerRecord }
  | { kind: 'repayment'; key: string; at: number; record: LedgerRecord }
  | { kind: 'opening'; key: string; at: number; record: LedgerRecord }
  | { kind: 'change'; key: string; at: number; record: LedgerRecord; text: string };

export const METHOD_LABEL: Record<PaymentMethod, string> = { bizum: 'Bizum', bank: 'Bank transfer', cash: 'Cash', other: 'Other' };

/** "You", "Alex", "You and Sam", "Alex, Jo and Mia". */
export function joinNames(names: string[]) {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** "Split equally", "Split per person", "Split by amount". */
export function splitLabel(r: LedgerRecord) {
  const s = r.expense!.split;
  if (s.mode === 'exact') return 'Split by amount';
  return s.weighting === 'person' ? 'Split per person' : 'Split equally';
}

/** Whether the record sits on your side of the conversation (your group paid or repaid). */
export function isMine(h: Household, r: LedgerRecord) {
  const mine = yourGroup(h).id;
  if (r.expense) return groupOfPerson(h, r.expense.payerId).id === mine;
  if (r.settlement) return r.settlement.fromGroupId === mine;
  return false;
}

/** People other than the author who have seen the record's first event: "Alex", "everyone". */
export function seenBy(h: Household, r: LedgerRecord): string | null {
  const first = r.timeline.find((t) => t.type === 'added');
  if (!first) return null;
  const viewers = Object.keys(h.seen[first.eventId] ?? {}).filter((id) => id !== r.createdBy);
  const others = h.people.filter((p) => p.id !== r.createdBy);
  if (!viewers.length) return null;
  if (others.length > 2 && others.every((p) => viewers.includes(p.id))) return 'everyone';
  return joinNames(h.people.filter((p) => viewers.includes(p.id)).map((p) => personName(h, p.id)));
}

const quote = (s: string) => `“${s}”`;

/** "€90.00 → €96.00", or the fields that changed when the amount did not. */
export function changeSummary(changes: FieldChange[]) {
  const amount = changes.find((c) => c.field === 'amount');
  if (amount) return `${amount.from} → ${amount.to}`;
  const names: Record<FieldChange['field'], string> = {
    amount: 'amount', payer: 'who paid', category: 'category', title: 'name', note: 'note', date: 'date', split: 'split',
  };
  return changes.length ? `changed the ${joinNames(changes.map((c) => names[c.field]))}` : 'no changes';
}

function changeLine(h: Household, r: LedgerRecord, t: LedgerRecord['timeline'][number]): string | null {
  const title = r.kind === 'settlement' ? `the repayment of ${formatMoney(r.settlement!.amount, h.currency)}` : quote(recordTitle(r));
  switch (t.type) {
    case 'edited': return `${personName(h, t.by)} edited ${title}: ${changeSummary(t.changes)}`;
    case 'voided': return `${personName(h, t.by)} voided ${title}: ${t.reason}`;
    case 'restored': return `${personName(h, t.by)} restored ${title}`;
    case 'flagged': return `${personName(h, t.by)} flagged ${title}${t.reason ? `: ${t.reason}` : ''}`;
    default: return null;
  }
}

/** "Opening balance: You + Sam owed Alex + Jo €120.00". */
export function openingLine(h: Household, r: LedgerRecord) {
  const parts = r.opening!.entries.map((e) => `${nameOf(h, e.fromGroupId)} owed ${nameOf(h, e.toGroupId)} ${formatMoney(e.amount, h.currency)}`);
  return `Opening balance: ${parts.join('; ')}`;
}

/** Whether a record matches a search across title, category, note and people. */
export function matches(h: Household, r: LedgerRecord, q: string) {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const hay: string[] = [recordTitle(r)];
  const person = (id: ID) => [personName(h, id), h.people.find((p) => p.id === id)?.name ?? ''];
  hay.push(...person(r.createdBy));
  if (r.expense) {
    hay.push(categoryLabel(r.expense.category), r.expense.note ?? '', ...person(r.expense.payerId), nameOf(h, groupOfPerson(h, r.expense.payerId)));
  }
  if (r.settlement) {
    hay.push(r.settlement.note ?? '', nameOf(h, r.settlement.fromGroupId), nameOf(h, r.settlement.toGroupId),
      r.settlement.method ? METHOD_LABEL[r.settlement.method] : '');
    for (const g of [r.settlement.fromGroupId, r.settlement.toGroupId]) {
      for (const m of h.groups.find((x) => x.id === g)?.memberIds ?? []) hay.push(...person(m));
    }
  }
  if (r.opening) {
    hay.push(r.opening.note ?? '', ...r.opening.entries.flatMap((e) => [nameOf(h, e.fromGroupId), nameOf(h, e.toGroupId)]));
  }
  if (r.voidReason) hay.push(r.voidReason);
  return hay.some((s) => s.toLowerCase().includes(needle));
}

/** Every item of the conversation, oldest first, after the filter and the search. */
export function threadItems(h: Household, records: LedgerRecord[], filter: Filter, q: string): ThreadItem[] {
  const items: ThreadItem[] = [];
  for (const r of records) {
    if (!matches(h, r, q)) continue;
    if (r.kind === 'expense' && (filter === 'all' || filter === 'expenses')) items.push({ kind: 'expense', key: r.id, at: r.createdAt, record: r });
    if (r.kind === 'settlement' && (filter === 'all' || filter === 'repayments')) items.push({ kind: 'repayment', key: r.id, at: r.createdAt, record: r });
    if (r.kind === 'opening' && filter === 'all') items.push({ kind: 'opening', key: r.id, at: r.createdAt, record: r });
    if (filter === 'all' || filter === 'changes') {
      for (const t of r.timeline) {
        const text = changeLine(h, r, t);
        if (text) items.push({ kind: 'change', key: `${r.id}:${'eventId' in t ? t.eventId : t.at}`, at: t.at, record: r, text });
      }
    }
  }
  return items.sort((a, b) => a.at - b.at);
}

const dayStart = (ts: number) => { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };

/** Day separator: "Today", "Yesterday", a weekday this week, else "Fri 10 Oct". */
export function dayLabel(ts: number, now = Date.now()) {
  const diff = Math.round((dayStart(now) - dayStart(ts)) / 86400000);
  const d = new Date(ts);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff > 1 && diff < 7) return d.toLocaleDateString('en-GB', { weekday: 'long' });
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '');
}

export const sameDay = (a: number, b: number) => dayStart(a) === dayStart(b);
