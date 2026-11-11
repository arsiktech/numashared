// History amounts and group names used to mix Bricolage (no Cyrillic) with a Latin-only
// Instrument Sans. Both scripts have to come from the one family the app actually loads.
import { expect, test } from 'vitest';

const fs = await import(/* @vite-ignore */ ['node', 'fs'].join(':')) as {
  readFileSync: (path: string, encoding?: 'utf8') => Uint8Array | string;
};

const root = (file: string) => expect.getState().testPath!.replace(/src\/ui\/__tests__\/fonts\.test\.ts$/, file);

function hasGlyph(buf: Uint8Array, cp: number) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tables = view.getUint16(4);
  let cmap = -1;
  for (let i = 0; i < tables; i++) {
    const at = 12 + i * 16;
    const tag = String.fromCharCode(buf[at], buf[at + 1], buf[at + 2], buf[at + 3]);
    if (tag === 'cmap') cmap = view.getUint32(at + 8);
  }
  if (cmap < 0) return false;
  const count = view.getUint16(cmap + 2);
  let off = -1;
  let format = 0;
  for (let i = 0; i < count; i++) {
    const rec = cmap + 4 + i * 8;
    const platform = view.getUint16(rec);
    const encoding = view.getUint16(rec + 2);
    const sub = cmap + view.getUint32(rec + 4);
    const fmt = view.getUint16(sub);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (unicode && (fmt === 4 || fmt === 12)) {
      off = sub;
      format = fmt;
      if (fmt === 12) break;
    }
  }
  if (off < 0) return false;
  if (format === 12) {
    const groups = view.getUint32(off + 12);
    let lo = 0;
    let hi = groups - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const g = off + 16 + mid * 12;
      const start = view.getUint32(g);
      const end = view.getUint32(g + 4);
      if (cp < start) hi = mid - 1;
      else if (cp > end) lo = mid + 1;
      else return view.getUint32(g + 8) !== 0;
    }
    return false;
  }
  const segCount = view.getUint16(off + 6) / 2;
  const endCount = off + 14;
  const startCount = endCount + segCount * 2 + 2;
  const idDelta = startCount + segCount * 2;
  const idRange = idDelta + segCount * 2;
  for (let i = 0; i < segCount; i++) {
    const end = view.getUint16(endCount + i * 2);
    const start = view.getUint16(startCount + i * 2);
    if (cp < start || cp > end) continue;
    const delta = view.getInt16(idDelta + i * 2);
    const range = view.getUint16(idRange + i * 2);
    if (range === 0) return ((cp + delta) & 0xffff) !== 0;
    const glyph = view.getUint16(idRange + i * 2 + range + (cp - start) * 2);
    return glyph !== 0 && ((glyph + delta) & 0xffff) !== 0;
  }
  return false;
}

const NEEDED = {
  You: 0x59,
  euro: 0x20ac,
  zcaron: 0x017e, // Latvian ž
  amacron: 0x0101, // Latvian ā
  Yu: 0x042e,
  yu: 0x044e,
  sha: 0x0448,
  de: 0x0434,
};

for (const file of ['Inter-Regular.ttf', 'Inter-Medium.ttf', 'Inter-SemiBold.ttf', 'Inter-Bold.ttf']) {
  test(`${file} draws Latin, Latvian and Cyrillic from the same file`, () => {
    const buf = fs.readFileSync(root(`assets/fonts/${file}`)) as Uint8Array;
    expect(buf.byteLength).toBeLessThan(120_000);
    for (const [name, cp] of Object.entries(NEEDED)) {
      expect(hasGlyph(buf, cp), name).toBe(true);
    }
  });
}

test('the app registers one family, with swap, and does not load the old display faces', () => {
  const tokens = fs.readFileSync(root('src/ui/tokens.ts'), 'utf8') as string;
  expect(tokens).toContain('display: FontDisplay.SWAP');
  expect(tokens).toContain("regular: 'Inter-400'");
  expect(tokens).toContain("bold: 'Inter-700'");
  expect(tokens).toContain('Inter-Regular.ttf');
  expect(tokens).not.toMatch(/require\([^)]*(?:Bricolage|InstrumentSans)/);
  const thread = fs.readFileSync(root('src/features/history/thread.tsx'), 'utf8') as string;
  expect(thread).not.toContain('fonts.display');
  expect(thread).not.toContain('fontSize: 26');
  const bands = fs.readFileSync(root('src/features/home/bands.tsx'), 'utf8') as string;
  expect(bands).not.toContain('fonts.cond');
  expect(bands).not.toContain('fontSize: 74');
  expect(bands).not.toContain('fontSize: 56');
});
