// What VoiceOver reads for a timeline row. Kept free of React Native so tests can check it.
import type { FieldChange } from '@/core/types';

/** One spoken line: arrows read as "to", dots as pauses. */
export function speak(parts: string[]) {
  return parts.join(', ').replace(/ → /g, ' to ').replace(/ · /g, ', ');
}

/** The spoken parts of an edit: every change, then the reason. Hidden amounts stay hidden. */
export function editSpoken(changes: FieldChange[], reason: string | undefined, hide: boolean, day: (iso: string) => string): string[] {
  const said = changes.map((ch) => {
    switch (ch.field) {
      case 'amount': return hide ? 'Amount changed' : `Amount ${ch.from} → ${ch.to}`;
      case 'note': return 'Note changed';
      case 'split': return 'Split changed';
      case 'date': return `Date ${day(ch.from)} → ${day(ch.to)}`;
      case 'payer': return `Paid by ${ch.from} → ${ch.to}`;
      case 'title': return `Name “${ch.from || 'none'}” → “${ch.to || 'none'}”`;
      default: return `${ch.from} → ${ch.to}`;
    }
  });
  if (reason) said.push(`reason: “${reason}”`);
  return said;
}
