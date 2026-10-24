// Home. Phone: bands, ticket and orb, then the latest records. Desk: three panes, balance on the
// left, the history thread in the middle and the selected record on the right.
import { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { Extrapolation, interpolate, runOnJS, useAnimatedReaction, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { Redirect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { markSeen, useStore } from '@/store/store';
import { openSheet } from '@/store/ui';
import { Check, ChevDown, Search } from '@/ui/icons';
import { Press, T } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { fonts, isWeb } from '@/ui/tokens';
import { money, nameOf, useHousehold } from '@/features/hooks';
import { Bands } from '@/features/home/bands';
import { OrbButton, RecordRow } from '@/features/records';
import type { LedgerRecord } from '@/core/types';
import { dayLabel, sameDay } from '@/features/history/model';
import { requestHistorySearch } from '@/features/history/search';
import { SyncLine } from '@/features/home/syncline';
import { HistoryThread } from '@/features/history/thread';
import { RecordDetail } from '@/features/detail/content';
import { WebTopBar } from '@/features/web/topbar';

export default function Home() {
  const { h, ledger, hide } = useHousehold();
  const { layout } = useTheme();
  const recent = useStore((s) => s.recent);
  useEffect(() => {
    if (h) markSeen(h.id, h.events.map((e) => e.id));
  }, [h]);
  if (!h || !ledger) return <Redirect href="/welcome" />;
  if (layout === 'desk' || layout === 'tablet') return <DeskHome />;
  return <PhoneHome freshIds={new Set(recent.filter((r) => Date.now() - r.at < 8000).map((r) => r.eventId))} />;
}

type Row = { kind: 'day'; key: string; label: string } | { kind: 'record'; key: string; r: LedgerRecord; last: boolean };

/** Every record, newest first, with a line for each day. */
function rows(records: LedgerRecord[]): Row[] {
  const sorted = [...records].sort((a, b) => b.updatedAt - a.updatedAt);
  const out: Row[] = [];
  sorted.forEach((r, i) => {
    if (i === 0 || !sameDay(sorted[i - 1].updatedAt, r.updatedAt)) out.push({ kind: 'day', key: `d${r.updatedAt}`, label: dayLabel(r.updatedAt) });
    out.push({ kind: 'record', key: r.id, r, last: i === sorted.length - 1 || !sameDay(sorted[i + 1].updatedAt, r.updatedAt) });
  });
  return out;
}

type Item = { kind: 'gap'; key: string } | { kind: 'head'; key: string } | Row;

// The bands are drawn once, fixed behind everything, so they never move. In front of them is one
// ordinary list that iOS scrolls natively (momentum, bounce): it starts with a transparent gap the
// bands' height, then the "Latest" header, which sticks at the top natively, then the history.
// Scrolling slides the history up over the bands; nothing re-positions anything per frame.
// Taps in the gap reach an invisible copy of the bands in exactly the same place, so every band
// button still works; that copy is the only thing that follows the scroll, and it can't be seen.
function PhoneHome({ freshIds }: { freshIds: Set<string> }) {
  const { h, ledger, hide } = useHousehold();
  const { c, height: H } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const list = useRef<FlatList<Item>>(null);
  const [bandsH, setBandsH] = useState(0);
  const [docked, setDocked] = useState(false);
  // The list starts below the status bar; the bands behind it start at the very top.
  const gap = Math.max(0, (bandsH || H * 0.55) - 26 - insets.top);
  const y = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((e) => { y.value = e.contentOffset.y; });
  const data = useMemo<Item[]>(() => (ledger ? [{ kind: 'gap', key: 'gap' }, { kind: 'head', key: 'head' }, ...rows(ledger.records)] : []), [ledger]);
  // History mode switches as the header reaches the top: a state change, not per-frame movement.
  useAnimatedReaction(() => y.value >= gap - 1, (now, was) => { if (now !== was) runOnJS(setDocked)(now); }, [gap]);
  const touchCopy = useAnimatedStyle(() => ({ transform: [{ translateY: Math.max(y.value, -400) }] }));
  const corners = useAnimatedStyle(() => {
    const r = interpolate(y.value, [gap - 30, gap], [26, 0], Extrapolation.CLAMP);
    return { borderTopLeftRadius: r, borderTopRightRadius: r };
  });
  if (!h || !ledger) return null;
  const freshRecord = new Set(h.events.filter((e) => freshIds.has(e.id)).map((e) => ('recordId' in e ? e.recordId : '')));
  const search = () => { requestHistorySearch(true); router.push('/history'); };
  const bands = <Bands h={h} balances={ledger.balances} hide={hide} />;

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      {/* What you see. Screen readers use the copy in the list instead. */}
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden pointerEvents="none"
        ref={(node) => { if (isWeb && node) (node as unknown as HTMLElement).setAttribute('inert', ''); }}
        onLayout={(e) => setBandsH(e.nativeEvent.layout.height)}>
        {bands}
      </View>

      <Animated.FlatList
        ref={list}
        style={{ position: 'absolute', left: 0, right: 0, top: insets.top, bottom: 0 }}
        data={data}
        keyExtractor={(item) => item.key}
        stickyHeaderIndices={[1]}
        onScroll={onScroll}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
        initialNumToRender={16}
        windowSize={11}
        renderItem={({ item }) => {
          if (item.kind === 'gap') {
            return (
              <View style={{ height: gap }}>
                {/* Nearly, not fully, transparent: iOS ignores touches on views at or near zero opacity. */}
                <Animated.View style={[{ position: 'absolute', left: 0, right: 0, top: -insets.top, opacity: 0.02 }, touchCopy]}>{bands}</Animated.View>
              </View>
            );
          }
          if (item.kind === 'head') {
            return (
              <Animated.View style={[{ backgroundColor: c.bg, paddingHorizontal: 22, paddingTop: 14, overflow: 'hidden' }, corners]}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44, flexWrap: 'wrap', columnGap: 12 }}>
                  {docked ? (
                    <Press accessibilityRole="button" accessibilityLabel="Back to balances" onPress={() => { list.current?.scrollToOffset({ offset: 0, animated: true }); setDocked(false); }}
                      style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: -4 }}>
                      <ChevDown size={18} color={c.ink} />
                      <T style={{ fontSize: 16, fontFamily: fonts.medium }}>Balances</T>
                    </Press>
                  ) : (
                    <T accessibilityRole="header" style={{ fontFamily: fonts.bold, fontSize: 20 }}>Latest</T>
                  )}
                  {docked ? <T accessibilityRole="header" style={{ fontFamily: fonts.bold, fontSize: 17 }}>History</T> : null}
                  {ledger.records.length ? (
                    <Press accessibilityRole="button" accessibilityLabel="Search history" onPress={search} style={{ minHeight: 44, minWidth: docked ? 92 : undefined, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
                      <Search size={18} color={c.ink} />
                      {docked ? null : <T style={{ fontSize: 16, fontFamily: fonts.medium }}>Search</T>}
                    </Press>
                  ) : null}
                </View>
                <SyncLine />
              </Animated.View>
            );
          }
          return (
            <View style={{ backgroundColor: c.bg, paddingHorizontal: 22 }}>
              {item.kind === 'day' ? (
                <T style={{ fontFamily: fonts.semibold, fontSize: 13, color: c.ink2, paddingTop: 16, paddingBottom: 2 }}>{item.label}</T>
              ) : (
                <RecordRow h={h} r={item.r} hide={hide} fresh={freshRecord.has(item.r.id)} last={item.last}
                  onPress={() => openSheet({ type: 'detail', recordId: item.r.id })} />
              )}
            </View>
          );
        }}
        ListFooterComponent={(
          // Fills the rest of the screen, so a short history still covers the bands once docked.
          <View style={{ backgroundColor: c.bg, minHeight: H - insets.top - 120, paddingHorizontal: 22, paddingBottom: insets.bottom + 110 }}>
            {ledger.records.length ? (data.length > 14 ? <T style={{ fontSize: 13, color: c.ink3, textAlign: 'center', paddingTop: 22 }}>That’s everything in {h.name}</T> : null) : <EmptyState />}
            {/* Bouncing past the end shows more page, never the bands behind. */}
            {isWeb ? null : <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: '100%', height: H, backgroundColor: c.bg }} />}
          </View>
        )}
      />
      {docked ? <OrbButton size={64} plus={24} style={{ position: 'absolute', right: 18, bottom: insets.bottom + 18 }} /> : null}
    </View>
  );
}

