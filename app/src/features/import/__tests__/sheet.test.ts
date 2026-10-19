import { describe, expect, test } from 'vitest';
import { reduce } from '../../../core/ledger';
import {
  balanceSummary, buildHousehold, categoryFor, parseCsv, parseMoney, parseSheetDate, sheetIdFromLink,
  tabKind, tabsFromHtmlView, titleFromHtmlView,
} from '../sheet';

const now = new Date(2026, 9, 19, 12);

// Two couples sharing a flat, in the layout of a typical shared-budget sheet.
const EXPENSES = `Дата,Наименование,Категория,Кто?,Сумма,"-€1.00",
,,,,,,
"Monday, 20 May 2024 г.",Landlord,Дом,Ana,"€1,600.00",Deposit,
"Monday, 20 May 2024 г.",Supermarket,Продукты,Cy,€10.01,,
"Friday, 24 May at 08:29",Cafe,Рестораны,Ben,"12,83",,
"Saturday, 30 December at 00:00",Shop,Покупки,Dee,€0.00,refund,
"Saturday, 30 December at 00:00",Kiosk,Продукты,Dee,€3.03,,
`;
const PAYMENTS = `Дата,Кто?,Сумма,Детали
,,,
"Friday, 24 May 2024 г.",Cy + Dee,-€12.39,Ana paid for Amazon
"Tuesday, 28 May 2024 г.",Cy + Dee,"€2,500.00",Долг банковским переводом
"Wednesday, 29 May 2024 г.",Ana + Ben ,€40.00,card 05.06 Mercadona
,Ana + Ben ,,
`;

describe('reading a shared-budget Google Sheet', () => {
  test('links, tabs and titles', () => {
    expect(sheetIdFromLink('https://docs.google.com/spreadsheets/d/1abcdefghijklmnopqrstuvwxyz0123/edit?pli=1&gid=0#gid=0'))
      .toBe('1abcdefghijklmnopqrstuvwxyz0123');
    expect(sheetIdFromLink('https://example.com/x')).toBeNull();
    const html = '<title>Flat budget (spending) - Google Sheets</title> {name: "Spending", pageUrl: "x", gid: "0"} {name: "Payments \\u2192", pageUrl: "y", gid: "77"}';
    expect(tabsFromHtmlView(html)).toEqual([{ name: 'Spending', gid: '0' }, { name: 'Payments →', gid: '77' }]);
    expect(titleFromHtmlView(html)).toBe('Flat budget');
    expect(tabKind(parseCsv(EXPENSES))).toBe('expenses');
    expect(tabKind(parseCsv(PAYMENTS))).toBe('payments');
    expect(tabKind([['', 'Summary']])).toBeNull();
  });

  test('money, dates and categories', () => {
    expect(parseMoney('€1,600.00')).toEqual({ cents: 160000, currency: 'EUR' });
    expect(parseMoney('-€12.39')).toEqual({ cents: -1239, currency: 'EUR' });
    expect(parseMoney('12,82')).toEqual({ cents: 1282, currency: undefined });
    expect(parseMoney('1.234,50 €')?.cents).toBe(123450);
    expect(parseMoney('abc')).toBeNull();
    // No year: the year in which 24 May was a Friday, nearest to the previous row.
    expect(parseSheetDate('Friday, 24 May at 08:29', new Date(2024, 4, 20))).toEqual(new Date(2024, 4, 24, 8, 29));
    expect(parseSheetDate('Monday, 20 May 2024 г.', now)).toEqual(new Date(2024, 4, 20, 12, 0));
    expect(categoryFor('Продукты')).toBe('groceries');
    expect(categoryFor('Рестораны')).toBe('eating-out');
    expect(categoryFor('Travel')).toBe('other');
  });

  test('builds two groups with the whole history and the sheet’s balance', () => {
    const r = buildHousehold({ name: 'Flat', expenses: parseCsv(EXPENSES), payments: parseCsv(PAYMENTS), youName: 'Ana', now });
    const h = r.household;
    const names = h.groups.map((g) => g.memberIds.map((id) => h.people.find((p) => p.id === id)!.name));
    expect(names).toEqual([['Cy', 'Dee'], ['Ana', 'Ben']]);
    expect(h.people.find((p) => p.id === h.youId)?.name).toBe('Ana');
    expect(r.expenses).toBe(4);
    expect(r.payments).toBe(3);
    expect(r.skipped.map((s) => s.reason)).toEqual(['zero amount']);
    expect(r.currency).toBe('EUR');
    // The placeholder "30 December" rows stay next to the row typed before them.
    expect(r.to).toEqual(new Date(2024, 4, 29, 12, 0));

    // Sheet arithmetic: each couple is credited half of what it spent plus what it put in.
    // Ana + Ben spent 1600 + 12.83, Cy + Dee 10.01 + 3.03. Ana + Ben also put in 12.39 and 40.00;
    // Cy + Dee put in 2,500.00.
    const ab = (160000 + 1283) / 2 + 1239 + 4000;
    const cd = (1001 + 303) / 2 + 250000;
    const exact = ab - cd;                                             // Ana + Ben's balance
    const l = reduce(h);
    const abGroup = h.groups.find((g) => g.memberIds.includes(h.youId))!.id;
    expect(Math.abs(l.balances[abGroup] - exact)).toBeLessThanOrEqual(1);
    expect(balanceSummary(h)).toMatchObject({ owing: 'Ana + Ben', owed: 'Cy + Dee' });

    // A repayment ("долг … переводом") is a repayment; the rest are expenses for the other couple.
    const kinds = h.events.map((e) => (e.kind === 'expenseAdded' && e.content.split.mode === 'exact' ? 'for-other' : e.kind));
    expect(kinds.filter((k) => k === 'settlementRecorded')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'for-other')).toHaveLength(2);
    // Oldest first, so the server sees them in order.
    expect(h.events.map((e) => e.at)).toEqual([...h.events.map((e) => e.at)].sort((a, b) => a - b));
  });

  test('odd cents alternate between the couples instead of drifting', () => {
    const rows = ['Дата,Наименование,Категория,Кто?,Сумма'];
    for (let i = 0; i < 200; i++) rows.push(`"Monday, 20 May 2024 г.",Shop,Продукты,${i % 3 ? 'Ana' : 'Cy'},€1.01`);
    const r = buildHousehold({ name: 'Flat', expenses: parseCsv(rows.join('\n')), payments: parseCsv('Дата,Кто?,Сумма,Детали\n"Monday, 20 May 2024 г.",Ana + Ben,€1.00,x\n"Monday, 20 May 2024 г.",Cy + Dee,€1.00,x'), now });
    const b = Object.values(reduce(r.household).balances);
    // Exact halves would give 0.5 cent per expense; alternating keeps the total within a cent.
    const exact = ((200 - 67) * 101 / 2 - 67 * 101 / 2);
    expect(Math.abs(Math.max(...b) - exact)).toBeLessThanOrEqual(1);
  });

  test('refuses sheets it can’t turn into a household', () => {
    expect(() => buildHousehold({ name: 'x', expenses: parseCsv('Дата,Наименование,Категория,Кто?,Сумма\n'), now })).toThrow('No expenses');
  });
});
