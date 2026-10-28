import { expect, test, vi } from 'vitest';
import { claimInviteWithRecheck, SyncError, type InvitePreview } from '../engine';
const stale = () => new SyncError({ code: 'INVITE_TICKET_STALE', retryable: false });
const active: Extract<InvitePreview, { status: 'active' }> = { status: 'active', kind: 'perMember', potName: 'Synthetic', expiresAt: 1800000000000, minimumReaderSchemaVersion: 2, claimTicket: 'original-ticket' };
const joined = { status: 'joined', householdId: 'synthetic-household' } as const;

test('rechecks stale tickets only once and uses the exact fresh preview', async () => {
  const fresh = { ...active, claimTicket: 'fresh-ticket' };
  const claim = vi.fn().mockRejectedValueOnce(stale()).mockResolvedValueOnce(joined);
  const check = vi.fn().mockResolvedValue(fresh);
  expect(await claimInviteWithRecheck(active, claim, check)).toEqual({ preview: fresh, result: joined });
  expect(check).toHaveBeenCalledTimes(1); expect(claim.mock.calls).toEqual([[active], [fresh]]);
});
test('a second stale ticket stops instead of looping or reporting used', async () => {
  const claim = vi.fn().mockRejectedValue(stale()), check = vi.fn().mockResolvedValue({ ...active, claimTicket: 'fresh-ticket' });
  await expect(claimInviteWithRecheck(active, claim, check)).rejects.toMatchObject({ failure: { code: 'INVITE_TICKET_STALE' } });
  expect(claim).toHaveBeenCalledTimes(2); expect(check).toHaveBeenCalledTimes(1);
});
test.each(['expired', 'revoked', 'used', 'invalid'] as const)('%s is represented distinctly without another claim', async status => {
  const code = `INVITE_${status.toUpperCase()}`;
  const claim = vi.fn().mockRejectedValue(new SyncError({ code, retryable: false })), check = vi.fn();
  expect(await claimInviteWithRecheck(active, claim, check)).toEqual({ preview: { status } });
  expect(check).not.toHaveBeenCalled(); expect(claim).toHaveBeenCalledTimes(1);
});
test.each(['expired', 'revoked', 'used'] as const)('fresh preview reporting %s never admits', async status => {
  const claim = vi.fn().mockRejectedValue(stale()), check = vi.fn().mockResolvedValue({ status });
  expect(await claimInviteWithRecheck(active, claim, check)).toEqual({ preview: { status } });
  expect(claim).toHaveBeenCalledTimes(1);
});
test('a fresh claim with an ambiguous reply retains its exact ticket for Retry', async () => {
  const fresh = { ...active, claimTicket: 'fresh-ticket' }, remember = vi.fn();
  const claim = vi.fn().mockRejectedValueOnce(stale()).mockRejectedValueOnce(new SyncError({ code: 'TRANSPORT_UNAVAILABLE', retryable: true }));
  await expect(claimInviteWithRecheck(active, claim, async () => fresh, remember)).rejects.toMatchObject({ failure: { code: 'TRANSPORT_UNAVAILABLE' } });
  expect(remember).toHaveBeenCalledExactlyOnceWith(fresh);
});
