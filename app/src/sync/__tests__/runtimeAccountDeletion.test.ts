import { beforeEach, expect, test, vi } from 'vitest';
import type { PendingDeletion } from '../accountDeletion';

const fixture = vi.hoisted(() => ({
  session: null as { accountId: string; refreshToken: string } | null,
  pending: null as PendingDeletion | null,
  post: vi.fn(), forgetSession: vi.fn(), forgetAccount: vi.fn(),
}));
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, AppState: { addEventListener: vi.fn() } }));
vi.mock('../config', () => ({ CONVEX_URL: 'http://127.0.0.1:3210', SITE_URL: 'http://127.0.0.1:3211' }));
vi.mock('../auth', () => ({
  currentSession: () => fixture.session,
  readDeletion: async () => fixture.pending,
  writeDeletion: async (p: PendingDeletion | null) => { fixture.pending = p; },
  post: fixture.post, forgetSession: fixture.forgetSession,
  accessToken: vi.fn(), loadSession: vi.fn(), subscribeSession: vi.fn(),
  signInWithApple: vi.fn(), signInWithGoogle: vi.fn(), signOutSession: vi.fn(),
}));
vi.mock('../../store/store', () => ({
  forgetAccount: fixture.forgetAccount, getState: () => ({ households: [] }),
  claimParked: vi.fn(), putHousehold: vi.fn(), removeHousehold: vi.fn(), showAccount: vi.fn(), switchHousehold: vi.fn(),
}));
const { deleteAccount } = await import('../runtime');

beforeEach(() => {
  vi.clearAllMocks();
  fixture.pending = { accountId: 'A', requestId: '01890f5e-7b00-7000-8000-00000000fa01', timeZone: 'Europe/Madrid', serverDone: true };
  fixture.session = { accountId: 'B', refreshToken: 'synthetic-B' };
});

test('completed deletion cleans only its account without signing out a replacement account', async () => {
  await deleteAccount();
  expect(fixture.post).not.toHaveBeenCalled();
  expect(fixture.forgetAccount).toHaveBeenCalledExactlyOnceWith('A');
  expect(fixture.forgetSession).not.toHaveBeenCalled();
  expect(fixture.session?.accountId).toBe('B');
  expect(fixture.pending).toBeNull();
});

test('an account switch while deletion awaits the server preserves the replacement session', async () => {
  fixture.pending!.serverDone = false;
  fixture.session = { accountId: 'A', refreshToken: 'synthetic-A' };
  fixture.post.mockImplementation(async () => {
    fixture.session = { accountId: 'B', refreshToken: 'synthetic-B' };
    return { deleted: true };
  });
  await deleteAccount();
  expect(fixture.forgetAccount).toHaveBeenCalledExactlyOnceWith('A');
  expect(fixture.forgetSession).not.toHaveBeenCalled();
  expect(fixture.session.accountId).toBe('B');
});

test('completed deletion still clears its own current session', async () => {
  fixture.session = { accountId: 'A', refreshToken: 'synthetic-A' };
  await deleteAccount();
  expect(fixture.forgetAccount).toHaveBeenCalledExactlyOnceWith('A');
  expect(fixture.forgetSession).toHaveBeenCalledTimes(1);
});
