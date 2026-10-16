// Sign in with Apple and the Numa Shared session. Apple's token is exchanged once for a 30-day
// session: a 5-minute access token for Convex plus a refresh token that rotates on every use.
// Only the refresh token is stored, in the Keychain (localStorage on the web).
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { SITE_URL } from './config';
import { base64url } from './engine';

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

async function setSession(next: Session | null) {
  await writeStored(next);
  session = next;
  emit();
}

// ---------- server calls ----------

type TokenResponse = { accessToken: string; accessTokenExpiresInSeconds: number; refreshToken: string; refreshExpiresAt: number; accountId: string };

async function post<T>(path: string, body: unknown): Promise<T> {
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
  const raw = new Uint8Array(32);
  globalThis.crypto.getRandomValues(raw);
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

let refreshing: Promise<string | null> | null = null;

/**
 * An access token for Convex. Refreshes (once at a time) when it is about to expire. Returns
 * null when signed out; a refused refresh token signs out, a network hiccup keeps the session.
 */
export async function accessToken(forceRefresh = false): Promise<string | null> {
  const s = session ?? await loadSession();
  if (!s) return null;
  if (!forceRefresh && s.accessToken && (s.accessExpiresAt ?? 0) - Date.now() > 30_000) return s.accessToken;
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const tokens = await post<TokenResponse>('/auth/refresh', { refreshToken: s.refreshToken });
        const next = fromTokens(tokens);
        await setSession(next);
        return next.accessToken!;
      } catch (e) {
        if (e instanceof AuthError && !e.retryable) {
          await setSession(null);
          return null;
        }
        return null;
      } finally {
        refreshing = null;
      }
    })();
  }
  return refreshing;
}

/** Ends the session on the server (best effort) and forgets it here. */
export async function signOutSession(): Promise<void> {
  const s = session ?? await loadSession();
  if (s) {
    try { await post('/auth/logout', { refreshToken: s.refreshToken }); } catch { /* the session expires anyway */ }
  }
  await setSession(null);
}
