// Pure helpers for the setup screens: common currencies, regrouping people by taps, and the
// deterministic invite pattern.
import type { ID } from '@/core/types';
import { MAX_GROUPS } from '@/core/types';

export const CURRENCIES: { code: string; name: string }[] = [
  { code: 'EUR', name: 'Euro' },
  { code: 'USD', name: 'US dollar' },
  { code: 'GBP', name: 'British pound' },
  { code: 'CHF', name: 'Swiss franc' },
  { code: 'SEK', name: 'Swedish krona' },
  { code: 'NOK', name: 'Norwegian krone' },
  { code: 'DKK', name: 'Danish krone' },
  { code: 'PLN', name: 'Polish złoty' },
  { code: 'CZK', name: 'Czech koruna' },
  { code: 'CAD', name: 'Canadian dollar' },
  { code: 'AUD', name: 'Australian dollar' },
  { code: 'JPY', name: 'Japanese yen' },
];

/** "Euro (EUR)", or the bare code for anything outside the common list. */
export const currencyLabel = (code: string) => {
  const c = CURRENCIES.find((x) => x.code === code);
  return c ? `${c.name} (${c.code})` : code;
};

export type Arrangement = ID[][];

/** People who pay as one: a group is one or two people (a couple). */
export const MAX_GROUP_SIZE = 2;

/** Move a person into group `target` (an index) or into a new group ('new'). Empty groups drop out. */
export function movePerson(groups: Arrangement, personId: ID, target: number | 'new'): Arrangement {
  const from = groups.findIndex((g) => g.includes(personId));
  if (from < 0) return groups;
  if (target === from) return groups;
  if (target !== 'new' && groups[target].length >= MAX_GROUP_SIZE) return groups;
  if (target === 'new') {
    if (groups[from].length === 1 || groups.length >= MAX_GROUPS) return groups;
    return [...groups.map((g) => g.filter((id) => id !== personId)), [personId]];
  }
  const next = groups.map((g, i) => (i === target ? [...g, personId] : g.filter((id) => id !== personId)));
  return next.filter((g) => g.length > 0);
}

/** Six-character invite code shown as "K7Q 4MZ". Accepts any typing; keeps letters and digits. */
export function cleanCode(raw: string) {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}
export const showCode = (code: string) => (code.length > 3 ? `${code.slice(0, 3)} ${code.slice(3)}` : code);

/**
 * A 21 x 21 module pattern that looks like a QR code, derived only from the invite code so the same
 * household always draws the same picture. It is decoration: the code under it is what people type.
 */
export function invitePattern(code: string, n = 21): boolean[][] {
  let seed = 2166136261;
  for (const ch of code) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619) >>> 0;
  const rand = () => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed / 4294967296;
  };
  const inFinder = (x: number, y: number) =>
    (x < 8 && y < 8) || (x >= n - 8 && y < 8) || (x < 8 && y >= n - 8);
  const grid: boolean[][] = [];
  for (let y = 0; y < n; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < n; x++) row.push(!inFinder(x, y) && rand() < 0.4);
    grid.push(row);
  }
  return grid;
}
