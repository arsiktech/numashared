// Connects the household store to the backend while signed in. A live subscription to the list of
// your households wakes sync whenever anyone records something; a short timer sends events whose
// undo window has closed; coming back to the app catches up. One sync runs at a time.
import { ConvexClient } from 'convex/browser';
import { AppState, Platform } from 'react-native';
import { useSyncExternalStore } from 'react';
import type { Household, ID } from '../core/types';
import { claimParked, forgetAccount, getState, putHousehold, removeHousehold, showAccount, switchHousehold } from '../store/store';
import { previewDeletion, runDeletion, type DeletionDeps, type DeletionPreview } from './accountDeletion';
import { accessToken, currentSession, forgetSession, loadSession, post, readDeletion, writeDeletion, signInWithApple, signInWithGoogle, signOutSession, subscribeSession } from './auth';
import { CONVEX_URL, SITE_URL } from './config';
import { refreshContract } from './contract';
import {
  base64url,
  addPersonOnline, adoptPots, deleteHouseholdOnline, removePersonOnline, claimInvite, failureOf, flush, issueInvites, leaveOnline, promote, pull,
  regroupOnline, renameOnline, resolveInvite, resume, retryReasons, stageSync, SEND_DELAY_MS,
  type Access, type Backend, type InvitePreview, type PotSummary,
} from './engine';

// ---------- status for the UI ----------

export type SyncStatus = {
  signedIn: boolean;
  connected: boolean;
  /** Something is on its way to the server. */
  busy: boolean;
  /** Households whose uploads wait because this account sent its hourly maximum. */
  throttled?: string;
  /** The last sync attempt failed for a reason worth showing (network trouble is not). */
  lastError?: string;
  /** Households fully pulled at least once since launch. */
  ready: boolean;
};

let status: SyncStatus = { signedIn: false, connected: false, busy: false, ready: false };
const statusListeners = new Set<() => void>();
function setStatus(patch: Partial<SyncStatus>) {
  const next = { ...status, ...patch };
  if (Object.keys(next).every((k) => next[k as keyof SyncStatus] === status[k as keyof SyncStatus])) return;
  status = next;
  for (const l of statusListeners) l();
}
export const getSyncStatus = () => status;
export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(
    (l) => { statusListeners.add(l); return () => { statusListeners.delete(l); }; },
    () => status, () => status,
  );
}

// ---------- the Convex client ----------

const fnName = Symbol.for('functionName');
const ref = (name: string) => ({ [fnName]: name }) as never;

let client: ConvexClient | null = null;
let unsubscribePots: (() => void) | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

const backend: Backend = {
  query: (name, args) => {
    if (!client) return Promise.reject(new Error('NOT_SIGNED_IN'));
    return client.query(ref(name), args as never) as Promise<never>;
  },
  mutation: (name, args) => {
    if (!client) return Promise.reject(new Error('NOT_SIGNED_IN'));
    return client.mutation(ref(name), args as never) as Promise<never>;
  },
};

const access: Access = {
  get: (id) => getState().households.find((h) => h.id === id),
  // Every shared copy records the account it belongs to (see showAccount).
  put: (h) => {
    const accountId = currentSession()?.accountId;
    putHousehold(h.sync && !h.sync.accountId && accountId ? { ...h, sync: { ...h.sync, accountId } } : h);
  },
  remove: (id) => removeHousehold(id),
  all: () => getState().households,
};

const synced = () => getState().households.filter((h) => h.sync);

// ---------- one sync at a time ----------

let running: Promise<void> | null = null;
let again = false;
let latestPots: PotSummary[] | null = null;

/** Runs a full sync now, or right after the one in progress. */
export function requestSync(): Promise<void> {
  if (!client) return Promise.resolve();
  if (running) { again = true; return running; }
  running = (async () => {
    do {
      again = false;
      await syncOnce();
    } while (again && client);
  })().finally(() => { running = null; });
  return running;
}

