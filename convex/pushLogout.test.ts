import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import schema from './schema';
import { modules } from './test.setup';

const mutation = (name: string) => makeFunctionReference<'mutation'>(name);
const register = mutation('notifications:registerPushToken');
const logout = mutation('authSessions:revokeSessionByRefresh');
const sessionA = 'synthetic-session-a-0001', sessionA2 = 'synthetic-session-a-0002', sessionB = 'synthetic-session-b-0001';
const hashA = 'synthetic-refresh-hash-a-0000000000000000';
const now = Date.now();
beforeEach(() => {
  vi.stubEnv('NUMA_SHARED_PRODUCT', 'numa-shared');
  vi.stubEnv('NUMA_SHARED_DEPLOYMENT_CLASS', 'anonymous-local');
  vi.stubEnv('NUMA_SHARED_DEPLOYMENT_NAME', 'anonymous-agent');
  vi.stubEnv('CONVEX_CLOUD_URL', 'http://127.0.0.1:3210');
  vi.stubEnv('CONVEX_SITE_URL', 'http://127.0.0.1:3211');
  vi.stubEnv('NUMA_SHARED_SESSION_ISSUER', 'https://auth.numa.shared');
  vi.stubEnv('NUMA_SHARED_SESSION_AUDIENCE', 'tech.arsik.numashared');
});
afterEach(() => vi.unstubAllEnvs());

async function fixture() {
  const t = convexTest(schema, modules);
  const accounts = await t.run(async (ctx) => {
    const a = await ctx.db.insert('accounts', { publicAccountId: 'account-a', appleSubjectHash: 'apple-a', createdAt: now });
    const b = await ctx.db.insert('accounts', { publicAccountId: 'account-b', appleSubjectHash: 'apple-b', createdAt: now });
    for (const [sessionId, accountId, refreshTokenHash] of [[sessionA, a, hashA], [sessionA2, a, 'synthetic-refresh-hash-a2-000000000000000'], [sessionB, b, 'synthetic-refresh-hash-b-0000000000000000']] as const) {
      await ctx.db.insert('sessions', { sessionId, accountId, refreshTokenHash, expiresAt: now + 86400000, createdAt: now, rotatedAt: now });
    }
    return { a, b };
  });
  const who = (subject: string, sid: string) => t.withIdentity({ issuer: 'https://auth.numa.shared', subject,
    sid, numa_session_audience: 'tech.arsik.numashared', token_use: 'access' });
  const a = who('account-a', sessionA), a2 = who('account-a', sessionA2), b = who('account-b', sessionB);
  const rows = () => t.run(async (ctx) => ctx.db.query('pushTokens').collect());
  return { t, accounts, a, a2, b, rows };
}
const tokenArgs = (digit: string) => ({ deviceToken: digit.repeat(64), environment: 'sandbox' as const, timeZone: 'Europe/Madrid' });

test('tokenless logout removes this session registration, preserving other devices and accounts', async () => {
  const f = await fixture();
  await f.a.mutation(register, tokenArgs('a'));
  await f.a2.mutation(register, tokenArgs('c'));
  await f.b.mutation(register, tokenArgs('b'));
  expect(await f.t.mutation(logout, { refreshTokenHash: hashA, now })).toEqual({ revoked: true });
  expect((await f.rows()).map((x) => x.deviceToken).sort()).toEqual(['b'.repeat(64), 'c'.repeat(64)]);
  await expect(f.a.mutation(register, tokenArgs('a'))).rejects.toThrow('AUTH_SESSION_REVOKED');
  expect(await f.t.mutation(logout, { refreshTokenHash: hashA, now })).toEqual({ revoked: true });
});

test('logout through a rotated refresh hash retires the same push lease', async () => {
  const f = await fixture();
  await f.a.mutation(register, tokenArgs('a'));
  const oldHash = 'synthetic-old-refresh-hash-a-000000000000';
  await f.t.run(async (ctx) => {
    await ctx.db.insert('refreshTokenHistory', { tokenHash: oldHash, sessionId: sessionA, accountId: f.accounts.a, rotatedAt: now, expiresAt: now + 86400000 });
  });
  await f.t.mutation(logout, { refreshTokenHash: oldHash, now });
  expect(await f.rows()).toEqual([]);
});

test('reassigned tokens belong to the new session and survive the former session logout', async () => {
  const f = await fixture();
  await f.a.mutation(register, tokenArgs('a'));
  await f.b.mutation(register, tokenArgs('a'));
  await f.t.mutation(logout, { refreshTokenHash: hashA, now });
  expect(await f.rows()).toEqual([expect.objectContaining({ accountId: f.accounts.b, deviceToken: 'a'.repeat(64) })]);
});

test('logout conservatively removes unbound legacy registrations only for its account', async () => {
  const f = await fixture();
  await f.t.run(async (ctx) => {
    for (const [accountId, digit] of [[f.accounts.a, 'a'], [f.accounts.b, 'b']] as const) {
      await ctx.db.insert('pushTokens', { accountId, ...tokenArgs(digit), updatedAt: now });
    }
  });
  await f.t.mutation(logout, { refreshTokenHash: hashA, now });
  expect(await f.rows()).toEqual([expect.objectContaining({ accountId: f.accounts.b })]);
});
