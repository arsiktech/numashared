// Your account, the step between "Start a household" and setting it up (and the way back in for
// someone who already uses Numa Shared). Signing in is what lets the people you invite see the same
// household on their own phones. Without it, the household stays on this phone.
import { useEffect } from 'react';
import { View } from 'react-native';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { CloudOff } from '@/ui/icons';
import { Banner, BannerText, CTA, T } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { fonts, isWeb } from '@/ui/tokens';
import { Screen, ScreenHeader } from '@/features/onboarding/chrome';
import { inExpoGo, SignInButtons, useSession, useSignInOptions } from '@/features/account/session';
import { showToast } from '@/store/ui';

export default function Account() {
  const { c, tone, layout } = useTheme();
  const router = useRouter();
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  const returning = mode === 'signin';
  const session = useSession();
  const options = useSignInOptions();
  const phone = layout === 'phone';
  const citrus = tone('citrus');
  const lilac = tone('lilac');
  const here = isWeb ? 'in this browser' : 'on this phone';

  // Signed in already: nothing to ask here.
  useEffect(() => { if (session && !returning) router.replace('/setup/new'); }, [session, returning, router]);
  if (session && returning) return <Redirect href="/home" />;

  const done = (arrived: number) => {
    if (!returning) { router.replace('/setup/new'); return; }
    if (arrived > 0) { router.replace('/home'); return; }
    showToast('You’re signed in. This account has no households yet.');
    router.replace('/welcome');
  };

  return (
    <Screen header={<ScreenHeader title="" />}>
      <View style={{ flexDirection: 'row', alignSelf: 'flex-start', height: 56, borderRadius: 28, overflow: 'hidden', marginTop: phone ? 16 : 40 }}
        accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <View style={{ backgroundColor: citrus.band, justifyContent: 'center', paddingLeft: 22, paddingRight: 16 }}>
          <T maxFontSizeMultiplier={1.2} style={{ fontFamily: fonts.cond, fontSize: 28, color: citrus.ink }}>{returning ? 'Welcome' : 'One'}</T>
        </View>
        <View style={{ backgroundColor: lilac.band, justifyContent: 'center', paddingLeft: 16, paddingRight: 22 }}>
          <T maxFontSizeMultiplier={1.2} style={{ fontFamily: fonts.cond, fontSize: 28, color: lilac.ink }}>{returning ? 'back' : 'balance'}</T>
        </View>
      </View>
      <T accessibilityRole="header" maxFontSizeMultiplier={1.4}
        style={{ fontFamily: fonts.display, fontSize: phone ? 34 : 40, lineHeight: phone ? 38 : 44, letterSpacing: -0.8, marginTop: 20 }}>
        {returning ? 'Sign in to Numa Shared' : 'Create your account'}
      </T>
      <T style={{ fontSize: 16, lineHeight: 22, color: c.ink2, marginTop: 12 }}>
        {returning
          ? 'Use the same account as before and your households come back.'
          : 'Signing in lets the people you invite see the same household and balance on their own phone or computer. Your account is only used to sign you in. You can also start without one.'}
      </T>

      {options.any ? (
        <View style={{ marginTop: 28 }}>
          <SignInButtons onSignedIn={done} />
        </View>
      ) : (
        <View style={{ marginTop: 24 }}>
          <Banner icon={<CloudOff size={18} color={c.ink2} />}>
            <BannerText rest={inExpoGo
              ? 'This is the Expo Go preview, where signing in isn’t possible. The installed app can.'
              : 'Signing in isn’t available on this device yet.'} />
          </Banner>
        </View>
      )}

      {!returning ? (
        <View style={{ marginTop: 16 }}>
          <CTA variant="second" label={`Start without an account`} accessibilityLabel={`Start without an account. Keep the household ${here}`}
            onPress={() => router.replace('/setup/new')} />
          <T style={{ fontFamily: fonts.medium, fontSize: 12.5, lineHeight: 18, color: c.ink2, textAlign: 'center', marginTop: 8 }}>
            {`It stays ${here} until you sign in and share it from Invite people.`}
          </T>
        </View>
      ) : null}
    </Screen>
  );
}
