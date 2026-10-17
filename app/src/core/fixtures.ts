// "Try a sample household": Our place, EUR, two couples. Synthetic names only.
// Dates are relative to `now` so the demo always looks recent; with now on 13 Oct the records
// fall on 30 Sep, 3, 8, 10, 11, 12 and 13 Oct. Final balance: You + Sam −75.70, Alex + Jo +75.70.
import type { Household, LedgerEvent, Split } from './types';

export const SAMPLE_IDS = {
  household: 'sample-our-place',
  people: { ari: 'ari', sam: 'sam', alex: 'alex', jo: 'jo' },
  groups: { ys: 'ys', aj: 'aj' },
  records: {
    opening: 'r-opening',
    repayment: 'r-repayment',
    electricity: 'r-electricity',
    cleaning: 'r-cleaning',
    dinner: 'r-dinner',
    internet: 'r-internet',
    groceries: 'r-groceries',
  },
} as const;

export function sampleHousehold(now: number): Household {
  const today = new Date(now);
  const at = (dayOffset: number, hours: number, minutes: number) =>
    new Date(today.getFullYear(), today.getMonth(), today.getDate() + dayOffset, hours, minutes).getTime();
  const iso = (ts: number) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  const { ari, sam, alex, jo } = SAMPLE_IDS.people;
  const { ys, aj } = SAMPLE_IDS.groups;
  const r = SAMPLE_IDS.records;
  const byGroup = (): Split => ({ mode: 'equal', groupIds: [ys, aj], weighting: 'group' });

  const groceriesAt = now - 2 * 60 * 60 * 1000;

  const events: LedgerEvent[] = [
    {
      id: 'e-opening', at: at(-13, 10, 0), by: ari, kind: 'openingBalanceSet', recordId: r.opening,
      content: { entries: [{ fromGroupId: ys, toGroupId: aj, amount: 12000 }], date: iso(at(-13, 10, 0)) },
    },
    {
      id: 'e-repayment', at: at(-10, 19, 15), by: sam, kind: 'settlementRecorded', recordId: r.repayment,
      content: {
        fromGroupId: ys, toGroupId: aj, amount: 6000, date: iso(at(-10, 19, 15)), method: 'bank',
        note: 'Half of what we owed from September',
      },
    },
    {
      id: 'e-electricity', at: at(-5, 9, 30), by: sam, kind: 'expenseAdded', recordId: r.electricity,
      content: { payerId: sam, amount: 8380, date: iso(at(-5, 9, 30)), category: 'bills', title: 'Electricity', split: byGroup() },
    },
    {
      id: 'e-cleaning', at: at(-3, 17, 20), by: jo, kind: 'expenseAdded', recordId: r.cleaning,
      content: { payerId: jo, amount: 1800, date: iso(at(-3, 17, 20)), category: 'cleaning', title: 'Cleaning stuff', split: byGroup() },
    },
    { id: 'e-cleaning-void', at: at(-3, 17, 24), by: jo, kind: 'recordVoided', recordId: r.cleaning, reason: 'Duplicate' },
    {
      id: 'e-dinner', at: at(-2, 22, 40), by: alex, kind: 'expenseAdded', recordId: r.dinner,
      content: {
        payerId: alex, amount: 9000, date: iso(at(-2, 22, 40)), category: 'eating-out', title: 'Dinner together',
        note: 'Jo’s birthday, tip included', split: byGroup(),
      },
    },
    {
      id: 'e-dinner-edit', at: at(-1, 20, 5), by: alex, kind: 'expenseRevised', recordId: r.dinner, reason: 'Forgot the tip',
      content: {
        payerId: alex, amount: 9600, date: iso(at(-2, 22, 40)), category: 'eating-out', title: 'Dinner together',
        note: 'Jo’s birthday, tip included', split: byGroup(),
      },
    },
    {
      id: 'e-internet', at: at(-1, 21, 10), by: jo, kind: 'expenseAdded', recordId: r.internet,
      content: { payerId: jo, amount: 7200, date: iso(at(-1, 21, 10)), category: 'internet', split: byGroup() },
    },
    {
      id: 'e-groceries', at: groceriesAt, by: ari, kind: 'expenseAdded', recordId: r.groceries,
      content: {
        payerId: ari, amount: 5280, date: iso(groceriesAt), category: 'groceries',
        note: 'Apples, bread and coffee', split: byGroup(),
      },
    },
  ];

  return {
    id: SAMPLE_IDS.household,
    name: 'Our place',
    currency: 'EUR',
    createdAt: at(-13, 9, 50),
    people: [
      { id: ari, name: 'Ari', groupId: ys, joined: true, joinedAt: at(-13, 9, 50) },
      { id: sam, name: 'Sam', groupId: ys, joined: true, joinedAt: at(-13, 10, 12) },
      { id: alex, name: 'Alex', groupId: aj, joined: true, joinedAt: at(-13, 12, 18) },
      { id: jo, name: 'Jo', groupId: aj, joined: true, joinedAt: at(-13, 18, 0) },
    ],
    groups: [
      { id: ys, color: 'citrus', memberIds: [ari, sam] },
      { id: aj, color: 'lilac', memberIds: [alex, jo] },
    ],
    youId: ari,
    events,
    seen: {
      'e-opening': { [sam]: at(-13, 10, 30), [alex]: at(-13, 12, 20), [jo]: at(-13, 18, 2) },
      'e-repayment': { [ari]: at(-10, 19, 40), [alex]: at(-10, 21, 3), [jo]: at(-9, 8, 10) },
      'e-electricity': { [ari]: at(-5, 12, 0), [alex]: at(-5, 13, 15) },
      'e-cleaning-void': { [alex]: at(-3, 18, 2) },
      'e-dinner': { [ari]: at(-2, 22, 55), [jo]: at(-2, 23, 1) },
      'e-dinner-edit': { [ari]: at(-1, 20, 14), [sam]: at(-1, 20, 14) },
      'e-internet': { [sam]: at(-1, 22, 1) },
      'e-groceries': { [alex]: groceriesAt + 45 * 60 * 1000 },
    },
    inviteCode: 'K7QM4Z',
  };
}
