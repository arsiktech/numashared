// Pure helpers for the Add and Repay sheets: dates, suggestions, the split draft and the
// "After this" preview. No React here, so the rules stay easy to read and test.
import { allocateEqual, categoryLabel, formatMoney, isPlural, reduce, shares, standing } from '@/core';
import type { Category, Cents, ExpenseContent, Group, Household, ID, Ledger, LedgerEvent, Split } from '@/core/types';
import { isoToDate, todayISO } from '@/store/ids';
import { nameOf } from '../hooks';

export const CATEGORIES: readonly Category[] = ['groceries', 'household', 'rent', 'bills', 'internet', 'eating-out', 'cleaning', 'other'];

// ---------- dates ----------

export function shiftISO(iso: string, days: number): string {
  const d = isoToDate(iso);
  d.setDate(d.getDate() + days);
  return todayISO(d);
}

export const daysAgoISO = (n: number) => shiftISO(todayISO(), -n);

/** "Today", "Yesterday" or "Sat 11 Oct". */
export function dateLabel(iso: string): string {
  if (iso === todayISO()) return 'Today';
  if (iso === daysAgoISO(1)) return 'Yesterday';
  return isoToDate(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '');
}

/** "Saturday 11 October", for screen readers. */
export function dateSpoken(iso: string): string {
  if (iso === todayISO()) return 'Today';
  if (iso === daysAgoISO(1)) return 'Yesterday';
  return isoToDate(iso).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }).replace(',', '');
}

// ---------- suggestions ----------

export type Suggestion = { key: string; label: string; category: Category; title?: string; amount: Cents };

/** The household's most frequent recent expenses, each with its last amount. */
export function suggestionsFor(ledger: Ledger, limit = 6): Suggestion[] {
  const recent = ledger.records
    .filter((r) => r.kind === 'expense' && !r.voided && r.expense)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 40);
  const byKey = new Map<string, Suggestion & { count: number; last: number }>();
  for (const r of recent) {
    const e = r.expense!;
    const title = e.title?.trim() || undefined;
    const key = title ? `t:${title.toLowerCase()}` : `c:${e.category}`;
    const hit = byKey.get(key);
    if (hit) hit.count += 1;
    else byKey.set(key, { key, label: title ?? categoryLabel(e.category), category: e.category, title, amount: e.amount, count: 1, last: r.createdAt });
  }
  return [...byKey.values()]
    .sort((a, b) => b.count - a.count || b.last - a.last)
    .slice(0, limit)
    .map(({ key, label, category, title, amount }) => ({ key, label, category, title, amount }));
}

// ---------- split draft ----------

export type SplitDraft = {
  /** Groups left out of this expense. */
  out: ID[];
  weighting: 'group' | 'person';
  /** Exact shares after a drag or typed share, for the amount in `customFor`. */
  custom: Record<ID, Cents> | null;
  customFor: Cents;
};

export const equalDraft = (): SplitDraft => ({ out: [], weighting: 'group', custom: null, customFor: 0 });

export function draftFromSplit(h: Household, split: Split, amount: Cents): SplitDraft {
  if (split.mode === 'equal') {
    return { out: h.groups.filter((g) => !split.groupIds.includes(g.id)).map((g) => g.id), weighting: split.weighting, custom: null, customFor: 0 };
  }
  return { out: h.groups.filter((g) => !(g.id in split.shares)).map((g) => g.id), weighting: 'group', custom: { ...split.shares }, customFor: amount };
}

export const activeGroups = (h: Household, d: SplitDraft): Group[] => h.groups.filter((g) => !d.out.includes(g.id));

const memberCount = (h: Household, g: Group) => g.memberIds.filter((m) => h.people.some((p) => p.id === m)).length;

/** Whether groups differ in size, so "per person" and "per group" give different shares. */
export const sizesDiffer = (h: Household, groups: Group[]) => new Set(groups.map((g) => memberCount(h, g))).size > 1;

function equalSplit(h: Household, d: SplitDraft): Split {
  return { mode: 'equal', groupIds: activeGroups(h, d).map((g) => g.id), weighting: d.weighting };
}

function sharesOf(h: Household, split: Split, amount: Cents): Record<ID, Cents> {
  const probe: ExpenseContent = { payerId: h.youId, amount, date: todayISO(), category: 'other', split };
  return shares(probe, h.groups, h.people);
}

export function equalShares(h: Household, d: SplitDraft, amount: Cents): Record<ID, Cents> {
  if (!activeGroups(h, d).length) return {};
  return sharesOf(h, equalSplit(h, d), amount);
}

/** Splits `amount` in proportion to `weights` (cents), exactly. Groups weighted 0 get 0. */
export function scaleShares(weights: Record<ID, Cents>, amount: Cents, order: ID[]): Record<ID, Cents> {
  const ids = order.filter((id) => id in weights);
  const positive = ids.filter((id) => weights[id] > 0);
  const result: Record<ID, Cents> = {};
  for (const id of ids) result[id] = 0;
  if (!ids.length) return result;
  const units = positive.length ? positive.map((id) => ({ id, weight: weights[id] })) : ids.map((id) => ({ id, weight: 1 }));
  return { ...result, ...allocateEqual(amount, units) };
}

