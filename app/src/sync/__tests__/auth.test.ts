// Review item 13: a token refresh that finishes after sign-out must not restore the session.
import { describe, expect, test, vi } from 'vitest';

const keychain = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock('expo-apple-authentication', () => ({}));
vi.mock('expo-crypto', () => ({}));
vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK: 0,
  getItemAsync: async (k: string) => keychain.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => { keychain.set(k, v); },
  deleteItemAsync: async (k: string) => { keychain.delete(k); },
}));
vi.mock('../engine', () => ({ base64url: () => '' }));

const auth = await import('../auth');

describe('session generation', () => {
  test('sign-out during a refresh stays signed out', async () => {
    keychain.set('numa-shared.session.v1', JSON.stringify({ accountId: 'A', refreshToken: 'r1', refreshExpiresAt: Date.now() + 86_400_000 }));
    let finishRefresh!: () => void;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/auth/refresh')) {
        await new Promise<void>((r) => { finishRefresh = r; });
        return { ok: true, json: async () => ({ accessToken: 'a2', accessTokenExpiresInSeconds: 300, refreshToken: 'r2', refreshExpiresAt: Date.now() + 86_400_000, accountId: 'A' }) };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);

    await auth.loadSession();
    const token = auth.accessToken(true);
    await vi.waitFor(() => expect(finishRefresh).toBeTypeOf('function'));
    await auth.signOutSession();
    finishRefresh();

    expect(await token).toBeNull();
    expect(auth.currentSession()).toBeNull();
    expect(keychain.has('numa-shared.session.v1')).toBe(false);
    vi.unstubAllGlobals();
  });
});
