import { expect, test } from 'vitest';

test('Android resizes the screen and sheet host above the keyboard without changing iOS avoidance', async () => {
  const fs = await import(/* @vite-ignore */ ['node', 'fs'].join(':')) as { readFileSync: (p: string, e: string) => string };
  const root = expect.getState().testPath!.replace(/src\/ui\/__tests__\/keyboard\.test\.ts$/, '');
  const shell = fs.readFileSync(`${root}src/app/_layout.tsx`, 'utf8');
  const screen = fs.readFileSync(`${root}src/features/onboarding/chrome.tsx`, 'utf8');
  const config = JSON.parse(fs.readFileSync(`${root}app.json`, 'utf8'));
  expect(config.expo.android.softwareKeyboardLayoutMode).toBe('resize');
  expect(shell).toMatch(/<KeyboardAvoidingView[^>]*behavior=\{isAndroid \? 'height' : undefined\}[^>]*enabled=\{isAndroid\}/);
  expect(shell.indexOf('<SheetHost />')).toBeLessThan(shell.indexOf('</KeyboardAvoidingView>'));
  expect(screen).toContain("behavior={isIOS ? 'padding' : undefined}");
});
