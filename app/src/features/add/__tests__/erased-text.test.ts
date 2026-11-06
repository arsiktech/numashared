import { expect, test, vi } from 'vitest';
import { withoutErasedText } from '../draft';

vi.mock('@/core', () => ({}));
vi.mock('@/store/ids', () => ({}));
vi.mock('../../hooks', () => ({}));

const opened = { title: 'Dinner', note: 'Words from the author' };

test('text erased while the edit is open leaves the draft', () => {
  expect(withoutErasedText({ ...opened, amount: 5 }, opened, {})).toEqual({ title: '', note: '', amount: 5 });
});

test('only the erased field is cleared', () => {
  expect(withoutErasedText({ ...opened }, opened, { title: 'Dinner' })).toEqual({ title: 'Dinner', note: '' });
});

test('text typed since the edit was opened stays', () => {
  const draft = { title: 'Lunch', note: 'My own words' };
  expect(withoutErasedText(draft, opened, {})).toBe(draft);
});

test('nothing changes while the text is still there', () => {
  const draft = { ...opened };
  expect(withoutErasedText(draft, opened, opened)).toBe(draft);
});
