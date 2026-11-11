// With "Hide amounts" on, the Balance sheet keeps amounts out of what screen readers say too.
import { expect, test } from 'vitest';

const fs = await import(/* @vite-ignore */ ['node', 'fs'].join(':')) as { readFileSync: (p: string, e: string) => string };
const src = fs.readFileSync(expect.getState().testPath!.replace(/__tests__\/hidden-labels\.test\.ts$/, 'content.tsx'), 'utf8');

test('every amount on the Balance sheet, spoken or shown, passes hide', () => {
  const calls = src.match(/\bmoney\(h, [^`}]*\)/g) ?? [];
  expect(calls.length).toBeGreaterThan(4);
  for (const call of calls) expect(call).toMatch(/, hide\)$/);
});
