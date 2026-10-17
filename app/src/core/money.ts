// Money formatting and keypad input. Amounts are integer minor units ("cents") of an ISO 4217
// currency; nothing here goes through binary floating-point fractions.
import type { Cents } from './types';

/** ISO 4217 currencies whose minor unit is not 2 digits (List One, 2026-01-01). Others use 2. */
const NONSTANDARD_DIGITS: Readonly<Record<string, number>> = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0, RWF: 0,
  UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  CLF: 4, UYW: 4,
};

/** Number of minor-unit digits for a currency code (EUR 2, JPY 0, BHD 3, CLF 4). */
export function currencyDigits(currency: string): number {
  return NONSTANDARD_DIGITS[currency.toUpperCase()] ?? 2;
}

/** 10 ^ currencyDigits(currency). */
export function minorUnitScale(currency: string): number {
  return 10 ** currencyDigits(currency);
}

/**
 * Keypad cap: an entered amount has at most this many digits in minor units, whatever the
 * currency. EUR allows 9,999,999,999.99, JPY and VND allow 999,999,999,999, BHD 999,999,999.999.
 * The value stays far inside Number.MAX_SAFE_INTEGER so sums of many records remain exact.
 */
export const MAX_AMOUNT_DIGITS = 12;
/** The largest amount a single record may carry, in minor units of any currency. */
export const MAX_AMOUNT: Cents = 10 ** MAX_AMOUNT_DIGITS - 1;

/** How many whole-unit digits the keypad accepts for a currency. */
export function maxWholeDigits(currency: string): number {
  return MAX_AMOUNT_DIGITS - currencyDigits(currency);
}

const SYMBOLS: Readonly<Record<string, string>> = {
  EUR: '€', USD: '$', GBP: '£', JPY: '¥', INR: '₹', KRW: '₩', ILS: '₪', NGN: '₦',
  PHP: '₱', VND: '₫', UAH: '₴', TRY: '₺', AUD: 'A$', CAD: 'CA$', NZD: 'NZ$', MXN: 'MX$',
  BRL: 'R$', CNY: 'CN¥', HKD: 'HK$',
};

/** The display symbol, or the code followed by a space ("CHF ") when no unambiguous symbol exists. */
export function currencySymbol(currency: string): string {
  const code = currency.toUpperCase();
  return SYMBOLS[code] ?? `${code} `;
}

export const MINUS = '−';

export type FormatOptions = {
  /** Show the currency symbol. Default true. */
  symbol?: boolean;
  /**
   * 'auto' (default): "−" for negatives only. 'always': also "+" for positives (zero has no sign).
   * 'never': the magnitude only, for copy such as "You owe €3.00".
   */
  sign?: 'auto' | 'always' | 'never';
  /** 'always' (default) keeps every minor digit ("€130.00"); 'auto' drops an all-zero fraction ("€130"). */
  fraction?: 'always' | 'auto';
};

