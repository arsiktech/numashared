import Constants from 'expo-constants';

// Where the backend lives. EXPO_PUBLIC_* overrides are for local testing only.
export const CONVEX_URL = process.env.EXPO_PUBLIC_CONVEX_URL ?? 'https://adept-camel-457.convex.cloud';
export const SITE_URL = process.env.EXPO_PUBLIC_CONVEX_SITE_URL ?? 'https://adept-camel-457.convex.site';
// The branded address people see: invite links, privacy and support. It serves the same pages.
export const PUBLIC_SITE_URL = process.env.EXPO_PUBLIC_SITE_URL ?? 'https://shared.numaworth.com';

/**
 * Google OAuth client IDs (public identifiers, not secrets), kept in app.json under
 * extra.googleSignIn; EXPO_PUBLIC_* variables override them. Sign in with Google stays hidden
 * until they are present. The backend must list both in NUMA_SHARED_GOOGLE_CLIENT_IDS.
 */
const google = (Constants.expoConfig?.extra?.googleSignIn ?? {}) as { iosClientId?: string; webClientId?: string };
export const GOOGLE_IOS_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID || google.iosClientId || undefined;
export const GOOGLE_WEB_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID || google.webClientId || undefined;

/**
 * Sign in with Apple on the web: the Services ID (a public identifier) and the return address
 * registered for it at Apple. The web shows Apple only when the ID is set at build time.
 */
export const APPLE_WEB_CLIENT_ID = process.env.EXPO_PUBLIC_APPLE_WEB_CLIENT_ID || undefined;
export const APPLE_WEB_REDIRECT_URI = process.env.EXPO_PUBLIC_APPLE_WEB_REDIRECT_URI || `${PUBLIC_SITE_URL}/app/`;
