// On the web, Google draws its own sign-in button, at most 400 px wide. The column it sits in is
// capped at the same width, so it matches the Apple button at phone and desk widths.
import { describe, expect, test } from 'vitest';
import { GSI_MAX_WIDTH, GSI_MIN_WIDTH, gsiWidth, signInColumn } from '../account/signInWidth';

describe('web sign-in width', () => {
  test('Google is drawn at the column width on a phone', () => {
    expect(gsiWidth(350)).toBe(350);
    expect(gsiWidth(335.6)).toBe(335);
  });

  test('on a desk the column and Google both stop at 400 px', () => {
    expect(gsiWidth(560)).toBe(GSI_MAX_WIDTH);
    expect(signInColumn).toMatchObject({ width: '100%', maxWidth: GSI_MAX_WIDTH, alignSelf: 'center' });
  });

  test('never asks Google for less than it draws', () => {
    expect(gsiWidth(120)).toBe(GSI_MIN_WIDTH);
  });
});
