import { afterEach, expect, test, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ spawn: vi.fn(() => ({ status: 0 })), copy: vi.fn(), mkdir: vi.fn() }));
vi.mock('node:child_process', () => ({ spawnSync: fixture.spawn }));
vi.mock('node:fs', async (original) => ({ ...await original(), copyFileSync: fixture.copy, mkdirSync: fixture.mkdir }));
afterEach(() => vi.unstubAllEnvs());

test('release build gives Kotlin lint enough metaspace without changing generated iOS settings', async () => {
  const values = {
    ANDROID_HOME: 'fixture-sdk', JAVA_HOME: 'fixture-java', NUMA_ANDROID_KEYSTORE: 'fixture-upload.jks',
    NUMA_ANDROID_STORE_PASSWORD: 'synthetic-password', NUMA_ANDROID_KEY_PASSWORD: 'synthetic-password',
    NUMA_ANDROID_AAB_OUTPUT: 'fixture-release.aab', EXPO_PUBLIC_CONVEX_URL: 'http://127.0.0.1:3210',
    EXPO_PUBLIC_CONVEX_SITE_URL: 'http://127.0.0.1:3211', EXPO_PUBLIC_SITE_URL: 'http://127.0.0.1:3211',
  };
  for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
  const argv = process.argv;
  process.argv = ['node', 'android-bundle.mjs'];
  try { await import('../scripts/android-bundle.mjs'); } finally { process.argv = argv; }
  expect(fixture.spawn.mock.calls[0][1]).toEqual(['expo', 'prebuild', '-p', 'android', '--no-install']);
  const [command, args, options] = fixture.spawn.mock.calls[1];
  expect(command).toBe('./gradlew');
  expect(args).toContain('-Dorg.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=1536m');
  expect(args.join(' ')).not.toContain('synthetic-password');
  expect(options.env.EXPO_NO_DOTENV).toBe('1');
  expect(fixture.copy).toHaveBeenCalledOnce();
});
