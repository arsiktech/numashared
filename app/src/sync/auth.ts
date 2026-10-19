// Sign in with Apple and the Numa Shared session. Apple's token is exchanged once for a 30-day
// session: a 5-minute access token for Convex plus a refresh token that rotates on every use.
// Only the refresh token is stored, in the Keychain (localStorage on the web).
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { GOOGLE_IOS_CLIENT_ID, GOOGLE_WEB_CLIENT_ID, SITE_URL } from './config';
import { base64url } from './engine';
import type { PendingDeletion } from './accountDeletion';

export type Session = {
  accountId: string;
  refreshToken: string;
  refreshExpiresAt: number;
  accessToken?: string;
  accessExpiresAt?: number;
};

export class AuthError extends Error {
  constructor(readonly code: string, readonly retryable: boolean) { super(code); this.name = 'AuthError'; }
}

const KEY = 'numa-shared.session.v1';

async function readStored(): Promise<Session | null> {
  try {
    const raw = Platform.OS === 'web' ? globalThis.localStorage?.getItem(KEY) ?? null : await SecureStore.getItemAsync(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    return typeof s.refreshToken === 'string' && typeof s.accountId === 'string' ? s : null;
  } catch {
    return null;
  }
}

async function writeStored(s: Session | null): Promise<void> {
  const raw = s ? JSON.stringify({ accountId: s.accountId, refreshToken: s.refreshToken, refreshExpiresAt: s.refreshExpiresAt }) : null;
  if (Platform.OS === 'web') {
    if (raw) globalThis.localStorage?.setItem(KEY, raw);
    else globalThis.localStorage?.removeItem(KEY);
    return;
  }
  if (raw) await SecureStore.setItemAsync(KEY, raw, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK });
  else await SecureStore.deleteItemAsync(KEY);
}

// ---------- observable session ----------

let session: Session | null = null;
let loaded = false;
/**
 * Bumped whenever the session is replaced or ended. A refresh that started under an older
 * generation (a sign-out or another sign-in happened meanwhile) is thrown away.
 */
let generation = 0;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

export function subscribeSession(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }
export const currentSession = () => session;
export const sessionLoaded = () => loaded;

export async function loadSession(): Promise<Session | null> {
  if (!loaded) {
    session = await readStored();
    if (session && session.refreshExpiresAt <= Date.now()) { session = null; await writeStored(null); }
    loaded = true;
    emit();
  }
  return session;
}

let sessionWrites: Promise<void> = Promise.resolve();

/** Replaces the session. Writes are applied in order; only the latest one takes effect here. */
function setSession(next: Session | null): Promise<void> {
  generation += 1;
  const mine = generation;
  const write = sessionWrites.then(() => writeStored(next)).then(() => {
    if (mine !== generation) return;
    session = next;
    emit();
  });
  sessionWrites = write.catch(() => {});
  return write;
}

// ---------- server calls ----------

type TokenResponse = { accessToken: string; accessTokenExpiresInSeconds: number; refreshToken: string; refreshExpiresAt: number; accountId: string };

export async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${SITE_URL}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new AuthError('NETWORK_UNAVAILABLE', true);
  }
  let json: unknown = null;
  try { json = await res.json(); } catch { /* handled below */ }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; retryable?: boolean } } | null)?.error;
    throw new AuthError(err?.code ?? `HTTP_${res.status}`, err?.retryable ?? (res.status === 429 || res.status >= 500));
  }
  return json as T;
}

const fromTokens = (t: TokenResponse): Session => ({
  accountId: t.accountId,
  refreshToken: t.refreshToken,
  refreshExpiresAt: t.refreshExpiresAt,
  accessToken: t.accessToken,
  accessExpiresAt: Date.now() + t.accessTokenExpiresInSeconds * 1000,
});

export async function appleSignInSupported(): Promise<boolean> {
  if (Platform.OS !== "ios") return false;
  try { return await AppleAuthentication.isAvailableAsync(); } catch { return false; }
}

/** Shows Apple's sheet and starts a session. Throws AuthError('CANCELLED') if the person backs out. */
export async function signInWithApple(): Promise<Session> {
  const raw = Crypto.getRandomBytes(32);
  const rawNonce = base64url(raw);
  const hashed = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, rawNonce, { encoding: Crypto.CryptoEncoding.HEX });
  let credential: AppleAuthentication.AppleAuthenticationCredential;
  try {
    credential = await AppleAuthentication.signInAsync({
      requestedScopes: [AppleAuthentication.AppleAuthenticationScope.EMAIL],
      nonce: hashed.toLowerCase(),
    });
  } catch (e) {
    if ((e as { code?: string }).code === 'ERR_REQUEST_CANCELED') throw new AuthError('CANCELLED', false);
    throw new AuthError('APPLE_SIGN_IN_FAILED', true);
  }
  if (!credential.identityToken || !credential.authorizationCode) throw new AuthError('APPLE_SIGN_IN_FAILED', true);
  const tokens = await post<TokenResponse>('/auth/apple/exchange', {
    identityToken: credential.identityToken,
    authorizationCode: credential.authorizationCode,
    nonce: rawNonce,
  });
  const next = fromTokens(tokens);
  await setSession(next);
  return next;
}

