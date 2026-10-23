import { describe, expect, test, vi } from 'vitest';
import type { Household, LedgerRecord } from '@/core/types';

vi.mock('@/store/store', () => ({ ledgerOf: () => ({ records: [] }) }));
const { buildCsv } = await import('../csv');

const household: Household = {
  id: 'household', name: 'Fixture', currency: 'EUR', createdAt: 1, youId: 'author',
  people: [{ id: 'author', name: 'Author', groupId: 'group', joined: true }],
  groups: [{ id: 'group', color: 'citrus', memberIds: ['author'] }], events: [], seen: {}, inviteCode: 'ABC234',
};
function record(title: string, note = 'ordinary note'): LedgerRecord {
  return {
    id: 'record', kind: 'expense', createdAt: 1, createdBy: 'author', updatedAt: 1,
    expense: { title, note, amount: -125, date: '2026-01-01', category: 'groceries', payerId: 'author',
      split: { mode: 'equal', groupIds: ['group'], weighting: 'group' } },
    revisions: [], voided: false, flagged: false, effect: {}, timeline: [],
  };
}
// Decode the exported CSV itself, including quoted commas, quotes and newlines.
function parse(csv: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], value = '', quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (c === '"') {
      if (quoted && csv[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted;
    } else if (!quoted && (c === ',' || c === '\n')) {
      row.push(value); value = '';
      if (c === '\n') { rows.push(row); row = []; }
    } else value += c;
  }
  row.push(value); rows.push(row); return rows;
}

describe('spreadsheet literal text', () => {
  test.each(['=1+1', '+1+1', '-1+1', '@SUM(1)', '\ttext', '\rtext', '  =1+1', '\n=1+1'])('neutralizes authored text %j but keeps numeric amounts numeric', (text) => {
    const h = { ...household, people: [{ ...household.people[0], name: text }] };
    const rows = parse(buildCsv(h, [record(text, text)]));
    expect(rows).toHaveLength(2);
    expect(rows[1]).toHaveLength(9);
    for (const index of [1, 4, 7, 8]) expect(rows[1][index]).toBe(`'${text}`);
    expect(rows[1][3]).toBe('-1.25');
  });
  test('preserves ordinary text and CSV structure', () => {
    const text = 'Shop, "corner"\nsecond line';
    const rows = parse(buildCsv(household, [record(text)]));
    expect(rows[1]).toHaveLength(9);
    expect(rows[1][1]).toBe(text);
    expect(rows[1][7]).toBe('ordinary note');
  });
});
