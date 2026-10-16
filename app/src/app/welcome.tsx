// Welcome. Phone: the two-band hero ("Share the" / "house money.") with the orb on the seam and the
// actions on a paper sheet below. Tablet and desk web: the hero fills the left half and the actions
// sit in a card on the right. On iPhone, Continue with Apple brings in your shared households.
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { loadSample, unlock, useStore } from '@/store/store';
import { Lock } from '@/ui/icons';
import { CTA, Press, T } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { fonts } from '@/ui/tokens';
import { Brand, MiniOrb } from '@/features/onboarding/chrome';
import { AppleCTA, useAppleAvailable } from '@/features/account/session';

export default function Welcome() {
  const { layout } = useTheme();
  return layout === 'phone' ? <PhoneWelcome /> : <DeskWelcome />;
}

function PhoneWelcome() {
  const { c, tone, width, height } = useTheme();
  const insets = useSafeAreaInsets();
  const [lowerH, setLowerH] = useState(370);
  const citrus = tone('citrus');
  const lilac = tone('lilac');
  const heroH = Math.round(Math.min(560, Math.max(300, height - lowerH + 26)));
  const topH = Math.round(heroH * 0.56);
  const size = Math.min(80, (width - 44) / 4.3);
  const big = { fontFamily: fonts.cond, fontSize: size, lineHeight: size * 0.94 };
  const orb = Math.round(Math.min(92, size * 1.15));
  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={{ flexGrow: 1 }} bounces={false}>
      <View style={{ height: heroH }} accessibilityRole="header" accessible accessibilityLabel="Numa Shared. Share the house money.">
        <View style={{ height: topH, backgroundColor: citrus.band }}>
          <T maxFontSizeMultiplier={1} style={[big, { color: citrus.ink, position: 'absolute', left: 22, bottom: 6 }]}>Share the</T>
        </View>
        <View style={{ flex: 1, backgroundColor: lilac.band, paddingTop: 14, paddingHorizontal: 22 }}>
          <T maxFontSizeMultiplier={1} style={[big, { color: lilac.ink, maxWidth: Math.max(320, size * 4) }]}>house money.</T>
        </View>
        <View style={{ position: 'absolute', right: 20, top: topH - orb / 2 }}><MiniOrb size={orb} /></View>
      </View>
      <View onLayout={(e) => setLowerH(e.nativeEvent.layout.height)}
        style={{ flexGrow: 1, marginTop: -26, backgroundColor: c.bg, borderTopLeftRadius: 26, borderTopRightRadius: 26,
          paddingHorizontal: 22, paddingTop: 22, paddingBottom: Math.max(insets.bottom, 12) }}>
        <WelcomeActions />
      </View>
    </ScrollView>
  );
}

function DeskWelcome() {
  const { c, tone, width, layout } = useTheme();
  const citrus = tone('citrus');
  const lilac = tone('lilac');
  const size = Math.max(56, Math.min(96, width * 0.067));
  const big = { fontFamily: fonts.cond, fontSize: size, lineHeight: size * 0.94 };
  const pad = layout === 'desk' ? 48 : 28;
  const orb = layout === 'desk' ? 92 : 80;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={{ flexGrow: 1, flexDirection: 'row' }}>
      <View style={{ flex: 1, minWidth: 0 }} accessible accessibilityRole="header" accessibilityLabel="Numa Shared. Share the house money.">
        <View style={{ flex: 1, backgroundColor: citrus.band, justifyContent: 'flex-end', paddingHorizontal: pad, paddingBottom: 14 }}>
          <T maxFontSizeMultiplier={1} numberOfLines={1} style={[big, { color: citrus.ink }]}>Share the</T>
        </View>
        <View style={{ flex: 1, backgroundColor: lilac.band, paddingHorizontal: pad, paddingTop: 14 }}>
          <T maxFontSizeMultiplier={1} style={[big, { color: lilac.ink }]}>house money.</T>
        </View>
        <View style={{ position: 'absolute', right: pad, top: '50%', marginTop: -orb / 2 }}><MiniOrb size={orb} /></View>
      </View>
      <View style={{ flex: 1, minWidth: 0, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, paddingVertical: 40 }}>
        <View style={{ width: '100%', maxWidth: 400, backgroundColor: c.card, borderRadius: 28, paddingTop: 40, paddingHorizontal: 36, paddingBottom: 32,
          borderWidth: c.dark ? 1 : 0, borderColor: c.hair,
          shadowColor: '#1E2420', shadowOpacity: 0.07, shadowRadius: 50, shadowOffset: { width: 0, height: 20 } }}>
          <Brand />
          <T accessibilityRole="header" style={{ fontFamily: fonts.display, fontSize: 30, lineHeight: 36, letterSpacing: -0.6, marginTop: 28 }}>Get started</T>
          <T style={{ fontSize: 14, color: c.ink2, marginTop: 6, marginBottom: 22 }}>One balance for everyone you live with.</T>
          <WelcomeActions desk />
        </View>
      </View>
    </ScrollView>
  );
}

function WelcomeActions({ desk }: { desk?: boolean }) {
  const { c } = useTheme();
  const router = useRouter();
  const locked = useStore((s) => s.locked && s.households.length > 0);
  const lockedCount = useStore((s) => s.households.length);
  const apple = useAppleAvailable();
  return (
    <View>
      {!desk ? (
        <T style={{ fontSize: 16, lineHeight: 22, marginBottom: 22 }}>
          {locked
            ? `This device is locked. ${lockedCount === 1 ? 'Your household is' : `Your ${lockedCount} households are`} still here, hidden until you unlock.`
            : 'Add an expense in seconds. Everyone sees the same balance, and nothing is ever deleted.'}
        </T>
      ) : locked ? (
        <T style={{ fontSize: 14, color: c.ink2, marginTop: -8, marginBottom: 18 }}>This device is locked. Your households are still here.</T>
      ) : null}
      <View style={{ gap: 12 }}>
        {locked ? (
          <CTA label="Unlock" icon={<Lock size={20} color={c.bg} />} onPress={() => { unlock(); router.replace('/home'); }} />
        ) : (
          <>
            {apple ? (
              <AppleCTA onSignedIn={(arrived) => router.replace(arrived > 0 ? '/home' : '/setup/new')} />
            ) : null}
            <CTA label="Start a household" variant={apple ? 'second' : 'primary'} onPress={() => router.push('/setup/new')} />
            <CTA label="Look around a sample household" variant="second" onPress={() => { loadSample(); router.replace('/home'); }} />
          </>
        )}
      </View>
      <Press onPress={() => router.push('/join')} accessibilityRole="link" accessibilityLabel="Got an invite? Enter a code"
        style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', marginTop: desk ? 14 : 10 }}>
        <T style={{ fontSize: 14, color: c.ink2 }}>Got an invite? </T>
        <T style={{ fontSize: 14, fontFamily: fonts.bold, textDecorationLine: 'underline' }}>Enter a code</T>
      </Press>
      <T style={{ fontSize: 13, lineHeight: 18, color: c.ink2, textAlign: 'center', marginTop: 6, paddingHorizontal: 8 }}>
        {apple
          ? 'Sign in to share a household between phones. Without it, everything stays on this device.'
          : 'Sharing between phones needs Sign in with Apple on an iPhone for now. Here, everything stays on this device.'}
      </T>
    </View>
  );
}