function EmptyState() {
  const { c } = useTheme();
  const { h } = useHousehold();
  const router = useRouter();
  if (!h) return null;
  const invited = h.people.filter((p) => !p.joined && p.id !== h.youId);
  return (
    <View style={{ alignItems: 'center', paddingTop: 18, gap: 8 }}>
      <View style={{ width: 64, height: 64, borderRadius: 32, borderWidth: 2, borderStyle: 'dashed', borderColor: c.ink3, alignItems: 'center', justifyContent: 'center' }}>
        <T style={{ fontSize: 30, color: c.ink2 }}>+</T>
      </View>
      <T style={{ fontFamily: fonts.bold, fontSize: 20 }}>Nothing here yet</T>
      <T style={{ fontSize: 14, color: c.ink2, textAlign: 'center', maxWidth: 300 }}>{isWeb ? 'Press' : 'Tap'} the orb to add the first expense. {h.sync ? `Everyone in ${h.name} sees it straight away.` : 'It stays on this device until you share the household.'}</T>
      <View style={{ alignSelf: 'stretch', marginTop: 10, backgroundColor: c.card, borderRadius: 18 }}>
        <Press noScale onPress={() => router.push('/setup/opening')} accessibilityLabel="Already owe each other money? Add an opening balance"
          style={{ padding: 16, borderBottomWidth: invited.length ? 1 : 0, borderBottomColor: c.hair }}>
          <T style={{ fontSize: 16 }}>Already owe each other money?</T>
          <T style={{ fontSize: 13, color: c.ink2, marginTop: 2 }}>Add an opening balance</T>
        </Press>
        {invited.length ? (
          <Press noScale onPress={() => router.push('/setup/invite')} accessibilityLabel="Invite people" style={{ padding: 16 }}>
            <T style={{ fontSize: 16 }}>{invited.map((p) => p.name).join(', ')} {invited.length > 1 ? 'haven’t' : 'hasn’t'} joined yet</T>
            <T style={{ fontSize: 13, color: c.ink2, marginTop: 2 }}>{invited.some((p) => h.sync?.invites?.[p.id]?.issued) ? 'Send the invite again' : 'Invite them'}</T>
          </Press>
        ) : null}
      </View>
    </View>
  );
}

