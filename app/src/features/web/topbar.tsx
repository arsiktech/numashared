// The web top bar for tablet and desk layouts: brand, household switcher, history search, New expense
// and the account avatar. It also owns the global keyboard shortcuts: N adds an expense, / searches
// history, R records a repayment. Shortcuts are ignored while typing or while a sheet is open.
import { useEffect, useRef } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { activeHousehold, useStore, yourGroup } from '@/store/store';
import { openSheet, useUI } from '@/store/ui';
import { ChevDown, Plus, Search } from '@/ui/icons';
import { Press, T } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { fonts, isWeb } from '@/ui/tokens';
import { MiniOrb } from '@/features/onboarding/chrome';
import { Kbd } from './kbd';

export function WebTopBar() {
  const { c, tone, layout } = useTheme();
  const router = useRouter();
  const h = useStore(activeHousehold);
  const sheetsOpen = useUI((u) => u.sheets.length);
  const busy = useRef(sheetsOpen);
  busy.current = sheetsOpen;
  const routerRef = useRef(router);
  routerRef.current = router;
  const desk = layout === 'desk';

  useEffect(() => {
    if (!isWeb || typeof window === 'undefined') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      if (busy.current > 0) return;
      const k = e.key.toLowerCase();
      if (k === 'n') { e.preventDefault(); openSheet({ type: 'add' }); }
      else if (k === '/') { e.preventDefault(); routerRef.current.push('/history?search=1'); }
      else if (k === 'r') { e.preventDefault(); openSheet({ type: 'repay' }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!h) return null;
  const mine = tone(yourGroup(h));
  return (
    <View accessibilityRole="header" style={{ height: 60, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20,
      borderBottomWidth: 1, borderBottomColor: c.hair, backgroundColor: c.bg }}>
      <Press noScale onPress={() => router.navigate('/home')} accessibilityRole="link" accessibilityLabel="Numa Shared, Home"
        style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 }}>
        <MiniOrb size={30} />
        {desk ? <T style={{ fontFamily: fonts.display, fontSize: 19, letterSpacing: -0.4 }}>Numa Shared</T> : null}
      </Press>
      <Press onPress={() => openSheet({ type: 'households' })} accessibilityLabel={`Household: ${h.name}. Switch`}
        style={{ height: 40, paddingLeft: 16, paddingRight: 12, borderRadius: 20, backgroundColor: c.chip, flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: 260 }}>
        <T numberOfLines={1} style={{ fontFamily: fonts.semibold, fontSize: 16, flexShrink: 1 }}>{h.name}</T>
        <ChevDown size={16} color={c.ink} />
      </Press>
      <View style={{ flex: 1 }} />
      <Press noScale onPress={() => router.push('/history?search=1')} accessibilityLabel="Search history" accessibilityHint="Shortcut: slash"
        style={{ flexShrink: 1, width: 280, height: 40, borderRadius: 20, backgroundColor: c.card, borderWidth: 1, borderColor: c.hair,
          flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 14, paddingRight: 9 }}>
        <Search size={18} color={c.ink2} />
        <T numberOfLines={1} style={{ flex: 1, fontSize: 14.5, color: c.ink2 }}>Search history</T>
        <Kbd k="/" />
      </Press>
      <Press onPress={() => openSheet({ type: 'add' })} accessibilityLabel="New expense" accessibilityHint="Shortcut: N"
        style={{ height: 40, paddingLeft: 14, paddingRight: 10, borderRadius: 20, backgroundColor: c.ink, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Plus size={18} color={c.bg} />
        <T style={{ fontFamily: fonts.semibold, fontSize: 16, color: c.bg }}>New expense</T>
        <Kbd k="N" onInk />
      </Press>
      <Press onPress={() => router.push('/settings')} accessibilityLabel="Settings and account"
        style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: mine.band, alignItems: 'center', justifyContent: 'center' }}>
        <T style={{ fontFamily: fonts.display, fontSize: 16, color: mine.ink }}>Y</T>
      </Press>
    </View>
  );
}
