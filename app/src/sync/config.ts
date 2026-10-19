import Constants from 'expo-constants';

// Where the backend lives. EXPO_PUBLIC_* overrides are for local testing only.
export const CONVEX_URL = process.env.EXPO_PUBLIC_CONVEX_URL ?? 'https://adept-camel-457.convex.cloud';
export const SITE_URL = process.env.EXPO_PUBLIC_CONVEX_SITE_URL ?? 'https://adept-camel-457.convex.site';

/**
 * Google OAuth client IDs (public identifiers, not secrets), kept in app.json under
 * extra.googleSignIn; EXPO_PUBLIC_* variables override them. Sign in with Google stays hidden
 * until they are present. The backend must list both in NUMA_SHARED_GOOGLE_CLIENT_IDS.
 */
const google = (Constants.expoConfig?.extra?.googleSignIn ?? {}) as { iosClientId?: string; webClientId?: string };
export const GOOGLE_IOS_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID || google.iosClientId || undefined;
export const GOOGLE_WEB_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID || google.webClientId || undefined;
