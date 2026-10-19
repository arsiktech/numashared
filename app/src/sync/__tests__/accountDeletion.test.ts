// Review blocker 8: account deletion. The request id is saved before the server call, a lost
// response retries the same request, and a crash after the server finished only redoes the
// local cleanup.
import { describe, expect, test, vi } from 'vitest';
import { runDeletion, type DeletionDeps, type PendingDeletion } from '../accountDeletion';
import { isUuidv7 } from '../uuid';

function harness(post: DeletionDeps['post']) {
  const log: string[] = [];
  let saved: PendingDeletion | null = null;
  let session: { accountId: string; refreshToken: string } | null = { accountId: 'acc-1', refreshToken: 'r1' };
  const deps: DeletionDeps = {
    post: vi.fn(async (path, body) => { log.push(`post ${path}`); return post(path, body); }) as DeletionDeps['post'],
    read: async () => saved,
    write: async (p) => { log.push(p ? `save ${p.serverDone ? 'done' : 'pending'}` : 'clear'); saved = p; },
    session: () => session,
    purgeLocal: vi.fn(async (accountId: string) => { log.push(`purge ${accountId}`); session = null; }),
  };
  return { deps, log, saved: () => saved };
}

describe('account deletion', () => {
  test('saves the request first, deletes on the server, then clears this phone', async () => {
    const { deps, log, saved } = harness(async () => ({ deleted: true }) as never);
    await runDeletion(deps);
    expect(log).toEqual(['save pending', 'post /auth/account/delete', 'save done', 'purge acc-1', 'clear']);
    expect(saved()).toBeNull();
    const body = (deps.post as ReturnType<typeof vi.fn>).mock.calls[0][1] as { requestId: string; refreshToken: string };
    expect(isUuidv7(body.requestId)).toBe(true);
    expect(body.refreshToken).toBe('r1');
  });

  test('a lost response retries the same request id, keeping the session until it succeeds', async () => {
    let calls = 0;
    const { deps, saved } = harness(async () => { calls++; if (calls === 1) throw new Error('offline'); return { deleted: true } as never; });
    await expect(runDeletion(deps)).rejects.toThrow('offline');
    const first = saved()!;
    expect(first.serverDone).toBe(false);
    expect(deps.session()).not.toBeNull();
    await runDeletion(deps);
    const ids = (deps.post as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[1] as { requestId: string }).requestId);
    expect(ids).toEqual([first.requestId, first.requestId]);
  });

  test('after the server finished, a restart only redoes the local cleanup', async () => {
    const { deps, saved } = harness(async () => ({ deleted: true }) as never);
    deps.purgeLocal = vi.fn(async () => { throw new Error('crash'); });
    await expect(runDeletion(deps)).rejects.toThrow('crash');
    expect(saved()?.serverDone).toBe(true);
    deps.purgeLocal = vi.fn(async () => {});
    await runDeletion(deps);
    expect(deps.post).toHaveBeenCalledTimes(1);
    expect(deps.purgeLocal).toHaveBeenCalledWith('acc-1');
    expect(saved()).toBeNull();
  });
});
