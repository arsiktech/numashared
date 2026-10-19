// Review item 17: in landscape (844x390) the keypad and Save were cut off.
import { expect, test } from 'vitest';
import { isShortSheet, SHORT_KEY_HEIGHT } from '../layout';

test('a phone in landscape gets the scrolling sheet; portrait keeps the fitted one', () => {
  expect(isShortSheet(390)).toBe(true);
  expect(isShortSheet(430)).toBe(true);
  expect(isShortSheet(667)).toBe(false);
  expect(isShortSheet(844)).toBe(false);
  // Four rows of keys still meet the 44 pt touch target.
  expect(SHORT_KEY_HEIGHT).toBeGreaterThanOrEqual(44);
});
