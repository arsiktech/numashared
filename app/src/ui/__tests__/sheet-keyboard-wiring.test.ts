import { expect, test } from 'vitest';

const fs = await import(/* @vite-ignore */ ['node', 'fs'].join(':')) as { readFileSync: (path: string, encoding: string) => string };
const read = (file: string) => fs.readFileSync(expect.getState().testPath!.replace(/ui\/__tests__\/sheet-keyboard-wiring\.test\.ts$/, file), 'utf8');

test('sheet ownership surrounds the animated panel and guards both Escape paths', () => {
  const sheet = read('ui/sheet.tsx');
  expect(sheet).toContain('if (root) return takeSheetFocus(root, focusReturn)');
  expect(sheet).toContain("role={isWeb ? 'dialog' : undefined}");
  expect(sheet).toContain('if (root && ownsSheetFocus(root)) close()');
  expect(sheet).toContain('if (!root || !ownsSheetFocus(root)) return;');
  expect(sheet).toContain('escapeSheet(e, close)');
  expect(sheet).not.toContain('el.blur()');
  expect(sheet.indexOf('<View ref={focusRoot}')).toBeLessThan(sheet.indexOf("{bloom && phase !== 'open'"));
});

test('custom category forwards Escape and includes its visible field name', () => {
  const category = read('sheets/add.tsx').split('function NewCategory(')[1];
  expect(category).toContain('const { escape } = useSheet()');
  expect(category).toContain('forwardSheetInputKey(e, escape)');
  expect(category).toContain("'Name it: category name'");
  expect(category).toContain("outlineStyle: 'auto'");
});

test('web Note has a permanent row in each phone layout and native keypad pinning remains', () => {
  const add = read('sheets/add.tsx');
  expect(add).toContain('const rows = isWeb ? <View style={{ gap: 12 }}>{details ? noteLine : null}{slot}</View> : slot');
  expect(add.match(/\{rows\}<\/View>/g)).toHaveLength(3);
  expect(add).toContain('if (pinsKeypad(large, screenH))');
  expect(add).toContain('if (isShortSheet(screenH) || cramped === screenH)');
  expect(add).toContain('onTab: details ? focusNote : undefined');
});

test('zoomed repayment content and desktop popovers provide a scroll container', () => {
  const repay = read('sheets/repay.tsx'), sheet = read('ui/sheet.tsx');
  expect(repay).toContain('const Body = isWeb ? SheetScrollView : View');
  expect(repay).toContain('height={keyHeight(screenH * 0.9, isWeb ? 0 : midH)}');
  expect(sheet).toContain('maxHeight: isWeb ? H - 32 : undefined');
  expect(sheet).toContain("overflowY: 'auto'");
});

test('Home reveals keyboard focus in the scrolling band copy and retains native tap opacity', () => {
  const home = read('app/home.tsx');
  expect(home).toContain("isWeb ? createElement('style'");
  expect(home).toContain('[data-home-bands-copy]:has(:focus-visible) { opacity: 1 !important; transform: none !important; }');
  expect(home).toContain('[data-home-parallax]:has([data-home-bands-copy] :focus-visible) [data-home-bands-display] { visibility: hidden; }');
  expect(home).toContain("dataSet: { 'home-bands-copy': 'true' }");
  expect(home).toContain("dataSet: { 'home-bands-display': 'true' }");
  expect(home).toContain('opacity: 0.02 }, touchCopy]');
});
