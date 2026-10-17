// UUIDv7 identifiers. The backend accepts only version-7 UUIDs for pots, people, groups, units,
// records and events: a 48-bit millisecond timestamp, then random bits.
function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  if (typeof globalThis.crypto?.getRandomValues === 'function') globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

let lastMs = 0;
let lastSeq = 0;

export function uuidv7(now = Date.now()): string {
  const b = randomBytes(16);
  // Keep ids created in the same millisecond in creation order (12-bit counter in rand_a).
  if (now === lastMs) lastSeq = (lastSeq + 1) & 0xfff;
  else { lastMs = now; lastSeq = ((b[6] & 0x0f) << 8) | b[7]; lastSeq &= 0x7ff; }
  let ms = now;
  for (let i = 5; i >= 0; i--) { b[i] = ms % 256; ms = Math.floor(ms / 256); }
  b[6] = 0x70 | ((lastSeq >> 8) & 0x0f);
  b[7] = lastSeq & 0xff;
  b[8] = 0x80 | (b[8] & 0x3f);
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const isUuidv7 = (s: string) => UUID7.test(s);