// ---------- Sign in with Google ----------

type GoogleModule = typeof import('@react-native-google-signin/google-signin');
let googleModule: GoogleModule | null | undefined;

/** The native Google Sign-In module, or null where it isn't built in (Expo Go, the web). */
function google(): GoogleModule | null {
  if (googleModule !== undefined) return googleModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    googleModule = Platform.OS === 'web' ? null : (require('@react-native-google-signin/google-signin') as GoogleModule);
  } catch {
    googleModule = null;
  }
  return googleModule;
}

/** Google sign-in is offered on iPhone and Android once the build carries its client IDs. */
export function googleSignInAvailable(): boolean {
  if (!GOOGLE_WEB_CLIENT_ID) return false;
  if (Platform.OS === 'ios' && !GOOGLE_IOS_CLIENT_ID) return false;
  return google() !== null;
}

/** Shows Google's account picker and starts a session. Throws AuthError('CANCELLED') if the person backs out. */
export async function signInWithGoogle(): Promise<Session> {
  const mod = google();
  if (!mod || !googleSignInAvailable()) throw new AuthError('GOOGLE_SIGN_IN_UNAVAILABLE', false);
  const { GoogleSignin, statusCodes } = mod;
  GoogleSignin.configure({ webClientId: GOOGLE_WEB_CLIENT_ID, iosClientId: GOOGLE_IOS_CLIENT_ID });
  let idToken: string | null;
  try {
    if (Platform.OS === 'android') await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    const result = await GoogleSignin.signIn();
    if (result.type !== 'success') throw new AuthError('CANCELLED', false);
    idToken = result.data.idToken;
  } catch (e) {
    if (e instanceof AuthError) throw e;
    const code = (e as { code?: string }).code;
    if (code === statusCodes.SIGN_IN_CANCELLED) throw new AuthError('CANCELLED', false);
    if (code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) throw new AuthError('PLAY_SERVICES_NOT_AVAILABLE', false);
    throw new AuthError('GOOGLE_SIGN_IN_FAILED', true);
  }
  if (!idToken) throw new AuthError('GOOGLE_SIGN_IN_FAILED', true);
  const tokens = await post<TokenResponse>('/auth/google/exchange', { idToken });
  const next = fromTokens(tokens);
  await setSession(next);
  // The Numa Shared session is what counts from here; let the Google picker show next time.
  GoogleSignin.signOut().catch(() => {});
  return next;
}

// ---------- refreshing ----------

let refreshing: Promise<string | null> | null = null;
let refreshingGeneration = -1;

/**
 * An access token for Convex. Refreshes (once at a time) when it is about to expire. Returns
 * null when signed out; a refused refresh token signs out, a network hiccup keeps the session.
 */
export async function accessToken(forceRefresh = false): Promise<string | null> {
  const s = session ?? await loadSession();
  if (!s) return null;
  if (!forceRefresh && s.accessToken && (s.accessExpiresAt ?? 0) - Date.now() > 30_000) return s.accessToken;
  if (!refreshing || refreshingGeneration !== generation) {
    const started = generation;
    const current = () => started === generation && session?.refreshToken === s.refreshToken;
    let attempt: Promise<string | null> | null = null;
    attempt = (async () => {
      try {
        const tokens = await post<TokenResponse>('/auth/refresh', { refreshToken: s.refreshToken });
        // Signed out (or in as someone else) while this was in flight: don't bring it back.
        if (!current()) return null;
        const next = fromTokens(tokens);
        await setSession(next);
        return next.accessToken!;
      } catch (e) {
        if (e instanceof AuthError && !e.retryable && current()) await setSession(null);
        return null;
      } finally {
        if (refreshing === attempt) refreshing = null;
      }
    })();
    refreshing = attempt;
    refreshingGeneration = started;
  }
  return refreshing;
}

/** Forgets the session on this phone only (the server already ended it). */
export function forgetSession(): Promise<void> {
  return setSession(null);
}

// ---------- account deletion record ----------

const DELETION_KEY = 'numa-shared.account-deletion.v1';

export async function readDeletion(): Promise<PendingDeletion | null> {
  try {
    const raw = Platform.OS === 'web' ? globalThis.localStorage?.getItem(DELETION_KEY) ?? null : await SecureStore.getItemAsync(DELETION_KEY);
    return raw ? JSON.parse(raw) as PendingDeletion : null;
  } catch {
    return null;
  }
}

export async function writeDeletion(p: PendingDeletion | null): Promise<void> {
  const raw = p ? JSON.stringify(p) : null;
  if (Platform.OS === 'web') {
    if (raw) globalThis.localStorage?.setItem(DELETION_KEY, raw);
    else globalThis.localStorage?.removeItem(DELETION_KEY);
    return;
  }
  if (raw) await SecureStore.setItemAsync(DELETION_KEY, raw, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK });
  else await SecureStore.deleteItemAsync(DELETION_KEY);
}

/** Ends the session on the server (best effort) and forgets it here. */
export async function signOutSession(): Promise<void> {
  const s = session ?? await loadSession();
  if (s) {
    try { await post('/auth/logout', { refreshToken: s.refreshToken }); } catch { /* the session expires anyway */ }
  }
  await setSession(null);
}
