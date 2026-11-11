// Amount typing shared by the Add, Repay and Opening balance keypads.
import { expect, test } from 'vitest';
import type { Key } from '@/core';
import { typeKey, type TypedAmount } from '../keys';

/** Types each key into an empty field the way a screen does, keeping only accepted keys. */
function type(keys: string, currency = 'EUR', from: TypedAmount = { keys: [], input: '' }) {
  let typed = from;
  for (const k of keys.split(' ') as Key[]) {
    const r = typeKey(typed, typed.input, k, currency);
    if (r.accepted) typed = r.next;
  }
  return typed;
}

test('a separator before exactly three digits and another separator is a thousands separator', () => {
  expect(type('1 . 6 0 0 . 0 0').input).toBe('1600.00');
});

test('a single separator is the decimal point', () => {
  expect(type('1 . 5').input).toBe('1.5');
});

test('backspace after a thousands sequence removes the last key typed', () => {
  expect(type('1 . 6 0 0 .').input).toBe('1600.');
  expect(type('1 . 6 0 0 . back').input).toBe('1.60');
  expect(type('1 . 6 0 0 . back back').input).toBe('1.60');
  expect(type('1 . 6 0 0 . back back back').input).toBe('1.6');
});

test('a third decimal digit is held as possible thousands; a fourth is refused', () => {
  const held = typeKey(type('1 . 6 0'), '1.60', '0', 'EUR');
  expect(held).toMatchObject({ accepted: true, maybeThousands: true, next: { input: '1.60' } });
  const refused = typeKey(held.next, '1.60', '5', 'EUR');
  expect(refused).toMatchObject({ accepted: false, maybeThousands: false });
});

test('a field filled some other way is typed on from its own text', () => {
  const r = typeKey({ keys: ['9'], input: '9' }, '12.5', '0', 'EUR');
  expect(r.next.input).toBe('12.50');
});

/** Types onto a field that already holds `start` (a preset, or an amount being edited). */
function typeOnto(start: string, keys: string, currency = 'EUR') {
  let typed: TypedAmount = { keys: [], input: '' };
  let field = start;
  for (const k of keys.split(' ') as Key[]) {
    const r = typeKey(typed, field, k, currency);
    if (r.accepted) { typed = r.next; field = r.next.input; }
  }
  return field;
}

test('the decimal point of a preset amount is never taken for a thousands separator', () => {
  // Repay opens with the whole amount filled in. Typing onto it must not multiply it.
  expect(typeOnto('1600.00', '5 . 5 0')).toBe('1600.00');
  expect(typeOnto('1600.00', '2 . 5 0 0 . 5 0')).toBe('1600.00');
});

test('typing continues from a preset that has room, and backspace shortens it', () => {
  expect(typeOnto('12', '. 5')).toBe('12.5');
  expect(typeOnto('1600.00', 'back back 5')).toBe('1600.5');
  expect(typeOnto('1600.00', 'back back back back back back back 7')).toBe('7');
});

test('separators typed after a preset still follow the thousands rule among themselves', () => {
  expect(typeOnto('1', '. 6 0 0 . 0 0')).toBe('1600.00');
});

test('a currency without decimals ignores the separator', () => {
  expect(type('1 . 5', 'JPY').input).toBe('15');
});