async function syncOnce() {
  setStatus({ busy: true });
  try {
    await refreshContract(SITE_URL);
    const pots = latestPots ?? await backend.query<PotSummary[]>('pots:listMyPots', {});
    latestPots = null;
    const accountId = currentSession()?.accountId;
    if (accountId) claimParked(accountId, pots.map((p) => p.potId));
    await adoptPots(backend, access, pots);
    for (const h of synced()) {
      const pot = pots.find((p) => p.potId === h.id);
      try {
        if (h.sync!.setup) await promote(backend, access, h.id);
        if (!pot && !h.sync!.setup) continue; // no longer a member: keep the local copy readable
        if (pot && (Number(pot.lastSequence) > h.sync!.lastSeq || Number(pot.lastTextRevision) > h.sync!.lastTextRev)) {
          await pull(backend, access, h.id, { archived: pot.isArchived });
        }
        await flush(backend, access, h.id);
        if (h.sync!.role === 'owner') await issueInvites(backend, access, h.id);
      } catch (e) {
        const f = failureOf(e);
        if (!f.retryable) setStatus({ lastError: f.code });
      }
    }
    const throttled = synced().filter((h) => retryReasons.get(h.id)?.endsWith('RATE_LIMITED')).map((h) => h.id).join(',');
    setStatus({ busy: false, ready: true, lastError: undefined, throttled: throttled || undefined });
  } catch (e) {
    const f = failureOf(e);
    setStatus({ busy: false, lastError: f.retryable ? undefined : f.code });
  }
}

/** Sends queued events once their undo window has passed. */
function tick() {
  const now = Date.now();
  const due = synced().some((h) => !h.sync!.paused && h.events.some((e) => e.seq === undefined && now - e.at >= SEND_DELAY_MS));
  if (due) void requestSync();
}

// ---------- lifecycle ----------

function connect() {
  if (client) return;
  client = new ConvexClient(CONVEX_URL, { unsavedChangesWarning: false });
  client.setAuth(
    async ({ forceRefreshToken }) => accessToken(forceRefreshToken),
    (isAuthenticated) => setStatus({ connected: isAuthenticated }),
  );
  unsubscribePots = client.onUpdate(ref('pots:listMyPots'), {} as never, (pots: PotSummary[]) => {
    latestPots = pots;
    void requestSync();
  }, () => { /* auth or network: the next update or tick retries */ });
  timer = setInterval(tick, 2000);
  setStatus({ signedIn: true });
  registerPush(false).catch(() => {});
}

function disconnect() {
  unsubscribePots?.();
  unsubscribePots = null;
  if (timer) clearInterval(timer);
  timer = null;
  const c = client;
  client = null;
  void c?.close();
  setStatus({ signedIn: false, connected: false, busy: false, ready: false });
}

let started = false;

/** Call once at launch. Follows the session: connects when signed in, disconnects when not. */
export function startSyncRuntime() {
  if (started) return;
  started = true;
  const follow = () => {
    const s = currentSession();
    // An expired or ended session hides that account's shared households at once.
    showAccount(s?.accountId ?? null);
    if (s) connect(); else disconnect();
  };
  subscribeSession(follow);
  void loadSession().then(follow).then(resumeAccountDeletion);
  AppState.addEventListener('change', (s) => { if (s === 'active') void requestSync(); });
  if (Platform.OS === 'ios') {
    // Tapping a notification opens the household it is about.
    void import('expo-notifications').then((Notifications) => {
      Notifications.addNotificationResponseReceivedListener((response) => {
        const potId = (response.notification.request.content.data as { potId?: unknown } | undefined)?.potId;
        if (typeof potId === 'string' && getState().households.some((h) => h.id === potId)) switchHousehold(potId);
        void requestSync();
      });
    }).catch(() => {});
  }
}

// ---------- actions for screens ----------

/**
 * The Convex client waits for a connection instead of failing, which is right for background
 * sync but leaves a button spinning offline. Screens get an answer within `ms`; the request
 * itself still goes through once the connection is back.
 */
