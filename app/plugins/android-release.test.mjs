import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
const require = createRequire(import.meta.url);
const plugin = require('./with-android-release.js');

describe('Android release configuration', () => {
  test('uses versionCode 21 without changing the iOS build', () => {
    const { expo } = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8'));
    expect(expo.version).toBe('2.0.0');
    expect(expo.android.versionCode).toBe(21);
    expect(expo.android.package).toBe('tech.arsik.numashared');
    expect(expo.ios.buildNumber).toBe('14');
  });

  test('replaces debug release signing and requires credentials', async () => {
    const config = plugin({ name: 'test', slug: 'test' });
    // Exercise the mod itself, without writing a native tree.
    const mod = config.mods.android.appBuildGradle;
    const template = 'android {\n    signingConfigs {\n        debug {}\n    }\n    buildTypes { release { signingConfig signingConfigs.debug } }\n}';
    const result = await mod({ ...config, modRequest: { nextMod: (v) => v }, modResults: { language: 'groovy', contents: template } });
    expect(result.modResults.contents).toContain('signingConfig signingConfigs.upload');
    expect(result.modResults.contents).not.toContain('signingConfig signingConfigs.debug');
    expect(result.modResults.contents).toContain('Missing release signing environment:');
    const again = await mod({ ...config, modRequest: { nextMod: (v) => v }, modResults: result.modResults });
    expect(again.modResults.contents).toBe(result.modResults.contents);
  });
});
