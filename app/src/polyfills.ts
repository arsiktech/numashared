// Runtime gaps on iOS and Android. Imported first by the root layout.
// React Native has no Web Crypto: give it getRandomValues from the platform's secure generator,
// which sign-in nonces, invite secrets and ids all rely on.
import { getRandomValues } from 'expo-crypto';

const g = globalThis as { crypto?: { getRandomValues?: unknown } };
if (typeof g.crypto?.getRandomValues !== 'function') {
  const existing = (g.crypto ?? {}) as object;
  (globalThis as { crypto: unknown }).crypto = Object.assign(existing, {
    getRandomValues: <T extends ArrayBufferView>(array: T): T => getRandomValues(array as never) as T,
  });
}