function DeskHome() {
  const { h, ledger, hide } = useHousehold();
  const { c, layout } = useTheme();
  const [selected, setSelected] = useState<string | null>(null);
  const sel = useMemo(() => (selected && ledger?.byId[selected] ? selected : null), [selected, ledger]);
  if (!h || !ledger) return null;
  return (
    <View style={{ flex: 1, backgroundColor: '#F1EFE8' }}>
      <WebTopBar />
      <View style={{ flex: 1, flexDirection: 'row' }}>
        <ScrollView style={{ width: layout === 'desk' ? 360 : 320, flexGrow: 0, backgroundColor: c.bg, borderRightWidth: 1, borderRightColor: c.hair }}>
          <Bands h={h} balances={ledger.balances} hide={hide} compact />
          <View style={{ padding: 24, gap: 6 }}>
            <MonthStats />
          </View>
        </ScrollView>
        <View style={{ flex: 1, minWidth: 0, backgroundColor: c.dark ? c.bg : '#F6F4EE', borderRightWidth: layout === 'desk' ? 1 : 0, borderRightColor: c.hair }}>
          <HistoryThread selectedId={sel} onSelect={(id) => (layout === 'desk' ? setSelected(id) : openSheet({ type: 'detail', recordId: id }))} desk />
        </View>
        {layout === 'desk' ? (
          <View style={{ width: 380, backgroundColor: c.bg }}>
            {sel ? <RecordDetail recordId={sel} variant="panel" onClose={() => setSelected(null)} /> : <DeskHint />}
          </View>
        ) : null}
      </View>
    </View>
  );
}

function DeskHint() {
  const { c } = useTheme();
  return (
    <View style={{ padding: 24, gap: 10 }}>
      <Check size={22} color={c.ink3} />
      <T style={{ fontFamily: fonts.bold, fontSize: 18 }}>Pick anything in the history</T>
      <T style={{ color: c.ink2, fontSize: 14 }}>Its whole story shows here: who added it, every edit with the old amount, voids with their reason, and who has seen it.</T>
      <T style={{ color: c.ink2, fontSize: 14, marginTop: 8 }}>Press N to add an expense, / to search, Esc to close.</T>
    </View>
  );
}

function MonthStats() {
  const { h, ledger, hide } = useHousehold();
  const { c } = useTheme();
  if (!h || !ledger) return null;
  const month = new Date().toISOString().slice(0, 7);
  const ex = ledger.records.filter((r) => r.kind === 'expense' && !r.voided && r.expense!.date.startsWith(month));
  const total = ex.reduce((a, r) => a + r.expense!.amount, 0);
  const byGroup = h.groups.map((g) => ({ g, sum: ex.filter((r) => h.people.find((p) => p.id === r.expense!.payerId)?.groupId === g.id).reduce((a, r) => a + r.expense!.amount, 0) }));
  return (
    <View>
      <T style={{ fontFamily: fonts.semibold, fontSize: 13, color: c.ink2, marginBottom: 8 }}>This month</T>
      <Stat label="Spent together" value={money(h, total, hide)} />
      {byGroup.map(({ g, sum }) => <Stat key={g.id} label={`${nameOf(h, g)} paid`} value={money(h, sum, hide)} />)}
    </View>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  const { c } = useTheme();
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.hair }}>
      <T style={{ fontSize: 15, color: c.ink2 }}>{label}</T>
      <T style={{ fontSize: 15, fontFamily: fonts.semibold, fontVariant: ['tabular-nums'] }}>{value}</T>
    </View>
  );
}

