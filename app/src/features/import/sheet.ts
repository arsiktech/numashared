// Brings a shared-expenses Google Sheet into a new household. The sheet has two tabs:
// - expenses: date, what, category, who paid (a person), amount, note. Each is split equally
//   between the groups.
// - payments: date, which group, amount, details. A positive amount is money that group put in
//   for the other one (a repayment, or something it paid for them); a negative amount is something
//   the other group paid for it.
// Names, groups and categories all come from the sheet itself. Nothing here knows whose sheet it is.
import { reduce } from '../../core/ledger';
import type { Category, Cents, Group, Household, ID, LedgerEvent, Person } from '../../core/types';
import { GROUP_COLORS } from '../../core/types';
import { inviteCode, newId } from '../../store/ids';

// ---------- the link and its tabs ----------

/** The spreadsheet id from any Google Sheets link (edit, view or export). */
export function sheetIdFromLink(link: string): string | null {
  return /\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/.exec(link)?.[1] ?? null;
}

export type Tab = { name: string; gid: string };

/** The tabs listed in the sheet's public "htmlview" page. */
export function tabsFromHtmlView(html: string): Tab[] {
  const tabs: Tab[] = [];
  const re = /\{name: *"((?:[^"\\]|\\.)*)"[^}]*?gid: *"(\d+)"/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const name = JSON.parse(`"${m[1]}"`) as string;
    if (!tabs.some((t) => t.gid === m![2])) tabs.push({ name, gid: m[2] });
  }
  return tabs;
}

/** The sheet's title from its htmlview page, without a trailing "(…)" or " - Google Sheets". */
export function titleFromHtmlView(html: string): string {
  const t = /<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? '';
  return decodeEntities(t).replace(/\s*-\s*Google (Sheets|Drive|Таблицы|Диск).*$/i, '').replace(/\s*\(.*\)\s*$/, '').trim();
}

