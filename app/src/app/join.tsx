// Join with a code. The code field formats as you type ("K7Q 4MZ"). Joining someone else's
// household needs sync, which this version doesn't have yet, so submitting explains that calmly.
import { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { CloudOff } from '@/ui/icons';
import { Banner, BannerText, CTA, Press, T } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { fonts, isWeb } from '@/ui/tokens';
import { Brand, Field, Screen, ScreenHeader } from '@/features/onboarding/chrome';
import { cleanCode, showCode } from '@/features/onboarding/model';
import { useStore } from '@/store/store';

export default function Join() {
  const { c, tone, layout } = useTheme();
  const router = useRouter();
  const [code, setCode] = useState('');
  const [tried, setTried] = useState(false);
  const hasHousehold = useStore((s) => s.households.length > 0 && !s.locked);
  const phone = layout === 'phone';
  const citrus = tone('citrus');
  const lilac = tone('lilac');
  const ready = code.length === 6;
  const submit = () => { if (ready) setTried(true); };

  return (
    <Screen header={phone ? <ScreenHeader title="" /> : <Brand />}>
      <View style={{ flexDirection: 'row', alignSelf: 'flex-start', height: 56, borderRadius: 28, overflow: 'hidden', marginTop: phone ? 16 : 40 }}
        accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <View style={{ backgroundColor: citrus.band, justifyContent: 'center', paddingLeft: 22, paddingRight: 16 }}>
          <T maxFontSizeMultiplier={1.2} style={{ fontFamily: fonts.cond, fontSize: 28, color: citrus.ink }}>You’re</T>
        </View>
        <View style={{ backgroundColor: lilac.band, justifyContent: 'center', paddingLeft: 16, paddingRight: 22 }}>
          <T maxFontSizeMultiplier={1.2} style={{ fontFamily: fonts.cond, fontSize: 28, color: lilac.ink }}>invited</T>
        </View>
      </View>
      <T accessibilityRole="header" maxFontSizeMultiplier={1.4}
        style={{ fontFamily: fonts.display, fontSize: phone ? 34 : 40, lineHeight: phone ? 38 : 44, letterSpacing: -0.8, marginTop: 20 }}>
        Join a household on Numa Shared
      </T>
      <T style={{ fontSize: 16, lineHeight: 22, color: c.ink2, marginTop: 12 }}>
        Type the 6-character code from the person who invited you.
      </T>

      <View style={{ marginTop: 28 }}>
        <T nativeID="join-code" style={{ fontFamily: fonts.semibold, fontSize: 12.5, color: c.ink2, marginBottom: 8, marginHorizontal: 4 }}>Invite code</T>
        <Field value={showCode(code)} onChangeText={(v) => { setCode(cleanCode(v)); setTried(false); }}
          accessibilityLabel="Invite code, 6 characters" placeholder="K7Q 4MZ" autoCapitalize="characters" autoCorrect={false}
          autoComplete="off" maxLength={7} returnKeyType="go" onSubmitEditing={submit} autoFocus={!isWeb || !phone}
          style={{ minHeight: 76, borderRadius: 20 }}
          inputStyle={{ fontFamily: fonts.semibold, fontSize: 36, letterSpacing: 2, paddingVertical: 12, fontVariant: ['tabular-nums'] }} />
      </View>

      {tried ? (
        <View style={{ marginTop: 16 }} accessibilityLiveRegion="polite">
          <Banner icon={<CloudOff size={18} color={c.ink2} />}>
            <BannerText rest="Joining a household needs sync, which isn’t switched on in this version yet. Ask the person who invited you to add your expenses for now." />
          </Banner>
        </View>
      ) : null}

      <View style={{ gap: 12, marginTop: 20 }}>
        <CTA label={ready ? `Join with ${showCode(code)}` : 'Join'} disabled={!ready} onPress={submit}
          accessibilityLabel={ready ? `Join with code ${code.split('').join(' ')}` : 'Join. Type the 6-character code first'} />
        <CTA variant="second" label={hasHousehold ? 'Back to my household' : 'Start my own household'}
          onPress={() => (hasHousehold ? router.replace('/home') : router.replace('/setup/new'))} />
      </View>

      <Press onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} accessibilityRole="link" accessibilityLabel="Not now"
        style={{ minHeight: 44, alignSelf: 'center', justifyContent: 'center', marginTop: 8, paddingHorizontal: 8, display: phone ? 'none' : 'flex' }}>
        <T style={{ fontFamily: fonts.semibold, fontSize: 15, textDecorationLine: 'underline' }}>Not now</T>
      </Press>
      <T style={{ fontFamily: fonts.medium, fontSize: 12.5, lineHeight: 18, color: c.ink2, textAlign: 'center', marginTop: 16 }}>
        Codes work once sync is on. Until then, everything you add stays on this device.
      </T>
    </Screen>
  );
}