function assertCents(cents: number): void {
  if (!Number.isSafeInteger(cents)) throw new RangeError(`Money must be integer minor units, got ${cents}`);
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function parts(cents: Cents, currency: string): { whole: string; decimal: string } {
  const digits = currencyDigits(currency);
  const scale = 10 ** digits;
  const magnitude = Math.abs(cents);
  const whole = Math.floor(magnitude / scale);
  const fraction = magnitude % scale;
  return {
    whole: groupThousands(String(whole)),
    decimal: digits === 0 ? '' : String(fraction).padStart(digits, '0'),
  };
}

/** "€52.80", "−€3.00", "€1,240.00", "¥1,235", "BHD 1.234". Negative sign is U+2212. */
export function formatMoney(cents: Cents, currency: string, opts: FormatOptions = {}): string {
  assertCents(cents);
  const { symbol = true, sign = 'auto', fraction = 'always' } = opts;
  const { whole, decimal } = parts(cents, currency);
  const showDecimal = decimal !== '' && !(fraction === 'auto' && /^0+$/.test(decimal));
  const number = showDecimal ? `${whole}.${decimal}` : whole;
  let prefix = '';
  if (sign !== 'never') {
    if (cents < 0) prefix = MINUS;
    else if (cents > 0 && sign === 'always') prefix = '+';
  }
  return `${prefix}${symbol ? currencySymbol(currency) : ''}${number}`;
}

/** `decimals` is null for currencies without minor units (JPY). */
export type SplitDisplay = { sign: '' | typeof MINUS; symbol: string; whole: string; decimals: string | null };

/** Parts for the large amount display: { sign: '', symbol: '€', whole: '1,240', decimals: '00' }. */
export function splitDisplay(cents: Cents, currency = 'EUR'): SplitDisplay {
  assertCents(cents);
  const { whole, decimal } = parts(cents, currency);
  return { sign: cents < 0 ? MINUS : '', symbol: currencySymbol(currency), whole, decimals: decimal === '' ? null : decimal };
}

// ---------- keypad input ----------

export type Key = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '.' | 'back';

/** Zero code points of Unicode decimal-digit blocks we normalize (ASCII, Arabic-Indic, Persian, Indic, Thai, fullwidth…). */
const DIGIT_ZEROS = [
  0x30, 0x660, 0x6f0, 0x7c0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66,
  0xde6, 0xe50, 0xed0, 0xf20, 0x1040, 0x17e0, 0x1810, 0xff10,
];

/** Maps Unicode decimal digits to ASCII; other characters pass through unchanged. */
function normalizeDigits(input: string): string {
  let out = '';
  for (const ch of input) {
    const cp = ch.codePointAt(0)!;
    const zero = DIGIT_ZEROS.find((z) => cp >= z && cp <= z + 9);
    out += zero === undefined ? ch : String(cp - zero);
  }
  return out;
}

const INPUT_SHAPE = /^(\d*)(?:\.(\d*))?$/;

/**
 * Keypad state machine, ported from MoneyInput.swift. The input string is what the amount field
 * shows while typing: whole digits, then optionally "." and up to currencyDigits fraction digits.
 * Whole digits are capped at maxWholeDigits(currency) instead of Swift's fixed 6.
 */
export function applyKey(input: string, key: Key, currency: string): string {
  const match = INPUT_SHAPE.exec(normalizeDigits(input));
  let whole = match ? match[1] : '';
  let fraction: string | null = match && match[2] !== undefined ? match[2] : null;
  const digits = currencyDigits(currency);
  if (fraction !== null && digits === 0) fraction = null;
  if (fraction !== null && fraction.length > digits) fraction = fraction.slice(0, digits);

  if (key === 'back') {
    if (fraction !== null) {
      if (fraction === '') {
        fraction = null;
        if (whole === '0') whole = ''; // "0." was produced by '.' on an empty field
      } else fraction = fraction.slice(0, -1);
    } else whole = whole.slice(0, -1);
  } else if (key === '.') {
    if (digits > 0 && fraction === null) {
      fraction = '';
      if (whole === '') whole = '0';
    }
  } else if (/^[0-9]$/.test(key)) {
    if (fraction === null) {
      if (whole === '0' || whole === '') whole = key;
      else if (whole.replace(/^0+/, '').length < maxWholeDigits(currency)) whole += key;
    } else if (fraction.length < digits) {
      fraction += key;
    }
  }
  return fraction === null ? whole : `${whole}.${fraction}`;
}

/**
 * Exact conversion of a typed amount to minor units. Returns null for an empty field, malformed
 * text, more fraction digits than the currency has, or an amount over the keypad cap.
 * "52.8" EUR -> 5280; "0" -> 0; "" -> null.
 */
export function parseInput(input: string, currency: string): Cents | null {
  const match = INPUT_SHAPE.exec(normalizeDigits(input.trim()));
  if (!match) return null;
  const whole = match[1];
  const fraction = match[2] ?? '';
  if (whole === '' && fraction === '') return null;
  const digits = currencyDigits(currency);
  if (fraction.length > digits) return null;
  const significantWhole = whole.replace(/^0+/, '');
  if (significantWhole.length > maxWholeDigits(currency)) return null;
  const minor = Number(significantWhole || '0') * 10 ** digits + Number(fraction.padEnd(digits, '0') || '0');
  return minor <= MAX_AMOUNT ? minor : null;
}

/** The keypad string for an existing amount, for editing: 5280 EUR -> "52.80", 1200 -> "12". */
export function inputFromCents(cents: Cents, currency: string): string {
  assertCents(cents);
  if (cents <= 0) return '';
  const digits = currencyDigits(currency);
  const scale = 10 ** digits;
  const whole = String(Math.floor(cents / scale));
  const fraction = cents % scale;
  return fraction === 0 ? whole : `${whole}.${String(fraction).padStart(digits, '0')}`;
}
