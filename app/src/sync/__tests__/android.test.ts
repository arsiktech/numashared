import { afterEach, expect, test, vi } from 'vitest';
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

const notifications = vi.hoisted(() => ({ requestPermissionsAsync: vi.fn(), getDevicePushTokenAsync: vi.fn() }));
vi.mock('react-native', () => ({ Platform: { OS: 'android' }, AppState: { addEventListener: vi.fn() } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock('expo-apple-authentication', () => ({ isAvailableAsync: vi.fn(() => { throw new Error('iOS only'); }) }));
vi.mock('expo-crypto', () => ({}));
vi.mock('expo-secure-store', () => ({}));
vi.mock('expo-notifications', () => notifications);
vi.mock('../config', () => ({ CONVEX_URL: 'http://127.0.0.1:3210', SITE_URL: 'http://127.0.0.1:3211' }));
vi.mock('../../store/store', () => ({
  getState: () => ({ households: [], prefs: { notifications: true } }),
  showAccount: vi.fn(),
}));
vi.mock('../auth', async (importOriginal) => ({
  ...await importOriginal<typeof import('../auth')>(),
  currentSession: () => ({ accountId: 'synthetic-android' }),
  loadSession: async () => ({ accountId: 'synthetic-android' }),
  subscribeSession: vi.fn(),
  readDeletion: async () => null,
}));
vi.mock('convex/browser', () => ({
  ConvexClient: class {
    setAuth() {}
    onUpdate() { return () => {}; }
  },
}));

const { appleSignInSupported } = await import('../auth');
const { getSyncStatus, registerPush, startSyncRuntime } = await import('../runtime');

test('Android never offers the iOS-only Apple sign-in API', async () => {
  expect(await appleSignInSupported()).toBe(false);
});

test('Android without push support never requests permission or an FCM token', async () => {
  vi.useFakeTimers();
  startSyncRuntime();
  await Promise.resolve();
  expect(getSyncStatus().signedIn).toBe(true);
  expect(await registerPush(true)).toBe(false);
  expect(await registerPush(false)).toBe(false);
  expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  expect(notifications.getDevicePushTokenAsync).not.toHaveBeenCalled();
});
