// Build-time config. APP_VARIANT=preview builds a separate "Numa Shared Preview" app, so a test build
// never replaces the Numa Shared app people already use.
import type { ExpoConfig, ConfigContext } from 'expo/config';

const variant = process.env.APP_VARIANT ?? 'production';

/** "123-abc.apps.googleusercontent.com" becomes the URL scheme Google redirects to on iOS. */
const reversedClientId = (id: string) => id.split('.').reverse().join('.');
const isPreview = variant === 'preview';

export default ({ config }: ConfigContext): ExpoConfig => {
  const googleIosClientId: string | undefined = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID
    || (config.extra?.googleSignIn as { iosClientId?: string } | undefined)?.iosClientId || undefined;
  return {
    ...config,
    name: isPreview ? 'Numa Shared Preview' : 'Numa Shared',
    slug: 'numa-shared',
    ios: {
      ...config.ios,
      bundleIdentifier: isPreview ? 'tech.arsik.numashared.preview' : 'tech.arsik.numashared',
    },
    plugins: [
      ...(config.plugins ?? []),
      // Google Sign-In needs its URL scheme at build time, so it is added only when configured.
      ...(googleIosClientId
        ? [['@react-native-google-signin/google-signin', { iosUrlScheme: reversedClientId(googleIosClientId) }] as [string, object]]
        : []),
    ],
    android: {
      ...config.android,
      package: isPreview ? 'tech.arsik.numashared.preview' : 'tech.arsik.numashared',
    },
  };
};