/** The shares shown on the split bar: custom ones (rescaled if the amount changed) or equal ones. */
export function draftShares(h: Household, d: SplitDraft, amount: Cents): Record<ID, Cents> {
  const order = activeGroups(h, d).map((g) => g.id);
  if (!d.custom) return equalShares(h, d, amount);
  if (d.customFor === amount) return d.custom;
  return scaleShares(d.custom, amount, order);
}

const sameShares = (a: Record<ID, Cents>, b: Record<ID, Cents>) => {
  const ka = Object.keys(a).filter((k) => a[k] !== 0);
  const kb = Object.keys(b).filter((k) => b[k] !== 0);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
};

/** True when the shares differ from an equal split (a drag back to the middle counts as equal). */
export function isCustom(h: Household, d: SplitDraft, amount: Cents): boolean {
  if (!d.custom) return false;
  return !sameShares(draftShares(h, d, amount), equalShares(h, d, amount));
}

/** The split saved with the expense. */
export function splitFor(h: Household, d: SplitDraft, amount: Cents): Split {
  if (isCustom(h, d, amount)) {
    const all = draftShares(h, d, amount);
    const exact: Record<ID, Cents> = {};
    for (const g of activeGroups(h, d)) exact[g.id] = all[g.id] ?? 0;
    return { mode: 'exact', shares: exact };
  }
  return equalSplit(h, d);
}

/**
 * Sets one group's share exactly. The rest of the amount goes to the other groups in proportion
 * to what they had, so the shares always add up to the amount.
 */
export function withExactShare(h: Household, d: SplitDraft, amount: Cents, groupId: ID, value: Cents): SplitDraft {
  const current = draftShares(h, d, amount);
  const others = activeGroups(h, d).map((g) => g.id).filter((id) => id !== groupId);
  const v = Math.max(0, Math.min(amount, value));
  const rest: Record<ID, Cents> = {};
  for (const id of others) rest[id] = current[id] ?? 0;
  const spread = others.length ? scaleShares(rest, amount - v, others) : {};
  return { ...d, custom: { ...spread, [groupId]: others.length ? v : amount }, customFor: amount };
}

/** "30 / 70" for two or three groups; empty for more. */
export function percentLabel(sharesById: Record<ID, Cents>, order: ID[], amount: Cents): string {
  if (amount <= 0 || order.length < 2 || order.length > 3) return '';
  const pct = order.map((id) => Math.round(((sharesById[id] ?? 0) * 100) / amount));
  return pct.join(' / ');
}

// ---------- preview ----------

/** The ledger as it would be with `event` appended, or the reason it would be refused. */
export function simulate(h: Household, event: LedgerEvent): { ledger: Ledger | null; error: string | null } {
  try {
    return { ledger: reduce({ ...h, events: [...h.events, event] }), error: null };
  } catch (e) {
    return { ledger: null, error: e instanceof Error ? e.message : 'This can’t be saved.' };
  }
}

export type Line = { lead: string; strong: string };

/** "You + Sam owe €75.70", "You + Sam get back €1.80" or "All square". */
export function standingLine(h: Household, group: Group, balance: Cents): Line {
  const s = standing(balance, group, h.people, h.youId);
  if (s.verb === 'square') return { lead: '', strong: 'All square' };
  return { lead: `${nameOf(h, group)} ${s.verb}`, strong: formatMoney(s.amount, h.currency) };
}

/** For an edit: "You + Sam owe €3.00 more", "…get back €2.00 less", or no change. */
export function changeLine(h: Household, group: Group, before: Cents, after: Cents): Line | null {
  const delta = after - before;
  const name = nameOf(h, group);
  const plural = isPlural(group, h.people, h.youId);
  if (delta === 0) return { lead: `No change for ${name}`, strong: '' };
  const amt = formatMoney(Math.abs(delta), h.currency);
  if (before <= 0 && after <= 0) return { lead: `${name} ${plural ? 'owe' : 'owes'}`, strong: `${amt} ${delta < 0 ? 'more' : 'less'}` };
  if (before >= 0 && after >= 0) return { lead: `${name} ${plural ? 'get back' : 'gets back'}`, strong: `${amt} ${delta > 0 ? 'more' : 'less'}` };
  return null;
}

/** "YS" for You + Sam, "M" for Mia. */
export function groupInitials(h: Household, g: Group): string {
  const people = g.memberIds.map((id) => h.people.find((p) => p.id === id)).filter((p) => p !== undefined);
  const ordered = [...people.filter((p) => p.id === h.youId), ...people.filter((p) => p.id !== h.youId)];
  return ordered.slice(0, 2).map((p) => (p.id === h.youId ? 'Y' : p.name.slice(0, 1).toUpperCase())).join('');
}

/** Spoken form of a group name: "You and Sam". */
export const spokenName = (h: Household, g: Group | ID) => nameOf(h, g).replace(/ \+ /g, ' and ');
