// Identifiers and dates for new records. Every id is a UUIDv7, the format the server requires, so a
// household made offline can move to the server without renaming anything.
import { uuidv7 } from '../sync/uuid';

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

function randomString(n: number, alphabet = ALPHABET) {
  const bytes = new Uint8Array(n);
  if (typeof globalThis.crypto?.getRandomValues === 'function') globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256);
  let out = '';
  for (let i = 0; i < n; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/** The prefix only documents intent at call sites. */
export const newId = (_prefix?: string) => uuidv7();

/** Six characters, no look-alikes (no 0/O, 1/I/L). Shown as "K7Q 4MZ". */
export const inviteCode = () => randomString(6, 'ABCDEFGHJKMNPQRSTUVWXYZ23456789');

export const formatInviteCode = (c: string) => `${c.slice(0, 3)} ${c.slice(3)}`;

export const todayISO = (d = new Date()) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

export const isoToDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};
