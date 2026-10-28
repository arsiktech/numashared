import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Household } from '../../core/types';
const h = vi.hoisted(() => ({
  accountId: 'account-a', households: [] as Household[], calls: [] as Record<string, unknown>[],
  resolve: null as null | ((value: unknown) => void), switches: [] as string[], clients: 0,
  auth: [] as ((options: { forceRefreshToken: boolean }) => Promise<string | null>)[],
}));
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, AppState: { addEventListener() {} } }));
vi.mock('convex/browser', () => ({ ConvexClient: class {
  constructor() { h.clients++; }
  setAuth(getToken: typeof h.auth[number]) { h.auth.push(getToken); }
  onUpdate() { return () => {}; }
  close() {}
  async query() { return []; }
  mutation(_ref: unknown, args: Record<string, unknown>) {
    h.calls.push(args);
    if (h.accountId === 'account-b') return Promise.reject({ data: { code: 'INVITE_INVALID', retryable: false } });
    return new Promise(resolve => { h.resolve = resolve; });
  }
} }));
vi.mock('../../store/store', () => ({
  getState: () => ({ households: h.households, prefs: { notifications: false } }),
  putHousehold: (household: Household) => { h.households.push(household); },
  switchHousehold: (id: string) => { h.switches.push(id); },
  removeHousehold() {}, claimParked() {}, forgetAccount() {}, showAccount() {},
}));
vi.mock('../auth', () => ({
  currentSession: () => ({ accountId: h.accountId }), loadSession: async () => ({ accountId: h.accountId }),
  subscribeSession: () => () => {}, accessToken: async () => 'synthetic-access', forgetSession: async () => {},
  post: async () => {}, readDeletion: async () => null, writeDeletion: async () => {},
  withCurrentSession: async () => { throw new Error('Unexpected deletion in invite regression'); },
  signInWithApple: async () => {}, signInWithGoogle: async () => {}, signOutSession: async () => {},
}));
vi.mock('../config', () => ({ CONVEX_URL: 'https://sync.invalid', SITE_URL: 'https://site.invalid' }));
const preview = { status: 'active', kind: 'perMember', potName: 'Synthetic', expiresAt: 1800000000000, minimumReaderSchemaVersion: 2, claimTicket: 'synthetic-ticket' } as const;
beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); h.accountId = 'account-a'; h.households = []; h.calls = []; h.resolve = null; h.switches = []; h.clients = 0; h.auth = []; });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

test('a screen timeout leaves one exact pending claim available to Retry', async () => {
  const runtime = await import('../runtime');
  const first = runtime.joinWithInvite(preview);
  const failed = expect(first).rejects.toMatchObject({ data: { code: 'TRANSPORT_UNAVAILABLE' } });
  await vi.advanceTimersByTimeAsync(30001); await failed;
  const retry = runtime.joinWithInvite(preview);
  expect(h.calls).toHaveLength(1);
  h.resolve!({ potId: 'synthetic-pot', memberId: 'synthetic-member' });
  await expect(retry).resolves.toEqual({ status: 'joined', householdId: 'synthetic-pot' });
  expect(h.calls).toHaveLength(1); expect(h.switches).toEqual(['synthetic-pot']);
});

test('a late claim reply cannot adopt or navigate another account', async () => {
  const runtime = await import('../runtime'); const first = runtime.joinWithInvite(preview);
  const failed = expect(first).rejects.toMatchObject({ data: { code: 'ACCOUNT_CHANGED' } });
  h.accountId = 'account-b';
  expect(await h.auth[0]({ forceRefreshToken: true })).toBeNull();
  h.resolve!({ potId: 'synthetic-pot-a', memberId: 'synthetic-member-a' }); await failed;
  expect(h.households).toEqual([]); expect(h.switches).toEqual([]);
  await expect(runtime.joinWithInvite(preview)).rejects.toMatchObject({ data: { code: 'INVITE_INVALID' } });
  expect(h.calls).toHaveLength(2); expect(h.calls[1]).not.toEqual(h.calls[0]); expect(h.clients).toBe(2);
});
