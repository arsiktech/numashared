// Keyboard rules for the Add and Repay sheets on the web, and amount typing for every keypad.
// Kept free of React Native so tests can check it.
import { useCallback, useEffect, useRef } from 'react';
import { applyKey, typeAmount, type Key } from '@/core';

/**
 * Tab jumps to the note only as the first key press, while nothing has focus and Shift isn't held.
 * After that Tab and Shift+Tab move through the controls as usual.
 */
export function tabJumpsToNote(nothingFocused: boolean, shift: boolean) {
  return nothingFocused && !shift;
}

/**
 * The keys typed into an amount field and the text they produced. `from` is the text the field
 * held before the first of them (a preset, or an amount being edited); empty when it was empty.
 */
export type TypedAmount = { keys: readonly Key[]; input: string; from?: string };

export type KeyResult = {
  /** Keys and text after this key. Keep them only when `accepted`. */
  next: TypedAmount;
  /** False when the key changed nothing (a digit past the cap or the decimal places). */
  accepted: boolean;
  /** A third digit after a separator that may still turn out to be thousands ("1.600" before ","). */
  maybeThousands: boolean;
};

/**
 * One more key in an amount field. Every key typed so far is replayed through typeAmount, so
 * "1.600,00" from a European keyboard means 1600. `start` is the field's current text: when it is
 * not what `prev` produced (the field was filled some other way), typing continues from that text
 * as it stands. Its decimal point was not typed here, so it is never taken for a thousands
 * separator: "5.50" typed onto a preset "1600.00" changes nothing, it does not become 1600005.50.
 */
export function typeKey(prev: TypedAmount, start: string, k: Key, currency: string): KeyResult {
  const continuing = prev.input === start;
  let from = continuing ? prev.from ?? '' : start;
  let keys = continuing ? prev.keys : [];
  if (k !== 'back') keys = [...keys, k];
  else if (keys.length) keys = keys.slice(0, -1);
  else from = applyKey(from, 'back', currency);
  const input = typeAmount(keys, currency, from);
  const unchanged = k !== 'back' && input === start;
  const maybeThousands = unchanged && /^[0-9]$/.test(k) && keys.length >= 4 && keys[keys.length - 4] === '.'
    && keys.slice(-3).every((x) => /^[0-9]$/.test(x));
  return { next: { keys, input, from }, accepted: !unchanged || maybeThousands, maybeThousands };
}

/**
 * typeKey for a screen that keeps the amount in state. Returns the key handler: it gives the new
 * text, or null when the key changed nothing. Refs, not the render's text, so fast typing on a
 * keyboard doesn't lose keys between renders.
 */
export function useAmountKeys(input: string, currency: string) {
  const typed = useRef<TypedAmount>({ keys: [], input: '' });
  const live = useRef(input);
  useEffect(() => { live.current = input; }, [input]);
  return useCallback((k: Key): string | null => {
    const r = typeKey(typed.current, live.current, k, currency);
    if (!r.accepted) return null;
    typed.current = r.next;
    live.current = r.next.input;
    return r.next.input;
  }, [currency]);
}
