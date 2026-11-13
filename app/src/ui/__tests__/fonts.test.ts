// Latin stays on the original Bricolage and Instrument files. Cyrillic is a unicode-range
// companion under the same family name, and those files stay small.
import { expect, test } from 'vitest';

const fs = await import(/* @vite-ignore */ ['node', 'fs'].join(':')) as {
  readFileSync: (path: string) => Uint8Array;
  readFileSyncStr: never;
};

const read = (file: string) => {
  const path = expect.getState().testPath!.replace(/src\/ui\/__tests__\/fonts\.test\.ts$/, file);
  return fs.readFileSync(path);
};

const text = (file: string) => new TextDecoder().decode(read(file));

test('Latin faces are still Bricolage and Instrument Sans, with swap', () => {
  const tokens = text('src/ui/tokens.ts');
  expect(tokens).toContain("cond: 'BricolageCondensed'");
  expect(tokens).toContain("display: 'Bricolage'");
  expect(tokens).toContain("regular: 'Instrument-400'");
  expect(tokens).toContain('BricolageCondensed-ExtraBold.ttf');
  expect(tokens).toContain('InstrumentSans-Regular.ttf');
  expect(tokens).toContain('display: FontDisplay.SWAP');
  expect(tokens).not.toContain('Inter-Regular');
  expect(tokens).not.toContain('onest-cyrillic');
});

test('Cyrillic is added by unicode-range on those same family names', () => {
  const faces = text('src/ui/cyrillicFaces.ts');
  expect(faces).toContain('unicode-range');
  expect(faces).toContain('size-adjust');
  expect(faces).toContain('sofia-sans-extra-condensed-cyrillic.woff2');
  expect(faces).toContain('onest-cyrillic-400.woff2');
  expect(faces).toContain('onest-cyrillic-800.woff2');
  expect(faces).toContain('fonts.cond');
  expect(faces).toContain('fonts.display');
  expect(faces).toContain('font-display:swap');
});

test('group names fit the band instead of ellipsizing on the web', () => {
  const bands = text('src/features/home/bands.tsx');
  expect(bands).toContain('function GroupTitle');
  expect(bands).toContain('numberOfLines={isWeb ? undefined : 1}');
  expect(bands).toContain('fontFamily: fonts.cond');
});

test('companion files are Cyrillic subsets, not a second copy of the UI', () => {
  for (const file of [
    'assets/fonts/sofia-sans-extra-condensed-cyrillic.woff2',
    'assets/fonts/onest-cyrillic-400.woff2',
    'assets/fonts/onest-cyrillic-500.woff2',
    'assets/fonts/onest-cyrillic-600.woff2',
    'assets/fonts/onest-cyrillic-700.woff2',
    'assets/fonts/onest-cyrillic-800.woff2',
  ]) {
    const buf = read(file);
    expect(buf.byteLength).toBeGreaterThan(1000);
    expect(buf.byteLength).toBeLessThan(16_000);
    // wOF2
    expect(String.fromCharCode(buf[0], buf[1], buf[2], buf[3])).toBe('wOF2');
  }
});
