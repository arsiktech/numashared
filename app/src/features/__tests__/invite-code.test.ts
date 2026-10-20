import { describe, expect, it } from 'vitest';
import { cleanCode } from '../onboarding/model';

describe('cleanCode', () => {
  it('keeps what is being typed', () => {
    expect(cleanCode('k7q')).toBe('K7Q');
    expect(cleanCode('K7Q 4')).toBe('K7Q4');
    expect(cleanCode('K7Q 4MZX')).toBe('K7Q4MZ');
  });
  it('takes the code out of pasted text', () => {
    expect(cleanCode(' K7Q-4MZ ')).toBe('K7Q4MZ');
    expect(cleanCode('Code: K7Q4MZ')).toBe('K7Q4MZ');
    expect(cleanCode('Your code is K7Q 4MZ.')).toBe('K7Q4MZ');
  });
});
