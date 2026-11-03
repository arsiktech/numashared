import { expect, test } from 'vitest';

test('Android resizes the screen and sheet host above the keyboard without changing iOS avoidance', async () => {
  const fs = await import(/* @vite-ignore */ ['node', 'fs'].join(':')) as { readFileSync: (p: string, e: string) => string };
  const root = expect.getState().testPath!.replace(/src\/ui\/__tests__\/keyboard\.test\.ts$/, '');
  const shell = fs.readFileSync(`${root}src/app/_layout.tsx`, 'utf8');
  const screen = fs.readFileSync(`${root}src/features/onboarding/chrome.tsx`, 'utf8');
  const config = JSON.parse(fs.readFileSync(`${root}app.json`, 'utf8'));
  expect(config.expo.android.softwareKeyboardLayoutMode).toBe('resize');
  expect(shell).toMatch(/<KeyboardAvoidingView[^>]*behavior=\{isAndroid \? 'padding' : undefined\}[^>]*enabled=\{isAndroid\}/);
  expect(shell).toMatch(/enabled=\{isAndroid\}>\s*<View style=\{\{ flex: 1 \}\}>/);
  expect(shell.indexOf('<SheetHost />')).toBeLessThan(shell.indexOf('</KeyboardAvoidingView>'));
  expect(screen).toContain("behavior={isIOS ? 'padding' : undefined}");
});

test('Android repayment scrolls the form and keeps its receipt outside the scroller', async () => {
  const fs = await import(/* @vite-ignore */ ['node', 'fs'].join(':')) as { readFileSync: (p: string, e: string) => string };
  const path = expect.getState().testPath!.replace(/ui\/__tests__\/keyboard\.test\.ts$/, 'sheets/repay.tsx');
  const repay = fs.readFileSync(path, 'utf8');
  expect(repay).toMatch(/isAndroid \? \(\s*<SheetScrollView[^>]*keyboardShouldPersistTaps="handled">\s*\{form\}\s*<\/SheetScrollView>\s*\) : form\}\s*<Receipt/);
  expect(repay).toContain('minHeight: isAndroid ? 4 * 44 + 8 : 0');
});
