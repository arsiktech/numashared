// An address the app doesn't have, usually a mistyped or old link on the web.
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useStore } from '@/store/store';
import { CTA, Press, T } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { fonts, isWeb } from '@/ui/tokens';
import { Brand } from '@/features/onboarding/chrome';
import { PUBLIC_SITE_URL } from '@/sync/config';

export default function NotFound() {
  const { c } = useTheme();
  const router = useRouter();
  const has = useStore((s) => s.households.length > 0);
  return (
    <View style={{ flex: 1, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <View style={{ width: '100%', maxWidth: 400, gap: 12 }}>
        <Brand />
        <T accessibilityRole="header" style={{ fontFamily: fonts.display, fontSize: 30, lineHeight: 36, letterSpacing: -0.6, marginTop: 16 }}>
          This page doesn’t exist
        </T>
        <T style={{ fontSize: 16, lineHeight: 22, color: c.ink2, marginBottom: 12 }}>The link may be old or mistyped. Your households are safe.</T>
        <CTA label={has ? 'Go to your household' : 'Go to the start'} onPress={() => router.replace(has ? '/home' : '/welcome')} />
        {isWeb ? (
          <Press accessibilityRole="link" onPress={() => { window.location.href = `${PUBLIC_SITE_URL}/`; }}
            style={{ minHeight: 44, alignSelf: 'center', justifyContent: 'center' }}>
            <T style={{ fontSize: 15, fontFamily: fonts.semibold, textDecorationLine: 'underline' }}>Numa Shared home page</T>
          </Press>
        ) : null}
      </View>
    </View>
  );
}
