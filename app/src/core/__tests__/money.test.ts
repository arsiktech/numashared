import { describe, expect, it } from 'vitest';
import {
  applyKey, currencyDigits, formatMoney, inputFromCents, MAX_AMOUNT, maxWholeDigits, parseInput,
  splitDisplay, type Key,
} from '../money';

const type = (keys: Key[], currency: string, start = '') => keys.reduce((s, k) => applyKey(s, k, currency), start);

describe('currencyDigits', () => {
  it('knows ISO 4217 minor units, defaulting to 2', () => {
    expect(currencyDigits('EUR')).toBe(2);
    expect(currencyDigits('JPY')).toBe(0);
    expect(currencyDigits('KRW')).toBe(0);
    expect(currencyDigits('VND')).toBe(0);
    expect(currencyDigits('BHD')).toBe(3);
    expect(currencyDigits('IQD')).toBe(3);
    expect(currencyDigits('KWD')).toBe(3);
    expect(currencyDigits('CLF')).toBe(4);
    expect(currencyDigits('UYW')).toBe(4);
    // ISO minor units, not platform display precision (ported from the Swift catalog test).
    expect(currencyDigits('HUF')).toBe(2);
    expect(currencyDigits('IDR')).toBe(2);
    expect(currencyDigits('jpy')).toBe(0);
  });
});

describe('formatMoney', () => {
  it('formats EUR with symbol, thousands and U+2212', () => {
    expect(formatMoney(5280, 'EUR')).toBe('€52.80');
    expect(formatMoney(-300, 'EUR')).toBe('−€3.00');
    expect(formatMoney(124000, 'EUR')).toBe('€1,240.00');
    expect(formatMoney(0, 'EUR')).toBe('€0.00');
    expect(formatMoney(5, 'EUR')).toBe('€0.05');
    expect(formatMoney(MAX_AMOUNT, 'EUR')).toBe('€9,999,999,999.99');
  });
  it('supports no-symbol, sign and fraction options', () => {
    expect(formatMoney(5280, 'EUR', { symbol: false })).toBe('52.80');
    expect(formatMoney(-5280, 'EUR', { symbol: false })).toBe('−52.80');
    expect(formatMoney(300, 'EUR', { sign: 'always' })).toBe('+€3.00');
    expect(formatMoney(-300, 'EUR', { sign: 'always' })).toBe('−€3.00');
    expect(formatMoney(0, 'EUR', { sign: 'always' })).toBe('€0.00');
    expect(formatMoney(-300, 'EUR', { sign: 'never' })).toBe('€3.00');
    // Ported from Swift: automatic fraction drops all-zero cents.
    expect(formatMoney(13000, 'EUR', { fraction: 'auto' })).toBe('€130');
    expect(formatMoney(-13000, 'EUR', { fraction: 'auto' })).toBe('−€130');
    expect(formatMoney(200000, 'EUR', { fraction: 'auto' })).toBe('€2,000');
    expect(formatMoney(520, 'EUR', { fraction: 'auto' })).toBe('€5.20');
    expect(formatMoney(13000, 'EUR')).toBe('€130.00');
  });
  it('respects the currency exponent', () => {
    expect(formatMoney(1235, 'JPY')).toBe('¥1,235');
    expect(formatMoney(1234, 'BHD')).toBe('BHD 1.234');
    expect(formatMoney(12345, 'CLF')).toBe('CLF 1.2345');
    expect(formatMoney(123456, 'GBP')).toBe('£1,234.56');
  });
  it('rejects non-integer cents', () => {
    expect(() => formatMoney(1.5, 'EUR')).toThrow(RangeError);
    expect(() => formatMoney(Number.NaN, 'EUR')).toThrow(RangeError);
  });
});

describe('splitDisplay', () => {
  it('splits whole and decimals for the big amount', () => {
    expect(splitDisplay(124000, 'EUR')).toEqual({ sign: '', symbol: '€', whole: '1,240', decimals: '00' });
    expect(splitDisplay(5280)).toEqual({ sign: '', symbol: '€', whole: '52', decimals: '80' });
    expect(splitDisplay(-7570, 'EUR')).toEqual({ sign: '−', symbol: '€', whole: '75', decimals: '70' });
    expect(splitDisplay(1235, 'JPY')).toEqual({ sign: '', symbol: '¥', whole: '1,235', decimals: null });
  });
});

