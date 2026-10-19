import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
// App Store is a platform name, not the disallowed product name suffix “App”.
const staleBrand = /\bNuma\b(?! Shared\b)|\bNumaShared\b|\bNuma Shared App\b(?! Store\b)/;
const check = (text, path) => {
  // URL-encoded spaces in existing mail subjects are representation, not stale copy.
  const match = text.replaceAll('%20', ' ').match(staleBrand);
  assert.equal(match?.[0], undefined, `${path}: stale product name ${match?.[0]}`);
};

test('native display name and localized product copy use Numa Shared', () => {
  const plist = read('ios/NumaShared/NumaShared/Info.plist');
  assert.match(plist, /<key>CFBundleDisplayName<\/key>\s*<string>Numa Shared<\/string>/);
  const dir = 'ios/NumaShared/NumaShared/';
  for (const file of readdirSync(fileURLToPath(new URL(dir, root))).filter(f => f.endsWith('.swift'))) {
    const source = read(dir + file);
    // Restrict to localizable user copy; package, type, storage and URL names are not branding.
    for (const match of source.matchAll(/String\(localized: "((?:\\.|[^"\\])*)"/g)) check(match[1], file);
  }
  const catalog = JSON.parse(read(dir + 'Localizable.xcstrings'));
  for (const key of Object.keys(catalog.strings)) check(key, 'Localizable.xcstrings');
});

test('marketing, support, privacy, invite and store copy keep the exact brand', () => {
  for (const path of ['web-marketing/index.html', 'web-marketing/privacy.html', 'web-marketing/support.html', 'convex/lib/webContent.ts']) {
    check(read(path), path);
    assert.match(read(path), /Numa Shared/, path);
  }
  for (const file of readdirSync(fileURLToPath(new URL('app-store/en-US/', root)))) {
    if (file.endsWith('.txt')) check(read('app-store/en-US/' + file), file);
  }
});

test('current product documentation does not shorten this product name', () => {
  for (const path of ['docs/IDENTITY.md', 'PRODUCT.md']) {
    // Preserve the explicit other-product separation and historical artifact paths.
    const text = read(path).split('\n').filter(line => !line.includes('main Numa app')).join('\n').replace(/`[^`]*`/g, '');
    check(text, path);
  }
});

// App source: string literals and JSX text are user copy. Comments are not, and identifiers such as
// NumaShared never match a bare “Numa” word, so only the shortened name and the “App” suffix fail.
const appBrand = /\bNuma\b(?! Shared\b)|\bNuma Shared App\b(?! Store\b)/;
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
const appCopyMatch = (source) => stripComments(source).match(appBrand)?.[0];
const sourceFiles = (dir) => readdirSync(fileURLToPath(new URL(dir, root))).flatMap((name) => {
  const path = dir + name;
  if (statSync(fileURLToPath(new URL(path, root))).isDirectory()) return sourceFiles(path + '/');
  return /\.(ts|tsx)$/.test(name) ? [path] : [];
});

test('app copy check catches a shortened name in strings and JSX text, not in comments', () => {
  assert.equal(appCopyMatch("const a = 'Numa only records it.';"), 'Numa');
  assert.equal(appCopyMatch('<T>Paying directly is fine: Numa keeps it right.</T>'), 'Numa');
  assert.equal(appCopyMatch('// Numa never moves money.\nconst a = 1;'), undefined);
  assert.equal(appCopyMatch("const a = 'Numa Shared only records it.'; // https://example.com"), undefined);
  assert.equal(appCopyMatch('const NumaShared = 1;'), undefined);
});

test('Expo app copy uses the exact product name', () => {
  const files = sourceFiles('app/src/');
  assert.ok(files.length > 0, 'no app source files found');
  for (const path of files) {
    const match = appCopyMatch(read(path));
    assert.equal(match, undefined, `${path}: stale product name ${match}`);
  }
});