function decodeEntities(s: string) {
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

export const exportUrl = (id: string, gid: string) => `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
export const htmlViewUrl = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/htmlview`;

// ---------- CSV ----------

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// ---------- recognising the two tabs ----------

const WORDS = {
  date: /^(дата|date|when)$/i,
  what: /^(наименование|название|what|title|merchant|description)$/i,
  category: /^(категория|category)$/i,
  who: /^(кто\??|who\??|paid by|payer|group)$/i,
  amount: /^(сумма|amount|sum|total)$/i,
  details: /^(детали|details|note|notes|comment)$/i,
};

type Columns = Partial<Record<keyof typeof WORDS, number>>;

function columns(header: string[]): Columns {
  const out: Columns = {};
  header.forEach((h, i) => {
    const v = h.trim();
    for (const [k, re] of Object.entries(WORDS) as [keyof typeof WORDS, RegExp][]) {
      if (out[k] === undefined && re.test(v)) out[k] = i;
    }
  });
  return out;
}

export type TabKind = 'expenses' | 'payments';

/** Which of the two tabs this is, from its header row; null for anything else (a summary tab). */
export function tabKind(rows: string[][]): TabKind | null {
  const c = columns(rows[0] ?? []);
  if (c.date === undefined || c.who === undefined || c.amount === undefined) return null;
  if (c.category !== undefined || c.what !== undefined) return 'expenses';
  return 'payments';
}

// ---------- dates and money ----------

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * "Monday, 20 May 2024 г." or "Friday, 24 May at 08:29" (Google Sheets drops the year for the
 * current year's dates when formatted that way). A date without a year takes the year in which that
 * day falls on the named weekday, closest to `near`. Returns null when it can't be read, or when the
 * weekday matches no year near `near` (a stray placeholder date).
 */
export function parseSheetDate(s: string, near: Date): Date | null {
  const m = /^\s*(?:([A-Za-z]+),\s*)?(\d{1,2})\s+([A-Za-z]+)\.?(?:\s+(\d{4}))?(?:\s*г\.)?(?:\s+at\s+(\d{1,2}):(\d{2}))?/i.exec(s);
  if (!m) {
    const iso = /^\s*(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(s);
    if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3], +(iso[4] ?? 12), +(iso[5] ?? 0));
    return null;
  }
  const [, wd, d, mon, y, hh, mm] = m;
  const month = MONTHS[mon.toLowerCase()];
  if (month === undefined) return null;
  const hour = hh ? +hh : 12;
  const minute = mm ? +mm : 0;
  if (y) return new Date(+y, month, +d, hour, minute);
  const weekday = wd ? WEEKDAYS.indexOf(wd.toLowerCase()) : -1;
  const years = [near.getFullYear() - 2, near.getFullYear() - 1, near.getFullYear(), near.getFullYear() + 1]
    .filter((yy) => new Date(yy, month, +d).getMonth() === month)
    .filter((yy) => weekday < 0 || new Date(yy, month, +d).getDay() === weekday)
    .sort((a, b) => Math.abs(new Date(a, month, +d).getTime() - near.getTime()) - Math.abs(new Date(b, month, +d).getTime() - near.getTime()));
  return years.length ? new Date(years[0], month, +d, hour, minute) : null;
}

const SYMBOLS: Record<string, string> = { '€': 'EUR', '$': 'USD', '£': 'GBP', '₽': 'RUB', '₴': 'UAH', 'zł': 'PLN' };

/** "€1,600.00", "-€12.39", "12,82" or "1 234,50 €" in cents, and the currency its symbol names. */
export function parseMoney(raw: string): { cents: Cents; currency?: string } | null {
  let s = raw.replace(/ /g, ' ').trim();
  if (!s) return null;
  let currency: string | undefined;
  for (const [sym, code] of Object.entries(SYMBOLS)) if (s.includes(sym)) { currency = code; s = s.replace(sym, ''); }
  s = s.replace(/\s/g, '');
  const negative = /^-|^\(.*\)$/.test(s);
  s = s.replace(/^[-(]|\)$/g, '');
  if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.');             // "12,82": comma decimal
  else if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.'); // "1.234,50"
  else s = s.replace(/,/g, '');                                       // "1,234.50"
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const cents = Math.round(parseFloat(s) * 100);
  return { cents: negative ? -cents : cents, currency };
}

// ---------- categories ----------

const CATEGORY_WORDS: [Category, RegExp][] = [
  ['groceries', /продукт|grocer|supermarket|food/i],
  ['eating-out', /ресторан|кафе|restaurant|eating|cafe|bar/i],
  ['rent', /аренд|rent/i],
  ['bills', /коммунал|bill|utilit/i],
  ['internet', /интернет|internet|phone|mobile/i],
  ['cleaning', /уборк|clean/i],
  ['household', /^дом$|home|household|покупк|shopping|быт|бьюти|beauty/i],
];

export function categoryFor(label: string): Category {
  return CATEGORY_WORDS.find(([, re]) => re.test(label.trim()))?.[0] ?? 'other';
}

// ---------- reading the rows ----------

export type ExpenseRow = { row: number; at: Date; title: string; category: Category; categoryLabel: string; who: string; cents: Cents; note?: string };
export type PaymentRow = { row: number; at: Date; group: string; cents: Cents; note?: string };
export type Skipped = { tab: TabKind; row: number; reason: string; text: string };

const clip = (s: string, max = 500) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const clean = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

function readRows(kind: TabKind, rows: string[][], now: Date, skipped: Skipped[]) {
  const c = columns(rows[0] ?? []);
  const out: (ExpenseRow | PaymentRow)[] = [];
  let previous: Date | null = null;
  rows.slice(1).forEach((r, i) => {
    const row = i + 2;
    const cell = (k: keyof typeof WORDS) => (c[k] === undefined ? '' : r[c[k]!] ?? '');
    const amountText = clean(cell('amount'));
    const whoText = clean(cell('who'));
    if (!amountText && !clean(cell('date'))) return;                     // blank or prefilled-only row
    const money = parseMoney(amountText);
    const text = r.filter((x) => x.trim()).join(' · ');
    if (!money) { skipped.push({ tab: kind, row, reason: amountText ? 'amount not readable' : 'no amount', text }); return; }
    if (money.cents === 0) { skipped.push({ tab: kind, row, reason: 'zero amount', text }); return; }
    // Undated or stray-dated rows (a placeholder like "30 December") sit where they were typed.
    // A date more than ~two months away from its neighbour is a placeholder, not a real date.
    const read = parseSheetDate(cell('date'), previous ?? now);
    const at = read && (!previous || Math.abs(read.getTime() - previous.getTime()) < 62 * 86_400_000) ? read : previous ?? read;
    if (!at || at.getTime() > now.getTime() + 86_400_000) { skipped.push({ tab: kind, row, reason: 'date not readable', text }); return; }
    previous = at;
    // Everything to the right of the known columns is part of the note.
    const known = new Set(Object.values(c));
    const extra = r.filter((x, j) => !known.has(j) && j > Math.max(...known) && clean(x)).map(clean);
    if (kind === 'expenses') {
      if (money.cents < 0) { skipped.push({ tab: kind, row, reason: 'negative expense', text }); return; }
      if (!whoText) { skipped.push({ tab: kind, row, reason: 'no payer', text }); return; }
      const label = clean(cell('category'));
      const note = [clean(cell('details')), ...extra].filter(Boolean).join(' · ');
      out.push({ row, at, title: clip(clean(cell('what')), 120), category: categoryFor(label), categoryLabel: label, who: whoText, cents: money.cents, note: note ? clip(note) : undefined });
    } else {
      if (!whoText) { skipped.push({ tab: kind, row, reason: 'no group', text }); return; }
      const note = [clean(cell('details')), ...extra].filter(Boolean).join(' · ');
      out.push({ row, at, group: whoText, cents: money.cents, note: note ? clip(note) : undefined });
    }
  });
  return out;
}

// ---------- the household ----------

/** A payment that moved money between the groups rather than buying something for them. */
const TRANSFER = /долг|usdt|usdc|зп\b|зарплат|перевод|выкуп|interest|процент|вывод|вернул|возврат|наличк|нал\b|нал |cash|кэш|аванс|wallet|кошел|transfer|отдал|payment|loan|repay|salary|debt/i;

export type SheetImport = {
  household: Household;
  expenses: number;
  payments: number;
  skipped: Skipped[];
  from?: Date;
  to?: Date;
  currency: string;
};

export class ImportError extends Error {}

/**
 * Builds a household from the two tabs. `youName` picks who is using this phone (defaults to the
 * first person found). The result lives only on this phone until it is shared.
 */
export function buildHousehold(input: {
  name: string; expenses: string[][]; payments?: string[][]; youName?: string; now?: Date;
}): SheetImport {
  const now = input.now ?? new Date();
  const skipped: Skipped[] = [];
  const expenses = readRows('expenses', input.expenses, now, skipped) as ExpenseRow[];
  const payments = input.payments ? readRows('payments', input.payments, now, skipped) as PaymentRow[] : [];
  if (!expenses.length && !payments.length) throw new ImportError('No expenses found in the sheet.');

  // People and groups: "A + B" labels in the payments tab are groups; anyone else pays alone.
  const groupLabels = [...new Set(payments.map((p) => p.group))];
  const split = (label: string) => label.split('+').map((s) => s.trim()).filter(Boolean);
  const names = [...new Set([...expenses.map((e) => e.who), ...groupLabels.flatMap(split)])];
  if (names.length < 2) throw new ImportError('The sheet needs at least two people.');
  const people: Person[] = [];
  const groups: Group[] = [];
  const personOf = new Map<string, Person>();
  const groupOfLabel = new Map<string, Group>();
  const addGroup = (members: string[]) => {
    const g: Group = { id: newId('g'), color: GROUP_COLORS[groups.length % GROUP_COLORS.length], memberIds: [] };
    for (const n of members) {
      const p: Person = { id: newId('p'), name: n, groupId: g.id, joined: false, ...(members.length === 1 ? { unitId: g.id } : {}) };
      people.push(p); personOf.set(n, p); g.memberIds.push(p.id);
    }
    groups.push(g);
    return g;
  };
  for (const label of groupLabels) {
    const members = split(label).filter((n) => !personOf.has(n));
    if (members.length) groupOfLabel.set(label, addGroup(members));
    else groupOfLabel.set(label, groups.find((g) => g.memberIds.includes(personOf.get(split(label)[0])!.id))!);
  }
  for (const n of names) if (!personOf.has(n)) addGroup([n]);
  if (groups.length > GROUP_COLORS.length) throw new ImportError(`At most ${GROUP_COLORS.length} groups.`);
  if (payments.length && groups.length !== 2) throw new ImportError('Payments between groups need exactly two groups.');

  const you = personOf.get(input.youName ?? '') ?? people[0];
  you.joined = true;
  you.joinedAt = now.getTime();
  const groupOf = (p: Person) => groups.find((g) => g.id === p.groupId)!;
  const otherGroup = (g: Group) => groups.find((x) => x.id !== g.id)!;
  const firstOf = (g: Group) => people.find((p) => p.id === g.memberIds[0])!;
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  // An equal split gives an odd cent to the last group listed. Track which group has carried more
  // of those cents so far and hand the next one to the other, so hundreds of halved amounts stay
  // within a cent of the sheet's exact halves.
  let firstGroupExtra = 0;
  const equalOrder = (payer: Group, cents: Cents): ID[] => {
    const ids = [payer.id, ...groups.filter((g) => g.id !== payer.id).map((g) => g.id)];
    if (groups.length !== 2 || cents % 2 === 0) return ids;
    const takesCent = firstGroupExtra > 0 ? groups[1].id : groups[0].id;
    firstGroupExtra += takesCent === groups[0].id ? 1 : -1;
    return [ids.find((id) => id !== takesCent)!, takesCent];
  };

  type Draft = { at: Date; event: LedgerEvent };
  const drafts: Draft[] = [];
  for (const e of expenses) {
    const payer = personOf.get(e.who)!;
    drafts.push({ at: e.at, event: {
      id: newId('e'), at: e.at.getTime(), by: you.id, kind: 'expenseAdded', recordId: newId('r'),
      content: {
        payerId: payer.id, amount: e.cents, date: iso(e.at), category: e.category,
        ...(e.title ? { title: e.title } : {}),
        ...(e.note ? { note: e.note } : {}),
        split: { mode: 'equal', groupIds: equalOrder(groupOf(payer), e.cents), weighting: 'group' },
      },
    } });
  }
  for (const p of payments) {
    const g = groupOfLabel.get(p.group)!;
    const giver = p.cents > 0 ? g : otherGroup(g);
    const receiver = otherGroup(giver);
    const amount = Math.abs(p.cents);
    if (p.cents > 0 && TRANSFER.test(p.note ?? '')) {
      drafts.push({ at: p.at, event: {
        id: newId('e'), at: p.at.getTime(), by: you.id, kind: 'settlementRecorded', recordId: newId('r'),
        content: { fromGroupId: giver.id, toGroupId: receiver.id, amount, date: iso(p.at), ...(p.note ? { note: p.note } : {}) },
      } });
    } else {
      // Paid by one group, entirely for the other.
      drafts.push({ at: p.at, event: {
        id: newId('e'), at: p.at.getTime(), by: you.id, kind: 'expenseAdded', recordId: newId('r'),
        content: {
          payerId: firstOf(giver).id, amount, date: iso(p.at), category: 'other',
          title: clip(p.note && p.note.length <= 60 ? p.note : `For ${receiverLabel(receiver, people)}`, 120),
          ...(p.note && p.note.length > 60 ? { note: p.note } : {}),
          split: { mode: 'exact', shares: { [receiver.id]: amount } },
        },
      } });
    }
  }
  drafts.sort((a, b) => a.at.getTime() - b.at.getTime());

  const currencies = new Map<string, number>();
  for (const r of input.expenses.slice(1)) {
    const c = r.map((x) => parseMoney(x)?.currency).find(Boolean);
    if (c) currencies.set(c, (currencies.get(c) ?? 0) + 1);
  }
  const currency = [...currencies].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'EUR';
  const household: Household = {
    id: newId('h'), name: clip(input.name.trim() || 'Our place', 60), currency, createdAt: now.getTime(),
    people, groups, youId: you.id, events: drafts.map((d) => d.event), seen: {}, inviteCode: inviteCode(),
  };
  reduce(household); // throws a LedgerError if anything doesn't add up
  return {
    household, expenses: expenses.length, payments: payments.length, skipped, currency,
    from: drafts[0]?.at, to: drafts[drafts.length - 1]?.at,
  };
}

function receiverLabel(g: Group, people: Person[]) {
  return g.memberIds.map((id) => people.find((p) => p.id === id)?.name ?? '').filter(Boolean).join(' + ');
}

/** "Ana + Ben owe €12.40" style summary of the imported balance, from the core's own reduction. */
export function balanceSummary(h: Household): { owing: string; owed: string; cents: Cents } | null {
  const b = reduce(h).balances;
  const entries = Object.entries(b).filter(([, v]) => v !== 0).sort((x, y) => x[1] - y[1]);
  if (entries.length < 2) return null;
  const label = (gid: ID) => receiverLabel(h.groups.find((g) => g.id === gid)!, h.people);
  return { owing: label(entries[0][0]), owed: label(entries[entries.length - 1][0]), cents: -entries[0][1] };
}
