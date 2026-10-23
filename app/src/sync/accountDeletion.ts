// Deleting the account (App Store guideline 5.1.1(v)); see docs/ACCOUNT-DELETION.md. The request id
// and time zone are stored before the server call, so a lost response or a crash retries the same
// request (the server keeps a receipt). The session is kept until the server confirms, and this
// account's households are removed from the phone before the record of the deletion is.
import { uuidv7 } from './uuid';
import { wireTimeZone } from './timezones';

export type DeletionPreview = {
  pots: { potId: string; name: string | null; outcome: 'deleted' | 'anonymized'; successorName: string | null }[];
};

export type PendingDeletion = { accountId: string; requestId: string; timeZone: string; serverDone: boolean };

export type DeletionDeps = {
  post: <T>(path: string, body: unknown) => Promise<T>;
  read: () => Promise<PendingDeletion | null>;
  write: (p: PendingDeletion | null) => Promise<void>;
  session: () => { accountId: string; refreshToken: string } | null;
  /** Removes the account's households and session from this phone. */
  purgeLocal: (accountId: string) => Promise<void>;
};

export class DeletionError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'DeletionError'; }
}

export async function previewDeletion(deps: Pick<DeletionDeps, 'post' | 'session'>): Promise<DeletionPreview> {
  const s = deps.session();
  if (!s) throw new DeletionError('NOT_SIGNED_IN');
  return deps.post<DeletionPreview>('/auth/account/deletion-preview', { refreshToken: s.refreshToken });
}

/** Runs (or resumes) the deletion to the end. Safe to call again after any failure. */
export async function runDeletion(deps: DeletionDeps, now = Date.now()): Promise<void> {
  let pending = await deps.read();
  if (!pending) {
    const s = deps.session();
    if (!s) throw new DeletionError('NOT_SIGNED_IN');
    pending = { accountId: s.accountId, requestId: uuidv7(now), timeZone: wireTimeZone(), serverDone: false };
    await deps.write(pending);
  }
  if (!pending.serverDone) {
    // After a completed deletion the refresh token no longer works, but the receipt answers by id.
    const session = deps.session();
    if (session && session.accountId !== pending.accountId) throw new DeletionError('ACCOUNT_DELETION_ACCOUNT_MISMATCH');
    const token = session?.refreshToken ?? '';
    const result = await deps.post<{ deleted: boolean }>('/auth/account/delete', {
      refreshToken: token, requestId: pending.requestId, originatingTimeZone: pending.timeZone,
    });
    if (!result.deleted) throw new DeletionError('ACCOUNT_DELETION_INCOMPLETE');
    pending = { ...pending, serverDone: true };
    await deps.write(pending);
  }
  await deps.purgeLocal(pending.accountId);
  await deps.write(null);
}
