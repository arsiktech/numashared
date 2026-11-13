import { expect, test } from 'vitest';
import { inviteUsable, INVITE_RECHECK_MS } from '../engine';
import type { InviteInfo } from '../../core/types';

test('only recently reconciled active credentials can be displayed/shared', () => {
  const now = 1800000000000;
  const active: InviteInfo = { inviteId: 'synthetic', code: 'ABC234', token: 'synthetic-test-token', expiresAt: now + 86400000, issued: true, state: 'active', checkedAt: now };
  expect(inviteUsable(active, now)).toBe(true);
  expect(inviteUsable(active, now + INVITE_RECHECK_MS - 1)).toBe(true);
  expect(inviteUsable(active, now + INVITE_RECHECK_MS)).toBe(false);
  expect(inviteUsable(active, now - 1)).toBe(false);
  expect(inviteUsable({ ...active, state: undefined, checkedAt: undefined }, now)).toBe(false); // old persisted issued flag is not authority
  for (const state of ['expired', 'unavailable', 'elsewhere'] as const) expect(inviteUsable({ ...active, state }, now)).toBe(false);
  expect(inviteUsable({ ...active, expiresAt: now }, now)).toBe(false);
  expect(inviteUsable({ ...active, code: '', token: '' }, now)).toBe(false);
});
