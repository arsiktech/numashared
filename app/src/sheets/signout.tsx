// Sign out of this device. Shared households are safe on the account and leave this phone until you
// sign in again. Households that were never shared have no other copy, so for those the two choices
// are honest: lock (kept, hidden until Unlock on Welcome) or erase (gone, after two confirmations).
import { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { signOut, useStore } from '@/store/store';
import { useSession } from '@/features/account/session';
import { signOutEverywhere, unsentCount } from '@/sync/runtime';
import { Close, Lock, VoidX, Warn } from '@/ui/icons';
import { Banner, BannerText, CTA, haptic, IconButton, Press, T, TextButton } from '@/ui/primitives';
import { Sheet, useSheet } from '@/ui/sheet';
import { useTheme } from '@/ui/theme';
import { fonts, isAndroid } from '@/ui/tokens';
import type { SheetProps } from './host';

export function SignOutSheet({ spec, onClosed }: SheetProps<'signout'>) {
  return (
    <Sheet origin={spec.origin} onClosed={onClosed} height="auto" label="Sign out">
      <Body />
    </Sheet>
  );
}

function listNames(names: string[]) {
  if (names.length <= 1) return names[0] ?? 'your households';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function Body() {
  const { c } = useTheme();
  const { close } = useSheet();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const households = useStore((s) => s.households);
  const session = useSession();
  const names = households.filter((h) => !h.sync).map((h) => h.name);
  const onlyShared = !!session && names.length === 0;
  const [mode, setMode] = useState<'lock' | 'erase'>('lock');
  const [step, setStep] = useState(0); // erase needs two confirmations

  const go = async () => {
    // Erasing asks twice; nothing happens until the second tap.
    if (!onlyShared && mode === 'erase' && step === 0) { setStep(1); haptic.warn(); return; }
    if (session) await signOutEverywhere();
    if (!onlyShared) signOut(mode);
    haptic.success();
    close();
    router.replace('/welcome');
  };

  const option = (key: 'lock' | 'erase', title: string, sub: string, icon: (on: boolean) => React.ReactNode) => {
    const on = mode === key;
    return (
      <Press noScale accessibilityRole="radio" accessibilityState={{ checked: on }} accessibilityLabel={`${title}. ${sub}`}
        onPress={() => { setMode(key); setStep(0); haptic.tick(); }}
        style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 14, backgroundColor: c.card, borderRadius: 18, paddingVertical: 18, paddingHorizontal: 16,
          borderWidth: 2, borderColor: on ? c.ink : 'transparent' }}>
        <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: on ? c.ink : c.chip, alignItems: 'center', justifyContent: 'center' }}>{icon(on)}</View>
        <View style={{ flex: 1 }}>
          <T style={{ fontFamily: fonts.bold, fontSize: 17, lineHeight: 22 }}>{title}</T>
          <T style={{ fontSize: 14, lineHeight: 19, color: c.ink2, marginTop: 3 }}>{sub}</T>
        </View>
      </Press>
    );
  };

  return (
    <View>
      {isAndroid ? (
        <View style={{ paddingHorizontal: 10 }}><IconButton label="Close" onPress={() => close()}><Close size={22} color={c.ink} /></IconButton></View>
      ) : null}
      <View style={{ paddingHorizontal: 22, paddingTop: isAndroid ? 0 : 22 }}>
        <T accessibilityRole="header" style={{ fontFamily: fonts.bold, fontSize: 22, lineHeight: 26, letterSpacing: -0.2 }}>Sign out of this device?</T>
        <T style={{ fontSize: 14, lineHeight: 19, color: c.ink2, marginTop: 6 }}>
          {onlyShared
            ? 'Your shared households stay on your account. Sign in with Apple again to get them back.'
            : session
              ? `Shared households stay on your account. ${listNames(names)} ${names.length === 1 ? 'was' : 'were'} never shared and ${names.length === 1 ? 'lives' : 'live'} only here. Choose what happens to ${names.length === 1 ? 'it' : 'them'}.`
              : 'Your households live only on this device. Choose what happens to them.'}
        </T>
        {onlyShared ? null : <View accessibilityRole="radiogroup" accessibilityLabel="What happens on this device" style={{ gap: 12, marginTop: 22 }}>
          {option('lock', 'Lock this device', 'Keeps everything here, hidden until you tap Unlock on the welcome screen.',
            (on) => <Lock size={18} color={on ? c.bg : c.ink} />)}
          {option('erase', 'Erase from this device', `Deletes ${listNames(names)} from this device. There’s no other copy yet.`,
            (on) => <VoidX size={18} color={on ? c.bg : c.ink} />)}
        </View>}
        {session && unsentCount() > 0 ? (
          <View style={{ marginTop: 16 }}>
            <Banner kind="warn" icon={<Warn size={18} color={c.warnInk} />}>
              <BannerText kind="warn" strong={`${unsentCount()} change${unsentCount() > 1 ? 's haven’t' : ' hasn’t'} reached the others yet.`}
                rest=" Connect to the internet first: signing out now removes them from this phone." />
            </Banner>
          </View>
        ) : null}
        {mode === 'erase' && step === 1 ? (
          <View style={{ marginTop: 16 }} accessibilityLiveRegion="assertive">
            <Banner kind="bad" icon={<Warn size={18} color={c.bad} />}>
              <BannerText kind="bad" strong="This can’t be undone." rest="Every expense, repayment and edit is deleted. Export a CSV first if you want a record." />
            </Banner>
          </View>
        ) : null}
      </View>
      <View style={{ paddingHorizontal: 22, paddingTop: 24, paddingBottom: Math.max(insets.bottom + 4, 16) }}>
        <CTA variant={mode === 'erase' && !onlyShared ? 'danger' : 'primary'} onPress={go}
          label={onlyShared ? 'Sign out' : mode === 'lock' ? 'Lock this device' : step === 0 ? 'Erase from this device' : 'Yes, erase everything'} />
        {mode === 'erase' && step === 1 ? (
          <TextButton label="Export CSV first" bold onPress={() => { close(); router.push('/settings/export'); }} style={{ alignSelf: 'center', marginTop: 6 }} />
        ) : null}
        {!isAndroid ? <TextButton label="Cancel" onPress={() => close()} style={{ alignSelf: 'center', marginTop: 6 }} /> : null}
      </View>
    </View>
  );
}
