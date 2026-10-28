import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import schema from './schema';
import { modules } from './test.setup';
import { adoptPots, claimInvite, claimInviteWithRecheck, flush, issueInvites, pull, startSync, type Access, type Backend, type InvitePreview, type PotSummary } from '../app/src/sync/engine';
import type { Household } from '../app/src/core/types';

const id = (n: number) => `01890f5e-7b00-7000-8000-${n.toString(16).padStart(12, '0')}`;
type T = ReturnType<typeof convexTest>;
function phone(): Access {
  const rows: Household[] = [];
  return { get: (id) => rows.find(h => h.id === id), all: () => rows,
    remove: (id) => { const i = rows.findIndex(h => h.id === id); if (i >= 0) rows.splice(i, 1); },
    put: (h) => { const i = rows.findIndex(x => x.id === h.id); if (i < 0) rows.push(h); else rows[i] = h; } };
}
async function account(t: T, key: string): Promise<Backend> {
  await t.run(async ctx => {
    const accountId = await ctx.db.insert('accounts', { publicAccountId: key, appleSubjectHash: `subject-${key}`, createdAt: 1 });
    await ctx.db.insert('sessions', { sessionId: `recovery-session-${key}`, accountId, refreshTokenHash: `unused-${key}`, expiresAt: Date.now() + 86_400_000, createdAt: 1, rotatedAt: 1 });
  });
  const who = t.withIdentity({ issuer: 'https://auth.numa.shared', subject: key, sid: `recovery-session-${key}`, numa_session_audience: 'tech.arsik.numashared', token_use: 'access' });
  return { query: (n, a) => who.query(makeFunctionReference<'query'>(n), a) as never, mutation: (n, a) => who.mutation(makeFunctionReference<'mutation'>(n), a) as never };
}
async function fixture() {
  const t = convexTest(schema, modules), owner = await account(t, 'owner'), joiner = await account(t, 'joiner'), stranger = await account(t, 'stranger');
  const a = phone(), b = phone();
  a.put({ id: id(5), name: 'Synthetic recovery household', currency: 'EUR', createdAt: Date.now() - 60000, youId: id(1), people: [
    { id: id(1), name: 'Owner', groupId: id(3), unitId: id(3), joined: true }, { id: id(2), name: 'Guest', groupId: id(4), unitId: id(4), joined: false },
  ], groups: [{ id: id(3), color: 'citrus', memberIds: [id(1)] }, { id: id(4), color: 'lilac', memberIds: [id(2)] }], events: [], seen: {}, inviteCode: '' });
  const potId = await startSync(owner, a, id(5)); await pull(owner, a, potId); await issueInvites(owner, a, potId);
  const invite = a.get(potId)!.sync!.invites![id(2)];
  const preview = async () => (await (await t.fetch(`/join/${invite.code}`, { method: 'POST', headers: { accept: 'application/json' } })).json()) as Extract<InvitePreview, { status: 'active' }>;
  const active = await preview(); expect(active.status).toBe('active');
  return { t, owner, joiner, stranger, a, b, potId, invite, active, preview };
}
beforeEach(() => {
  for (const [key, value] of Object.entries({ NUMA_SHARED_PRODUCT: 'numa-shared', NUMA_SHARED_DEPLOYMENT_CLASS: 'anonymous-local', NUMA_SHARED_DEPLOYMENT_NAME: 'anonymous-agent', CONVEX_CLOUD_URL: 'http://127.0.0.1:3210', CONVEX_SITE_URL: 'http://127.0.0.1:3211', NUMA_SHARED_TOKEN_HASH_SECRET: 'synthetic-recovery-secret-at-least-32-bytes', NUMA_SHARED_SESSION_ISSUER: 'https://auth.numa.shared', NUMA_SHARED_SESSION_AUDIENCE: 'tech.arsik.numashared' })) vi.stubEnv(key, value);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

test('lost committed reply retries exact metadata and cannot recover for another account', async () => {
  const f = await fixture(); let lose = true; const calls: Record<string, unknown>[] = [];
  const lossy: Backend = { query: f.joiner.query, mutation: async (n, a) => {
    if (n === 'members:claimPerMemberInviteWithTicket') calls.push(a);
    const r = await f.joiner.mutation(n, a);
    if (n === 'members:claimPerMemberInviteWithTicket' && lose) { lose = false; throw Error('Lost reply after commit'); }
    return r as never;
  } };
  await expect(claimInvite(lossy, f.b, f.active)).rejects.toThrow('Lost reply');
  expect(f.b.get(f.potId)).toBeUndefined();
  const committed = await f.joiner.query('pots:listMyPots', {}); expect(committed).toHaveLength(1);
  await expect(claimInvite(lossy, f.b, f.active, Date.now() + 1)).resolves.toEqual({ status: 'joined', householdId: f.potId });
  expect(calls).toHaveLength(2); expect(calls[1]).toEqual(calls[0]);
  const recovered = f.b.get(f.potId)!; expect(recovered.youId).toBe(id(2));
  await expect(f.stranger.mutation('members:claimPerMemberInviteWithTicket', calls[0])).rejects.toThrow('INVITE_INVALID');
  await expect(claimInvite(f.stranger, f.b, f.active)).rejects.toThrow('INVITE_USED');
  expect(await f.stranger.query('pots:listMyPots', {})).toEqual([]);
  expect(await f.joiner.query('pots:listMyPots', {})).toEqual(committed);
  expect((await f.owner.query<{ events: { event: { payload: { kind: string } } }[] }>('events:listEvents', { potId: f.potId, afterSequence: 0n })).events.filter(x => x.event.payload.kind === 'memberClaimed')).toHaveLength(1);
});

test('concurrent retries share one pending claim and adoption retries preserve its receipt', async () => {
  const f = await fixture(); let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); let mutations = 0; let breakAdoption = true;
  const backend: Backend = { query: async (n, a) => { if (n === 'pots:listMyPots' && breakAdoption) { breakAdoption = false; throw Error('Adoption offline'); } return f.joiner.query(n, a); },
    mutation: async (n, a) => { mutations++; await wait; return f.joiner.mutation(n, a); } };
  const first = claimInvite(backend, f.b, f.active), retry = claimInvite(backend, f.b, f.active);
  const settled = Promise.allSettled([first, retry]); release(); await settled;
  expect(mutations).toBe(1);
  await expect(claimInvite(backend, f.b, f.active)).resolves.toEqual({ status: 'joined', householdId: f.potId });
  expect(mutations).toBe(1); expect(f.b.get(f.potId)?.youId).toBe(id(2));
});

const membershipEvent = (n: number, potId: string, payload: Record<string, unknown>) => ({ eventId: id(n), potId, actorMemberId: id(1), occurredAtMillis: BigInt(Date.now()), originatingTimeZone: 'Europe/Madrid', schemaVersion: 2n, payload, textFields: [], authoredText: [] });

test('archived membership adopts a frozen snapshot, catches redactions, and never reads future history or writes', async () => {
  const f = await fixture();
  const ownerCopy = f.a.get(f.potId)!;
  f.a.put({ ...ownerCopy, events: [{ id: id(110), recordId: id(111), by: id(1), at: Date.now() - 60000, kind: 'expenseAdded', content: { payerId: id(1), amount: 1001, date: '2026-10-20', title: 'Erase this cached title', category: 'groceries', split: { mode: 'equal', groupIds: [id(3), id(4)], weighting: 'group' } } }] });
  expect(await flush(f.owner, f.a, f.potId)).toBe('done');
  const financialSequence = f.a.get(f.potId)!.events[0].seq!;
  await claimInvite(f.joiner, f.b, f.active);
  await f.owner.mutation('members:archiveMember', { potId: f.potId, event: membershipEvent(100, f.potId, { kind: 'memberArchived', memberId: id(2) }) });
  const pots = await f.joiner.query<PotSummary[]>('pots:listMyPots', {});
  expect(pots[0]).toMatchObject({ isArchived: false, membershipStatus: 'archived' });
  const ceiling = pots[0].lastSequence;
  // Owner activity after archival stays inaccessible to the archived member.
  await f.owner.mutation('members:renamePot', { potId: f.potId, event: membershipEvent(101, f.potId, { kind: 'potRenamed', name: 'Future private name' }) });
  const queries: string[] = [];
  const guarded: Backend = { mutation: f.joiner.mutation, query: (n, a) => { queries.push(n); return f.joiner.query(n, a); } };
  await adoptPots(guarded, f.b, pots);
  await expect(pull(guarded, f.b, f.potId)).resolves.toBeUndefined();
  expect(queries).not.toContain('members:listRoster');
  expect(f.b.get(f.potId)!.sync).toMatchObject({ frozen: true, lastSeq: Number(ceiling) });
  expect(f.b.get(f.potId)!.name).not.toBe('Future private name');
  const fresh = phone(); await adoptPots(guarded, fresh, pots);
  expect(fresh.get(f.potId)!.sync).toMatchObject({ frozen: true, lastSeq: Number(ceiling) });
  const page = await f.joiner.query<{ events: { serverSequence: bigint }[] }>('events:listEvents', { potId: f.potId, afterSequence: ceiling });
  expect(page.events).toEqual([]);
  await expect(f.joiner.query('members:listRoster', { potId: f.potId })).rejects.toThrow('MEMBERSHIP_ARCHIVED');
  await expect(f.stranger.query('events:listEvents', { potId: f.potId, afterSequence: 0n })).rejects.toThrow('NOT_MEMBER');
  await expect(f.joiner.mutation('events:appendEvents', { potId: f.potId, events: [] })).rejects.toThrow('MEMBERSHIP_ARCHIVED');
  expect(await flush(guarded, f.b, f.potId)).toBe('paused');
  // The redaction cursor may advance across hidden future events without exposing their IDs.
  await f.t.run(async ctx => {
    await ctx.db.insert('textRedactions', { potId: f.potId, eventId: id(101), sequence: ceiling + 1n, field: 'title', revision: 1n, redactedAt: Date.now() });
    await ctx.db.insert('textRedactions', { potId: f.potId, eventId: id(110), sequence: BigInt(financialSequence), field: 'title', revision: 2n, redactedAt: Date.now() });
    const texts = await ctx.db.query('eventTexts').withIndex('by_pot_event', q => q.eq('potId', f.potId).eq('eventId', id(110))).collect();
    for (const text of texts) await ctx.db.delete(text._id);
    const pot = await ctx.db.query('pots').withIndex('by_pot_id', q => q.eq('potId', f.potId)).unique();
    await ctx.db.patch(pot!._id, { nextTextRevision: 3n });
  });
  await pull(guarded, f.b, f.potId);
  expect(f.b.get(f.potId)!.sync!.lastTextRev).toBe(2);
  expect(JSON.stringify(f.b.get(f.potId))).not.toContain('Erase this cached title');
  const changes = await f.joiner.query<{ changes: unknown[]; skippedRevisions: bigint[] }>('events:listTextChangesWithSkippedRevisions', { potId: f.potId, afterRevision: 0n });
  expect(changes.changes).toMatchObject([{ eventId: id(110), field: 'title', revision: 2n }]); expect(changes.skippedRevisions).toEqual([1n]);
});

test('revoked cached invites are invalidated, not silently replaced, and a second owner device cannot churn the first code', async () => {
  const f = await fixture();
  await f.owner.mutation('members:revokeInvite', { potId: f.potId, inviteId: f.invite.inviteId });
  await issueInvites(f.owner, f.a, f.potId);
  expect(f.a.get(f.potId)!.sync!.invites![id(2)]).toMatchObject({ issued: false });
  expect(await f.owner.query('members:listInvites', { potId: f.potId })).toEqual([]);
  // Further automatic passes must not recreate an intentionally withdrawn credential.
  await issueInvites(f.owner, f.a, f.potId);
  expect(await f.owner.query('members:listInvites', { potId: f.potId })).toEqual([]);
});

test('an owner device without the plaintext leaves the other device invite active', async () => {
  const f = await fixture(); const second = phone(); await adoptPots(f.owner, second);
  const before = await f.owner.query('members:listInvites', { potId: f.potId });
  await issueInvites(f.owner, second, f.potId);
  expect(await f.owner.query('members:listInvites', { potId: f.potId })).toEqual(before);
  expect(second.get(f.potId)!.sync!.invites?.[id(2)]?.issued).not.toBe(true);
  expect((await f.preview()).status).toBe('active');
});

test('explicit replacement is idempotent after a lost issue reply and consumes quota only once', async () => {
  const f = await fixture();
  await f.owner.mutation('members:revokeInvite', { potId: f.potId, inviteId: f.invite.inviteId });
  await issueInvites(f.owner, f.a, f.potId);
  const snapshot = () => f.t.run(async ctx => ({ invites: await ctx.db.query('invites').collect(), quota: (await ctx.db.query('accountWriteQuotas').collect()).filter(q => q.scope === 'inviteIssue') }));
  const before = await snapshot(); let lost = true; const mutations: string[] = [];
  const lossy: Backend = { query: f.owner.query, mutation: async (n, a) => {
    mutations.push(n); const result = await f.owner.mutation(n, a);
    if (n === 'members:issueInvite' && lost) { lost = false; throw Error('Issue reply lost after commit'); }
    return result as never;
  } };
  const replacement = { memberId: id(2), inviteId: f.invite.inviteId };
  await expect(issueInvites(lossy, f.a, f.potId, Date.now(), replacement)).rejects.toThrow('TRANSPORT_UNAVAILABLE');
  await issueInvites(lossy, f.a, f.potId, Date.now(), replacement);
  const current = f.a.get(f.potId)!.sync!.invites![id(2)];
  expect(current).toMatchObject({ issued: true, state: 'active' }); expect(current.inviteId).not.toBe(f.invite.inviteId);
  const after = await snapshot();
  expect(after.quota[0].count).toBe(before.quota[0].count + 1n);
  await issueInvites(lossy, f.a, f.potId, Date.now(), replacement); // stale button/Retry cannot replace the new code
  await issueInvites(lossy, f.a, f.potId);
  expect(await snapshot()).toEqual(after);
  expect(mutations).toEqual(['members:issueInvite']);
  const metadata = await f.owner.query<Record<string, unknown>[]>('members:listInvites', { potId: f.potId });
  expect(metadata).toHaveLength(1); expect(metadata[0]).not.toHaveProperty('code'); expect(metadata[0]).not.toHaveProperty('token');
  for (const row of after.invites) { expect(row).not.toHaveProperty('code'); expect(row).not.toHaveProperty('token'); }
});

test('stale unconsumed tickets are distinct, cannot admit, and a fresh check recovers without extending TTL', async () => {
  const f = await fixture(); const now = Date.now();
  const metadata = { eventId: id(201), occurredAtMillis: BigInt(now), originatingTimeZone: 'Europe/Madrid', schemaVersion: 2n };
  vi.spyOn(Date, 'now').mockReturnValue(now + 600001);
  await expect(f.joiner.mutation('members:claimPerMemberInviteWithTicket', { ticket: f.active.claimTicket, event: metadata })).rejects.toThrow('INVITE_TICKET_STALE');
  expect(await f.joiner.query('pots:listMyPots', {})).toEqual([]);
  const fresh = await f.preview(); expect(fresh.status).toBe('active'); expect(fresh.claimTicket).not.toBe(f.active.claimTicket);
  const receipt = await f.joiner.mutation('members:claimPerMemberInviteWithTicket', { ticket: fresh.claimTicket, event: metadata });
  vi.mocked(Date.now).mockReturnValue(now + 1200002);
  expect(await f.joiner.mutation('members:claimPerMemberInviteWithTicket', { ticket: fresh.claimTicket, event: metadata })).toEqual(receipt);
  await expect(f.stranger.mutation('members:claimPerMemberInviteWithTicket', { ticket: fresh.claimTicket, event: metadata })).rejects.toThrow('INVITE_INVALID');
});

test.each(['revoked', 'expired', 'used'] as const)('%s admission failure is not mistaken for a stale check', async (state) => {
  const f = await fixture(); const now = Date.now();
  if (state === 'revoked') await f.owner.mutation('members:revokeInvite', { potId: f.potId, inviteId: f.invite.inviteId });
  if (state === 'used') await claimInvite(f.joiner, f.b, f.active);
  vi.spyOn(Date, 'now').mockReturnValue(state === 'expired' ? f.invite.expiresAt : now + 600001);
  // Keep sessions valid while testing the invite lifetime rather than auth expiry.
  if (state === 'expired') await f.t.run(async ctx => { for (const s of await ctx.db.query('sessions').collect()) await ctx.db.patch(s._id, { expiresAt: f.invite.expiresAt + 86400000 }); });
  await expect(f.stranger.mutation('members:claimPerMemberInviteWithTicket', { ticket: f.active.claimTicket, event: { eventId: id(202), occurredAtMillis: BigInt(Date.now()), originatingTimeZone: 'Europe/Madrid', schemaVersion: 2n } })).rejects.toThrow(`INVITE_${state.toUpperCase()}`);
  expect(await f.stranger.query('pots:listMyPots', {})).toEqual([]);
});

test('stale recheck followed by a lost successful reply retries the exact new attempt', async () => {
  const f = await fixture(); const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 600001);
  const calls: Record<string, unknown>[] = []; let lose = true;
  const lossy: Backend = { query: f.joiner.query, mutation: async (n, a) => {
    calls.push(a); const result = await f.joiner.mutation(n, a);
    if (lose) { lose = false; throw Error('Fresh claim reply lost'); } return result as never;
  } };
  let remembered: InvitePreview = f.active; let checks = 0;
  const recheck = async () => { checks++; return f.preview(); };
  await expect(claimInviteWithRecheck(f.active, p => claimInvite(lossy, f.b, p), recheck, p => { remembered = p; })).rejects.toThrow('Fresh claim reply lost');
  expect(remembered.status).toBe('active');
  if (remembered.status !== 'active') throw Error('Expected retained fresh preview');
  expect(remembered.claimTicket).not.toBe(f.active.claimTicket);
  expect(await claimInviteWithRecheck(remembered, p => claimInvite(lossy, f.b, p), recheck)).toMatchObject({ result: { status: 'joined', householdId: f.potId } });
  expect(checks).toBe(1); expect(calls).toHaveLength(3); expect(calls[2]).toEqual(calls[1]);
  expect(f.b.get(f.potId)?.youId).toBe(id(2));
});
