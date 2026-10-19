// Review items 15, 16, 18, 19 and 20: hidden amounts stay hidden, Tab keeps normal traversal,
// edits are read in full, the export is a dated .csv file, and small controls have 44 pt targets.
import { describe, expect, test, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: async () => null, setItem: async () => {} } }));

const { sampleHousehold, reduce } = await import('@/core');
const { effectText, standingWords } = await import('../hooks');
const { editSpoken, speak } = await import('../detail/spoken');
const { tabJumpsToNote } = await import('../add/keys');
const { datedName } = await import('../settings/fileName');

const digits = /\d/;

describe('hide amounts (item 15)', () => {
  const h = sampleHousehold(Date.UTC(2026, 9, 19));
  const records = reduce(h).records;

  test('record rows keep the direction and drop the amount', () => {
    const touched = records.filter((r) => effectText(h, r, false) !== effectText(h, r, true));
    expect(touched.length).toBeGreaterThan(0);
    for (const r of records) expect(effectText(h, r, true)).not.toMatch(digits);
  });

  test('a group band says owe or get back without the amount', () => {
    expect(standingWords(h, -1234, true, true)).toBe('owes €••••');
    expect(standingWords(h, 500, false, true)).toBe('get back €••••');
    expect(standingWords(h, 500, false, false)).toMatch(digits);
  });
});

test('Tab jumps to the note only as the first press (item 16)', () => {
  expect(tabJumpsToNote(true, false)).toBe(true);
  expect(tabJumpsToNote(false, false)).toBe(false);
  expect(tabJumpsToNote(true, true)).toBe(false);
});

test('an edit is read with its amounts, reason and time (item 18)', () => {
  const day = (iso: string) => iso.slice(5);
  const parts = editSpoken([{ field: 'amount', from: '€90.00', to: '€96.00' }], 'Forgot the tip', false, day);
  expect(speak(['Edited by Alex', ...parts, 'Sun 20:05'])).toBe('Edited by Alex, Amount €90.00 to €96.00, reason: “Forgot the tip”, Sun 20:05');
  expect(editSpoken([{ field: 'amount', from: '€90.00', to: '€96.00' }], undefined, true, day)).toEqual(['Amount changed']);
});

test('the export is a dated .csv file (item 19)', () => {
  expect(datedName('numa-shared-home.csv', new Date(2026, 9, 19))).toBe('numa-shared-home-2026-10-19.csv');
});

test('chips and switches sit in a 44 pt touch target (item 20)', async () => {
  // The app's TypeScript config has no Node types; load fs untyped.
  const fs = await import(/* @vite-ignore */ ['node', 'fs'].join(':')) as { readFileSync: (p: string, e: string) => string };
  const testPath = expect.getState().testPath!;
  const src = fs.readFileSync(testPath.replace(/features\/__tests__\/a11y\.test\.ts$/, 'ui/primitives.tsx'), 'utf8');
  expect(src).toMatch(/target: \{ minHeight: 44, minWidth: 44/);
  for (const name of ['TChip', 'Chip', 'Toggle']) {
    const body = src.slice(src.indexOf(`export function ${name}(`), src.indexOf('\nexport function', src.indexOf(`export function ${name}(`) + 10));
    // Each Press opening tag, up to its style prop.
    const presses = body.split('<Press').slice(1).map((rest: string) => rest.slice(0, rest.indexOf('style=') + 18));
    expect(presses.length, name).toBeGreaterThan(0);
    for (const p of presses) expect(p, name).toContain('style={s.target}');
  }
});
