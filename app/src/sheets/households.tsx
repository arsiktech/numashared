// Your households: one card per household with its two first group colors, people count and your
// standing; the current one is outlined and checked. New household, join with a code, and the
// sample household when it isn't loaded yet.
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SAMPLE_IDS } from '@/core';
import type { Household } from '@/core/types';
import { ledgerOf, loadSample, switchHousehold, useStore, yourGroup } from '@/store/store';
import { Check, Close } from '@/ui/icons';
import { IconButton, Press, T, TextButton } from '@/ui/primitives';
import { Sheet, SheetHead, useSheet } from '@/ui/sheet';
import { useTheme } from '@/ui/theme';
import { fonts, isAndroid } from '@/ui/tokens';
import { money, nameOf, yourStanding } from '@/features/hooks';
import type { SheetProps } from './host';

export function HouseholdsSheet({ spec, onClosed }: SheetProps<'households'>) {
  return (
    <Sheet origin={spec.origin} onClosed={onClosed} height="auto" label="Your households">
      <Body />
    </Sheet>
  );
}

function Body() {
  const { c } = useTheme();
  const { close } = useSheet();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const households = useStore((s) => s.households);
  const activeId = useStore((s) => s.activeId);
  const hide = useStore((s) => s.prefs.hideAmounts);
  const sampleLoaded = households.some((h) => h.id === SAMPLE_IDS.household);
  const go = (path: '/setup/new' | '/join' | '/home') => { close(); router.push(path); };
  return (
    <View>
      <SheetHead title="Your households"
        left={isAndroid ? <IconButton label="Close" onPress={() => close()}><Close size={22} color={c.ink} /></IconButton> : undefined}
        right={isAndroid ? undefined : <TextButton label="Done" bold onPress={() => close()} />} />
      <View style={{ paddingHorizontal: 22, paddingTop: 14, gap: 14 }}>
        {households.map((h) => (
          <HouseholdCard key={h.id} h={h} current={h.id === activeId} hide={hide}
            onPress={() => { switchHousehold(h.id); close(); router.replace('/home'); }} />
        ))}
      </View>
      <View style={{ paddingHorizontal: 22, paddingTop: 20, paddingBottom: Math.max(insets.bottom + 4, 20), gap: 10 }}>
        <Wide label="New household" onPress={() => go('/setup/new')} />
        <Wide label="Join with a code" onPress={() => go('/join')} />
        {!sampleLoaded ? <Wide label="Look around a sample household" onPress={() => { loadSample(); close(); router.replace('/home'); }} /> : null}
      </View>
    </View>
  );
}

function HouseholdCard({ h, current, hide, onPress }: { h: Household; current: boolean; hide: boolean; onPress: () => void }) {
  const { c, tone } = useTheme();
  const ledger = ledgerOf(h);
  const st = yourStanding(h, ledger.balances);
  const who = nameOf(h, yourGroup(h));
  const line = st.verb === 'square' ? 'all square' : `${who} ${st.verb} ${money(h, st.amount, hide)}`;
  const people = `${h.people.length} ${h.people.length === 1 ? 'person' : 'people'}`;
  const colors = h.groups.slice(0, 2).map((g) => tone(g).band);
  return (
    <Press noScale onPress={onPress} accessibilityState={{ selected: current }}
      accessibilityLabel={`${h.name}${current ? ', current household' : ''}. ${people}. ${hide ? '' : line}`}
      style={{ backgroundColor: c.card, borderRadius: 20, paddingTop: 22, paddingBottom: 20, paddingHorizontal: 20, borderWidth: 2, borderColor: current ? c.ink : 'transparent' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, minHeight: 28 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 1 }}>
          <T numberOfLines={2} style={{ fontFamily: fonts.bold, fontSize: 20, lineHeight: 24, letterSpacing: -0.2, flexShrink: 1 }}>{h.name}</T>
          <View style={{ flexDirection: 'row', width: 28, height: 14, borderRadius: 7, overflow: 'hidden' }}>
            {(colors.length ? colors : [c.chip]).map((col, i) => <View key={i} style={{ flex: 1, backgroundColor: col }} />)}
          </View>
        </View>
        {current ? (
          <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: c.ink, alignItems: 'center', justifyContent: 'center' }}>
            <Check size={16} color={c.bg} />
          </View>
        ) : null}
      </View>
      <T style={{ fontSize: 14, lineHeight: 19, color: c.ink2, marginTop: 6 }}>{people} · {line}</T>
    </Press>
  );
}

function Wide({ label, onPress }: { label: string; onPress: () => void }) {
  const { c } = useTheme();
  return (
    <Press onPress={onPress} accessibilityLabel={label}
      style={{ minHeight: 56, borderRadius: 28, backgroundColor: c.chip, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 }}>
      <T style={{ fontFamily: fonts.semibold, fontSize: 16, textAlign: 'center' }}>{label}</T>
    </Press>
  );
}
