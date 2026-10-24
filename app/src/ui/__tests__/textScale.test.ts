// ARS-118 native check: at the accessibility text sizes Home lost its balance and Add its keypad.
import { describe, expect, test } from 'vitest';
import { cappedSize, isLargeText, LARGE_TEXT_SCALE, TEXT_CAP } from '../textScale';

// iOS content size scales as React Native reports them.
const XXXL = 1.353;
const AX1 = 1.647;
const AX5 = 3.118;

describe('large-text layouts', () => {
  test('switch on at the accessibility sizes, not before', () => {
    expect(isLargeText(1)).toBe(false);
    expect(isLargeText(XXXL)).toBe(false);
    expect(isLargeText(AX1)).toBe(true);
    expect(isLargeText(AX5)).toBe(true);
    expect(LARGE_TEXT_SCALE).toBeGreaterThan(XXXL);
  });

  test('caps only bite at the accessibility sizes', () => {
    for (const cap of Object.values(TEXT_CAP)) expect(cap).toBeGreaterThan(XXXL);
  });
});

describe('capped sizes', () => {
  test('grow with the text up to the cap', () => {
    expect(cappedSize(38, 1, TEXT_CAP.display)).toBe(38);
    expect(cappedSize(38, 1.2, TEXT_CAP.display)).toBeCloseTo(45.6);
    expect(cappedSize(38, AX5, TEXT_CAP.display)).toBeCloseTo(38 * TEXT_CAP.display);
  });

  test('never shrink below the designed size', () => {
    expect(cappedSize(84, 0.82, TEXT_CAP.display)).toBe(84);
  });

  test('the Add keypad digits fit their 52 pt keys at every size', () => {
    expect(cappedSize(28, AX5, TEXT_CAP.sentence) * 1.2).toBeLessThanOrEqual(52);
  });
});