function within<T>(p: Promise<T>, ms = 15_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject({ data: { code: 'TRANSPORT_UNAVAILABLE', retryable: true } }), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export class NeedsSignIn extends Error { constructor() { super('NEEDS_SIGN_IN'); } }

/** Sign in (Apple or Google), then bring in this account's households. Returns how many arrived. */
export async function signIn(provider: 'apple' | 'google' = 'apple', webIdToken?: string): Promise<number> {
  if (provider === 'google') await signInWithGoogle(webIdToken); else await signInWithApple();
  connect();
  const before = getState().households.length;
  await requestSync();
  registerPush(true).catch(() => {});
  return getState().households.length - before;
}

/** Moves a household that lives only on this device to the server (you become its owner). */
export async function turnOnSync(householdId: ID): Promise<ID> {
  if (!currentSession()) throw new NeedsSignIn();
  connect();
  const id = stageSync(access, householdId);
  switchHousehold(id);
  await within(promote(backend, access, id));
  void requestSync();
  return id;
}

export async function lookUpInvite(code: string): Promise<InvitePreview> {
  return resolveInvite(SITE_URL, code);
}

export async function joinWithInvite(preview: Extract<InvitePreview, { status: 'active' }>) {
  if (!currentSession()) throw new NeedsSignIn();
  connect();
  const result = await within(claimInvite(backend, access, preview), 30_000);
  if (result.status === 'joined') switchHousehold(result.householdId);
  return result;
}

// ---------- card sync (convex/cardSync.ts) ----------

export type CardSyncCard = { last4: string; forUnitId: ID; label: string };
export type CardSyncStatus = { cards: CardSyncCard[]; actorMemberId: ID; createdAt: number; lastUsedAt: number | null; added: bigint } | null;

/** A new random sync key. Only its SHA-256 goes to the server; the key itself is shown once. */
async function newCardSyncKey(): Promise<{ key: string; hash: string }> {
  const Crypto = await import('expo-crypto');
  const key = `nscs_${base64url(Crypto.getRandomBytes(32))}`;
  const hash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, key, { encoding: Crypto.CryptoEncoding.HEX });
  return { key, hash: hash.toLowerCase() };
}

export const cardSync = {
  status: (h: Household) => within(backend.query<CardSyncStatus>('cardSync:status', { potId: h.id })),
  /** Links the cards and returns the key for the sync script. Replaces any earlier key. */
  link: async (h: Household, cards: CardSyncCard[]): Promise<string> => {
    const { key, hash } = await newCardSyncKey();
    let timeZone = 'UTC';
    try { timeZone = (await import('./timezones')).wireTimeZone(); } catch { /* UTC */ }
    await within(backend.mutation('cardSync:link', { potId: h.id, keyHash: hash, timeZone, cards }));
    return key;
  },
  unlink: (h: Household) => within(backend.mutation('cardSync:unlink', { potId: h.id })),
};

/** Where the sync script sends spends. */
export const CARD_SYNC_URL = `${SITE_URL}/card-sync/spends`;

// ---------- AI agent access (convex/agentAccess.ts) ----------

export type AgentConnection = { id: string; name: string; hint: string; potId: string | null; createdAt: number; lastUsedAt: number | null };
export type AgentActivity = { id: string; agent: string; tool: string; ok: boolean; error: string | null; at: number };

/** Where an agent connects. The secret goes after the slash. */
export const AGENT_URL = `${SITE_URL}/mcp`;

export const agents = {
  list: () => within(backend.query<AgentConnection[]>('agentAccess:listMine', {})),
  activity: () => within(backend.query<AgentActivity[]>('agentAccess:recentActivity', {})),
  /** Connects a read-only agent. The secret is made here and shown once; only its SHA-256 reaches the server. */
  connect: async (name: string, potId: string | null): Promise<{ link: string }> => {
    const Crypto = await import('expo-crypto');
    const secret = `nsag_${base64url(Crypto.getRandomBytes(32))}`;
    const keyHash = (await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, secret, { encoding: Crypto.CryptoEncoding.HEX })).toLowerCase();
    await within(backend.mutation('agentAccess:connect', { name, keyHash, keyHint: secret.slice(0, 9), ...(potId ? { potId } : {}) }));
    return { link: `${AGENT_URL}/${secret}` };
  },
  disconnect: (id: string) => within(backend.mutation('agentAccess:disconnect', { id })),
};

