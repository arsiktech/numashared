// Screen-level helpers: the active household, its ledger and display wording.
import { useMemo } from 'react';
import { categoryLabel, formatMoney, groupName, standing } from '@/core';
import type { Group, Household, ID, LedgerRecord } from '@/core/types';
import { activeHousehold, ledgerOf, useStore, yourGroup } from '@/store/store';

export function useHousehold() {
  const h = useStore(activeHousehold);
  const hide = useStore((s) => s.prefs.hideAmounts);
  const ledger = useMemo(() => (h ? ledgerOf(h) : null), [h]);
  return { h, ledger, hide };
}

export const nameOf = (h: Household, g: Group | ID) =>
  groupName(typeof g === 'string' ? h.groups.find((x) => x.id === g)! : g, h.people, h.youId);

/** A group's name after a verb: "Sam paid you", "Alex owes you + Sam". */
export const objectName = (h: Household, g: Group | ID) => nameOf(h, g).replace(/^You\b/, 'you');

/** A repayment's title: "Sam paid you", "You paid Alex + Jo", "You + Sam paid Mia". */
export function settlementTitle(h: Household, r: LedgerRecord) {
  const s = r.settlement!;
  return `${nameOf(h, s.fromGroupId)} paid ${objectName(h, s.toGroupId)}`;
}

export const personName = (h: Household, id: ID, viewerAware = true) =>
  viewerAware && id === h.youId ? 'You' : h.people.find((p) => p.id === id)?.name ?? 'Someone';

export const initials = (h: Household, id: ID) => (id === h.youId ? 'Y' : (h.people.find((p) => p.id === id)?.name ?? '?').slice(0, 1).toUpperCase());

export const money = (h: Household, cents: number, hide = false) => (hide ? '€••••' : formatMoney(cents, h.currency));

/** "Groceries" or the custom title. */
export const recordTitle = (r: LedgerRecord) =>
  r.kind === 'expense' ? (r.expense!.title || categoryLabel(r.expense!.category)) : r.kind === 'settlement' ? 'Repayment' : 'Opening balance';

/** Your group's net position: { verb, amount } with correct agreement. */
export function yourStanding(h: Household, balances: Record<ID, number>) {
  const g = yourGroup(h);
  return standing(balances[g.id] ?? 0, g, h.people, h.youId);
}

/** The effect line. With amounts hidden it keeps the direction and drops the amount. */
export function effectText(h: Household, r: LedgerRecord, hide?: boolean) {
  const e = r.voided || r.kind === 'settlement' ? 0 : r.effect[yourGroup(h).id] ?? 0;
  if (!hide || e === 0) return effectLine(h, r);
  return e > 0 ? 'you’re owed' : 'you owe';
}

/** A group's standing on Home: "owes €12.00", "get back €3.00", "square". Hidden amounts stay hidden. */
export function standingWords(h: Household, own: number, single: boolean, hide = false) {
  if (own === 0) return 'square';
  return own < 0 ? `${single ? 'owes' : 'owe'} ${money(h, -own, hide)}` : `${single ? 'gets' : 'get'} back ${money(h, own, hide)}`;
}

/** How a record touches your group: "you owe €36.00", "you’re owed €26.40", "no effect". */
export function effectLine(h: Household, r: LedgerRecord) {
  if (r.voided) return 'no effect';
  const g = yourGroup(h);
  const e = r.effect[g.id] ?? 0;
  if (r.kind === 'settlement') {
    const s = r.settlement!;
    if (s.fromGroupId === g.id) return 'you repaid';
    if (s.toGroupId === g.id) return 'repaid to you';
    return 'not yours';
  }
  if (e > 0) return `you’re owed ${formatMoney(e, h.currency)}`;
  if (e < 0) return `you owe ${formatMoney(-e, h.currency)}`;
  return 'no effect on you';
}

export function relativeDay(ts: number, now = Date.now()) {
  const d = new Date(ts), n = new Date(now);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(n) - day(d)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return d.toLocaleDateString('en-GB', { weekday: 'long' });
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

export const clock = (ts: number) => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

export const shortDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};
