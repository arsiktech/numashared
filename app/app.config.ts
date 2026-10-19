// Build-time config. There is one app: the committed ios/ project is generated from this config
// (scripts/check-native-sync.mjs fails CI when they drift apart), so a variant here could never
// reach a native build.
import type { ExpoConfig, ConfigContext } from 'expo/config';

/** "123-abc.apps.googleusercontent.com" becomes the URL scheme Google redirects to on iOS. */
const reversedClientId = (id: string) => id.split('.').reverse().join('.');

export default ({ config }: ConfigContext): ExpoConfig => {
  const googleIosClientId: string | undefined = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID
    || (config.extra?.googleSignIn as { iosClientId?: string } | undefined)?.iosClientId || undefined;
  return {
    ...config,
    name: 'Numa Shared',
    slug: 'numa-shared',
    plugins: [
      ...(config.plugins ?? []),
      // Google Sign-In needs its URL scheme at build time, so it is added only when configured.
      ...(googleIosClientId
        ? [['@react-native-google-signin/google-signin', { iosUrlScheme: reversedClientId(googleIosClientId) }] as [string, object]]
        : []),
    ],
  };
};
