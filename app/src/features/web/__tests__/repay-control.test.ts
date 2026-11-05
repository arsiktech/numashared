// The web top bar is the only place a repayment is reached by the R key alone.
// The control has to be on screen, named for VoiceOver, and at least 44 pt, with R kept.
import { expect, test } from 'vitest';

const fs = await import(/* @vite-ignore */ ['node', 'fs'].join(':')) as { readFileSync: (p: string, e: string) => string };
const read = (file: string) => fs.readFileSync(expect.getState().testPath!.replace(/features\/web\/__tests__\/repay-control\.test\.ts$/, file), 'utf8');

test('Repay is a visible 44 pt control and the R shortcut still opens it', () => {
  const src = read('features/web/topbar.tsx');
  expect(src).toContain("else if (k === 'r') { e.preventDefault(); openSheet({ type: 'repay' }); }");
  const button = src.slice(src.indexOf("onPress={() => openSheet({ type: 'repay' })}"), src.indexOf('accessibilityLabel="New expense"'));
  expect(button.startsWith("onPress={() => openSheet({ type: 'repay' })}")).toBe(true);
  expect(button).toContain('accessibilityHint="Shortcut: R"');
  expect(button).toContain('height: 44');
  expect(button).toContain('minWidth: 44');
  expect(button).toContain('>Repay</T>');
  expect(button).toContain('<Kbd k="R" />');
});
