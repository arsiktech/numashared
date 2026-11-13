// The web top bar for tablet and desk layouts: brand, household switcher, history search, Repay
// and the account avatar. Adding an expense is the orb on the balance bands (or N). It also owns the global keyboard shortcuts: N adds an expense,
// / searches history, R records a repayment. Shortcuts are ignored while typing or while a sheet is open.
import { requestHistorySearch } from '@/features/history/search';
import { useEffect, useRef } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { activeHousehold, useStore, yourGroup } from '@/store/store';
import { openSheet, useUI } from '@/store/ui';
import { ChevDown, Repay, Search } from '@/ui/icons';
import { Press, T } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { isWeb } from '@/ui/tokens';
import { space, text } from '@/ui/scale';
import { MiniOrb } from '@/features/onboarding/chrome';
import { Kbd } from './kbd';

export function WebTopBar() {
  const { ui, layout } = useTheme();
  const router = useRouter();
  const h = useStore(activeHousehold);
  const sheetsOpen = useUI((u) => u.sheets.length);
  const busy = useRef(sheetsOpen);
  busy.current = sheetsOpen;
  const routerRef = useRef(router);
  routerRef.current = router;
  const desk = layout === 'desk';
  // On iPad the bar sits under the status bar, so it grows by the top inset. Browsers report 0.
  const top = useSafeAreaInsets().top;

  useEffect(() => {
    if (!isWeb || typeof window === 'undefined') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if (document.querySelector('[data-fb-self]')) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      if (busy.current > 0) return;
      const k = e.key.toLowerCase();
      if (k === 'n') { e.preventDefault(); openSheet({ type: 'add' }); }
      else if (k === '/') { e.preventDefault(); requestHistorySearch(); routerRef.current.navigate('/home'); }
      else if (k === 'r') { e.preventDefault(); openSheet({ type: 'repay' }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!h) return null;
  const pill = { height: 44, borderRadius: 22, flexDirection: 'row', alignItems: 'center', gap: space[2] } as const;
  return (
    <View accessibilityRole="header" style={{ height: 64 + top, paddingTop: top, flexDirection: 'row', alignItems: 'center', gap: space[3], paddingHorizontal: space[5],
      borderBottomWidth: 1, borderBottomColor: ui.line, backgroundColor: ui.canvas }}>
      <Press noScale onPress={() => router.navigate('/home')} accessibilityRole="link" accessibilityLabel="Numa Shared, Home"
        style={{ flexDirection: 'row', alignItems: 'center', gap: space[2], minHeight: 44 }}>
        <MiniOrb size={space[5]} />
        {desk ? <T style={text.title}>Numa Shared</T> : null}
      </Press>
      <Press onPress={() => openSheet({ type: 'households' })} accessibilityLabel={`Household: ${h.name}. Switch`}
        style={[pill, { paddingLeft: space[4], paddingRight: space[3], backgroundColor: ui.wash, maxWidth: 260, gap: space[1] }]}>
        <T numberOfLines={1} style={[text.strong, { flexShrink: 1 }]}>{h.name}</T>
        <ChevDown size={16} color={ui.ink} />
      </Press>
      <View style={{ flex: 1 }} />
      <Press noScale onPress={() => { requestHistorySearch(); router.navigate('/home'); }} accessibilityLabel="Search history" accessibilityHint="Shortcut: slash"
        style={[pill, { flexShrink: 1, width: 280, borderWidth: 1, borderColor: ui.line, paddingLeft: space[4], paddingRight: space[3] }]}>
        <Search size={18} color={ui.muted} />
        <T numberOfLines={1} style={[text.body, { flex: 1, color: ui.muted }]}>Search history</T>
        <Kbd k="/" />
      </Press>
      <Press onPress={() => openSheet({ type: 'repay' })} accessibilityLabel="Repay" accessibilityHint="Shortcut: R"
        style={{ height: 44, minWidth: 44, paddingLeft: space[4], paddingRight: space[3], borderRadius: 22, borderWidth: 1, borderColor: ui.line, flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
        <Repay size={18} color={ui.ink} />
        <T style={text.strong}>Repay</T>
        <Kbd k="R" />
      </Press>
      <Press onPress={() => router.push('/settings')} accessibilityLabel="Settings and account"
        style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: ui.group(yourGroup(h)), alignItems: 'center', justifyContent: 'center' }}>
        <T style={[text.strong, { color: ui.onFill }]}>Y</T>
      </Press>
    </View>
  );
}
