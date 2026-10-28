import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ spawn: vi.fn(() => ({ status: 0 })), copy: vi.fn(), mkdir: vi.fn() }));
vi.mock('node:child_process', () => ({ spawnSync: fixture.spawn }));
vi.mock('node:fs', async (original) => ({ ...await original(), copyFileSync: fixture.copy, mkdirSync: fixture.mkdir }));
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  const values = {
    ANDROID_HOME: 'fixture-sdk', JAVA_HOME: 'fixture-java', NUMA_ANDROID_KEYSTORE: 'fixture-upload.jks',
    NUMA_ANDROID_STORE_PASSWORD: 'synthetic-password', NUMA_ANDROID_KEY_PASSWORD: 'synthetic-password',
    NUMA_ANDROID_AAB_OUTPUT: 'fixture-release.aab',
  };
  for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
  for (const key of ['EXPO_PUBLIC_CONVEX_URL', 'EXPO_PUBLIC_CONVEX_SITE_URL', 'EXPO_PUBLIC_SITE_URL', 'NUMA_DISABLE_UPDATES']) vi.stubEnv(key, undefined);
});
afterEach(() => vi.unstubAllEnvs());

async function build() {
  const argv = process.argv;
  process.argv = ['node', 'android-bundle.mjs'];
  try { await import('../scripts/android-bundle.mjs'); } finally { process.argv = argv; }
}

function isolated() {
  vi.stubEnv('EXPO_PUBLIC_CONVEX_URL', 'http://127.0.0.1:3210');
  vi.stubEnv('EXPO_PUBLIC_CONVEX_SITE_URL', 'http://127.0.0.1:3211');
  vi.stubEnv('EXPO_PUBLIC_SITE_URL', 'http://127.0.0.1:3211');
  vi.stubEnv('NUMA_DISABLE_UPDATES', '1');
}

test('release build gives Kotlin lint enough metaspace without changing generated iOS settings', async () => {
  isolated();
  await build();
  expect(fixture.spawn.mock.calls[0][1]).toEqual(['expo', 'prebuild', '-p', 'android', '--no-install']);
  const [command, args, options] = fixture.spawn.mock.calls[1];
  expect(command).toBe('./gradlew');
  expect(args).toContain('-Dorg.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=1536m');
  expect(args.join(' ')).not.toContain('synthetic-password');
  expect(options.env.EXPO_NO_DOTENV).toBe('1');
  expect(fixture.copy).toHaveBeenCalledOnce();
});

test('store build uses production config defaults when no URL overrides are set', async () => {
  await build();
  const env = fixture.spawn.mock.calls[0][2].env;
  expect(env.EXPO_PUBLIC_CONVEX_URL).toBeUndefined();
  expect(env.EXPO_PUBLIC_CONVEX_SITE_URL).toBeUndefined();
  expect(env.EXPO_PUBLIC_SITE_URL).toBeUndefined();
  expect(env.NUMA_DISABLE_UPDATES).toBeUndefined();
  expect(env.EXPO_NO_DOTENV).toBe('1');
});

test.each(['partial', 'mixed', 'updates'])('rejects unsafe %s loopback configuration before prebuild', async (kind) => {
  isolated();
  if (kind === 'partial') vi.stubEnv('EXPO_PUBLIC_SITE_URL', undefined);
  if (kind === 'mixed') vi.stubEnv('EXPO_PUBLIC_SITE_URL', 'https://example.com');
  if (kind === 'updates') vi.stubEnv('NUMA_DISABLE_UPDATES', undefined);
  await expect(build()).rejects.toThrow('Isolated QA requires all three loopback URLs and NUMA_DISABLE_UPDATES=1');
  expect(fixture.spawn).not.toHaveBeenCalled();
});

test('rejects an empty URL override rather than embedding an invalid backend address', async () => {
  vi.stubEnv('EXPO_PUBLIC_CONVEX_URL', '');
  await expect(build()).rejects.toThrow('Invalid URL');
  expect(fixture.spawn).not.toHaveBeenCalled();
});

test('rejects public plaintext HTTP before prebuild', async () => {
  vi.stubEnv('EXPO_PUBLIC_SITE_URL', 'http://example.com');
  await expect(build()).rejects.toThrow('must use HTTPS or loopback');
  expect(fixture.spawn).not.toHaveBeenCalled();
});