/** Online-only household changes. Each throws when offline so the screen can say so. */
export const online = {
  addPerson: (h: Household, name: string) => within(addPersonOnline(backend, access, h.id, name)).then((id) => { issueInvites(backend, access, h.id).catch(() => {}); return id; }),
  rename: (h: Household, name: string) => within(renameOnline(backend, access, h.id, name)),
  regroup: (h: Household, arrangement: ID[][]) => within(regroupOnline(backend, access, h.id, arrangement)),
  leave: async (h: Household) => { await within(leaveOnline(backend, access, h.id)); removeHousehold(h.id); },
  removePerson: (h: Household, personId: ID) => within(removePersonOnline(backend, access, h.id, personId)),
  deleteHousehold: (h: Household) => within(deleteHouseholdOnline(backend, access, h.id), 30_000),
  invites: (h: Household) => within(issueInvites(backend, access, h.id)),
  retry: (h: Household) => { resume(access, h.id); return requestSync(); },
};

/** Signs out: ends the session and removes households that live on the server from this device. */
export async function signOutEverywhere(): Promise<void> {
  // Give queued changes one last chance to reach the server.
  try { await within(requestSync(), 8_000); } catch { /* the sheet warned about unsent changes */ }
  try { await unregisterPush(); } catch { /* best effort */ }
  const accountId = currentSession()?.accountId;
  await signOutSession();
  disconnect();
  if (accountId) forgetAccount(accountId);
  for (const h of synced()) removeHousehold(h.id);
}

// ---------- account deletion ----------

const deletion: DeletionDeps = {
  post,
  read: readDeletion,
  write: writeDeletion,
  session: () => currentSession(),
  purgeLocal: async (accountId) => {
    forgetAccount(accountId);
    if (currentSession()?.accountId === accountId) {
      disconnect();
      await forgetSession();
    }
  },
};

/** What deleting the account would do to each household. */
export function accountDeletionPreview(): Promise<DeletionPreview> {
  return within(previewDeletion(deletion), 20_000);
}

/** Deletes the account on the server, then its households and session on this phone. */
export async function deleteAccount(): Promise<void> {
  try { await unregisterPush(); } catch { /* the server removes push tokens too */ }
  await runDeletion(deletion);
}

/** A deletion interrupted by a crash or lost connection finishes on the next launch. */
async function resumeAccountDeletion() {
  if (await readDeletion()) await runDeletion(deletion).catch(() => { /* tried again next launch */ });
}

/** Changes in shared households that haven't reached the server yet. */
export const unsentCount = () => synced().reduce((n, h) => n + h.events.filter((e) => e.seq === undefined).length, 0);

// ---------- push ----------

let pushToken: string | null = null;

/**
 * Registers this iPhone for notifications. With `ask: false` it only refreshes an existing
 * permission (used at launch); with `ask: true` it may show the system prompt.
 */
export async function registerPush(ask = true): Promise<boolean> {
  if (Platform.OS !== 'ios' || !client || !getState().prefs.notifications) return false;
  const Notifications = await import('expo-notifications');
  const perm = ask
    ? await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: false } })
    : await Notifications.getPermissionsAsync();
  if (!perm.granted) return false;
  const token = await Notifications.getDevicePushTokenAsync();
  const hex = String(token.data).toLowerCase();
  if (!/^[0-9a-f]{64,200}$/.test(hex)) return false;
  let timeZone = 'UTC';
  try { timeZone = (await import('./timezones')).wireTimeZone(); } catch { /* UTC */ }
  await backend.mutation('notifications:registerPushToken', { deviceToken: hex, environment: __DEV__ ? 'sandbox' : 'production', timeZone });
  pushToken = hex;
  return true;
}

async function unregisterPush() {
  if (!pushToken || !client) return;
  await backend.mutation('notifications:unregisterPushToken', { deviceToken: pushToken });
  pushToken = null;
}