describe('keypad input (ported from MoneyInput.swift)', () => {
  it('runs the digit and backspace state machine', () => {
    const steps: [Key, string][] = [
      ['5', '5'], ['.', '5.'], ['2', '5.2'], ['0', '5.20'], ['9', '5.20'],
      ['back', '5.2'], ['back', '5.'], ['back', '5'], ['back', ''], ['back', ''],
    ];
    let s = '';
    for (const [key, expected] of steps) {
      s = applyKey(s, key, 'EUR');
      expect(s).toBe(expected);
    }
  });
  it('replaces a leading zero and starts decimals at 0.', () => {
    expect(type(['0'], 'EUR')).toBe('0');
    expect(type(['0', '5'], 'EUR')).toBe('5');
    expect(type(['0', '0'], 'EUR')).toBe('0');
    expect(type(['.', '5'], 'EUR')).toBe('0.5');
    expect(type(['.', 'back'], 'EUR')).toBe('');
    expect(type(['5', '.', '.'], 'EUR')).toBe('5.');
  });
  it('ignores the separator in zero-decimal currencies', () => {
    const jpy = type(['1', '2', '.', '3'], 'JPY');
    expect(jpy).toBe('123');
    expect(parseInput(jpy, 'JPY')).toBe(123);
  });
  it('accepts up to the currency exponent in fraction digits', () => {
    const bhd = type(['1', '.', '2', '3', '4', '5'], 'BHD');
    expect(bhd).toBe('1.234');
    expect(parseInput(bhd, 'BHD')).toBe(1234);
    const clf = type(['1', '.', '2', '3', '4', '5', '6'], 'CLF');
    expect(clf).toBe('1.2345');
    expect(parseInput(clf, 'CLF')).toBe(12345);
  });
  it('caps magnitude per currency, well above the old 6-digit limit', () => {
    expect(maxWholeDigits('EUR')).toBe(10);
    expect(maxWholeDigits('JPY')).toBe(12);
    expect(maxWholeDigits('BHD')).toBe(9);
    // The Swift cap stopped at 123456; the new one allows 9,999,999.99 and more.
    expect(type(['1', '2', '3', '4', '5', '6', '7'], 'EUR')).toBe('1234567');
    expect(parseInput('9999999.99', 'EUR')).toBe(999999999);
    const tenNines = '9'.repeat(10);
    expect(applyKey(tenNines, '9', 'EUR')).toBe(tenNines);
    expect(applyKey(`${tenNines}.9`, '9', 'EUR')).toBe(`${tenNines}.99`);
    expect(parseInput(`${tenNines}.99`, 'EUR')).toBe(MAX_AMOUNT);
    expect(parseInput(`9${tenNines}`, 'EUR')).toBeNull();
    const twelve = '9'.repeat(12);
    expect(applyKey(twelve, '9', 'JPY')).toBe(twelve);
    expect(parseInput(twelve, 'JPY')).toBe(999999999999);
    expect(parseInput('15000000', 'VND')).toBe(15000000);
  });
  it('recovers from malformed input instead of getting stuck', () => {
    expect(applyKey('abc', '5', 'EUR')).toBe('5');
  });
});

describe('parseInput', () => {
  it('converts exactly to minor units', () => {
    expect(parseInput('5.2', 'EUR')).toBe(520);
    expect(parseInput('5.20', 'EUR')).toBe(520);
    expect(parseInput('12', 'EUR')).toBe(1200);
    expect(parseInput('12.', 'EUR')).toBe(1200);
    expect(parseInput('0', 'EUR')).toBe(0);
    expect(parseInput('0.07', 'EUR')).toBe(7);
    expect(parseInput('52.80', 'EUR')).toBe(5280);
    expect(parseInput('007', 'EUR')).toBe(700);
    // 0.1 + 0.2 style float traps do not apply.
    expect(parseInput('1.15', 'EUR')).toBe(115);
    expect(parseInput('4.35', 'EUR')).toBe(435);
  });
  it('rejects empty, malformed and over-precise input', () => {
    for (const bad of ['', '.', '-1', '+1', '1 2', '1,2', '1.2.3', '½', '²', 'abc', '1e3']) {
      expect(parseInput(bad, 'EUR')).toBeNull();
    }
    expect(parseInput('1.234', 'EUR')).toBeNull();
    expect(parseInput('12.1', 'JPY')).toBeNull();
  });
  it('normalizes Unicode decimal digits (ported vectors)', () => {
    for (const s of ['١٢.٣٤', '۱۲.۳۴', '１２.３４', '1٢.３4']) expect(parseInput(s, 'EUR')).toBe(1234);
    expect(parseInput('١.٢٣٤', 'BHD')).toBe(1234);
    expect(parseInput('١.٢٣٤', 'EUR')).toBeNull();
    expect(applyKey('١٢.٣٤', 'back', 'EUR')).toBe('12.3');
  });
  it('round-trips through inputFromCents', () => {
    for (const [c, cur] of [[5280, 'EUR'], [5205, 'EUR'], [1200, 'EUR'], [7, 'EUR'], [1235, 'JPY'], [1234, 'BHD'], [MAX_AMOUNT, 'EUR']] as const) {
      expect(parseInput(inputFromCents(c, cur), cur)).toBe(c);
    }
    expect(inputFromCents(5280, 'EUR')).toBe('52.80');
    expect(inputFromCents(0, 'EUR')).toBe('');
  });
});
