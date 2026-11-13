// "You" as the object of a sentence reads "you" ("Sam paid you"), and the new-household name
// starts empty so typing never adds to the placeholder.
import { describe, expect, test, vi } from 'vitest';
import type { Household, LedgerRecord } from '@/core/types';

vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: async () => null, setItem: async () => {} } }));

const { objectName, settlementTitle } = await import('../hooks');
const { DEFAULT_HOUSEHOLD_NAME, householdTitle } = await import('../onboarding/model');

const house = (mine: string[]) => ({
  youId: 'ari',
  people: [{ id: 'ari', name: 'Ari' }, { id: 'kim', name: 'Kim' }, { id: 'sam', name: 'Sam' }, { id: 'alex', name: 'Alex' }, { id: 'jo', name: 'Jo' }],
  groups: [
    { id: 'g1', memberIds: mine, color: 'citrus' },
    { id: 'g2', memberIds: ['sam'], color: 'lilac' },
    { id: 'g3', memberIds: ['alex', 'jo'], color: 'sky' },
  ],
}) as unknown as Household;

const repayment = (fromGroupId: string, toGroupId: string) => ({ kind: 'settlement', settlement: { fromGroupId, toGroupId, amount: 1500 } }) as unknown as LedgerRecord;

describe('repayment titles', () => {
  test('you as the object read lowercase', () => {
    expect(settlementTitle(house(['ari']), repayment('g2', 'g1'))).toBe('Sam paid you');
    expect(settlementTitle(house(['ari', 'kim']), repayment('g2', 'g1'))).toBe('Sam paid you + Kim');
  });

  test('you as the subject keep the capital', () => {
    expect(settlementTitle(house(['ari']), repayment('g1', 'g2'))).toBe('You paid Sam');
    expect(settlementTitle(house(['ari', 'kim']), repayment('g1', 'g3'))).toBe('You + Kim paid Alex + Jo');
  });

  test('other groups keep their names either way', () => {
    expect(settlementTitle(house(['ari']), repayment('g3', 'g2'))).toBe('Alex + Jo paid Sam');
    expect(objectName(house(['ari']), 'g2')).toBe('Sam');
  });
});

describe('new household name', () => {
  test('starts empty, so the placeholder is only a fallback', () => {
    expect(householdTitle('')).toBe(DEFAULT_HOUSEHOLD_NAME);
    expect(householdTitle('   ')).toBe(DEFAULT_HOUSEHOLD_NAME);
    expect(householdTitle(' Test Flat ')).toBe('Test Flat');
  });
});
