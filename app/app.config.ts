// Build-time config. APP_VARIANT=preview builds a separate "Numa Shared Preview" app, so a test build
// never replaces the Numa Shared app people already use.
import type { ExpoConfig, ConfigContext } from 'expo/config';

const variant = process.env.APP_VARIANT ?? 'production';
const isPreview = variant === 'preview';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: isPreview ? 'Numa Shared Preview' : 'Numa Shared',
  slug: 'numa-shared',
  ios: {
    ...config.ios,
    bundleIdentifier: isPreview ? 'tech.arsik.numashared.preview' : 'tech.arsik.numashared',
  },
  android: {
    ...config.android,
    package: isPreview ? 'tech.arsik.numashared.preview' : 'tech.arsik.numashared',
  },
});
