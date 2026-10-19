// Home. Phone: bands, ticket and orb, then the latest records. Desk: three panes, balance on the
// left, the history thread in the middle and the selected record on the right.
import { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, ScrollView, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { Extrapolation, interpolate, runOnJS, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { Redirect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { markSeen, useStore } from '@/store/store';
import { openSheet } from '@/store/ui';
import { Check, ChevDown, Search } from '@/ui/icons';
import { Press, T } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { fonts } from '@/ui/tokens';
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

// The bands never move. The history is a card over them, like a sheet in Maps: drag it up and it
// snaps to the top as History (its list then scrolls); pull the list down from its top, or tap
// Balances, and it settles back over the bands. The card moves with the finger, so nothing chases
// the scroll position frame by frame.
function PhoneHome({ freshIds }: { freshIds: Set<string> }) {
  const { h, ledger, hide } = useHousehold();
  const { c, height: H } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const list = useRef<FlatList<Row>>(null);
  const [bandsH, setBandsH] = useState(0);
  const [docked, setDocked] = useState(false);
  // The card's offset from its docked place (just below the status bar). Resting: over the bands.
  const rest = Math.max(0, (bandsH || H * 0.55) - 26 - insets.top);
  const t = useSharedValue(rest);
  const restSV = useSharedValue(rest);
  const scrollY = useSharedValue(0);
  const start = useSharedValue(0);
  const base = useSharedValue(-1);
  const dockedRef = useRef(false);
  dockedRef.current = docked;
  useEffect(() => {
    // Follow the bands' height (it changes with names and balances) while resting.
    restSV.value = rest;
    if (!dockedRef.current) t.value = rest;
  }, [rest, restSV, t]);
  const data = useMemo(() => (ledger ? rows(ledger.records) : []), [ledger]);

  const settle = (to: 'top' | 'rest') => {
    'worklet';
    const target = to === 'top' ? 0 : restSV.value;
    t.value = withSpring(target, { damping: 26, stiffness: 240, overshootClamping: true });
    runOnJS(setDocked)(to === 'top');
  };
  const settleNow = (to: 'top' | 'rest') => {
    t.value = withSpring(to === 'top' ? 0 : restSV.value, { damping: 26, stiffness: 240, overshootClamping: true });
    setDocked(to === 'top');
  };
  const native = useMemo(() => Gesture.Native(), []);
  const pan = useMemo(() => Gesture.Pan()
    .activeOffsetY([-8, 8])
    .failOffsetX([-16, 16])
    .simultaneousWithExternalGesture(native)
    .onBegin(() => { start.value = t.value; base.value = -1; })
    .onUpdate((e) => {
      // Docked with the list scrolled, or dragging up while docked: the list scrolls instead.
      if (start.value <= 0.5 && (scrollY.value > 0.5 || e.translationY < 0)) { base.value = -1; return; }
      if (base.value < 0) base.value = e.translationY;
      const next = start.value + e.translationY - base.value;
      const over = next - restSV.value;
      t.value = over > 0 ? restSV.value + over * 0.25 : Math.max(0, next);
    })
    .onEnd((e) => {
      if (base.value < 0) return;
      const fling = e.velocityY < -600 ? 'top' : e.velocityY > 600 ? 'rest' : null;
      settle(fling ?? (t.value < restSV.value / 2 ? 'top' : 'rest'));
    }), [native, start, base, t, scrollY, restSV]);

  const card = useAnimatedStyle(() => ({ transform: [{ translateY: t.value }] }));
  const cap = useAnimatedStyle(() => ({ opacity: interpolate(t.value, [36, 0], [0, 1], Extrapolation.CLAMP) }));
  const corners = useAnimatedStyle(() => {
    const r = interpolate(t.value, [36, 0], [26, 0], Extrapolation.CLAMP);
    return { borderTopLeftRadius: r, borderTopRightRadius: r };
  });
  if (!h || !ledger) return null;
  const freshRecord = new Set(h.events.filter((e) => freshIds.has(e.id)).map((e) => ('recordId' in e ? e.recordId : '')));
  const search = () => { requestHistorySearch(true); router.push('/history'); };
  const back = () => { list.current?.scrollToOffset({ offset: 0, animated: false }); scrollY.value = 0; settleNow('rest'); };

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <View onLayout={(e) => setBandsH(e.nativeEvent.layout.height)}>
        <Bands h={h} balances={ledger.balances} hide={hide} />
      </View>

      <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
        {/* Behind the status bar once docked, so rows never show through it. */}
        <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 0, right: 0, top: 0, height: insets.top, backgroundColor: c.bg }, cap]} />
        <GestureDetector gesture={pan}>
          <Animated.View style={[{ position: 'absolute', left: 0, right: 0, top: insets.top, height: H - insets.top, backgroundColor: c.bg, overflow: 'hidden' }, corners, card]}>
            <View style={{ paddingHorizontal: 22, paddingTop: 14 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 44 }}>
                {docked ? (
                  <Press accessibilityRole="button" accessibilityLabel="Back to balances" onPress={back}
                    style={{ height: 44, flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: -4 }}>
                    <ChevDown size={18} color={c.ink} />
                    <T style={{ fontSize: 16, fontFamily: fonts.medium }}>Balances</T>
                  </Press>
                ) : (
                  <Press noScale accessibilityRole="button" accessibilityLabel="Latest. Open the whole history" onPress={() => settleNow('top')} style={{ height: 44, justifyContent: 'center' }}>
                    <T accessibilityRole="header" style={{ fontFamily: fonts.bold, fontSize: 20 }}>Latest</T>
                  </Press>
                )}
                {docked ? <T accessibilityRole="header" style={{ fontFamily: fonts.bold, fontSize: 17 }}>History</T> : null}
                {ledger.records.length ? (
                  <Press accessibilityRole="button" accessibilityLabel="Search history" onPress={search} style={{ height: 44, minWidth: docked ? 92 : undefined, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
                    <Search size={18} color={c.ink} />
                    {docked ? null : <T style={{ fontSize: 16, fontFamily: fonts.medium }}>Search</T>}
                  </Press>
                ) : null}
              </View>
              <SyncLine />
            </View>
            <GestureDetector gesture={native}>
              <FlatList
                ref={list}
                data={data}
                keyExtractor={(row) => row.key}
                scrollEnabled={docked}
                bounces={false}
                onScroll={(e) => { scrollY.value = e.nativeEvent.contentOffset.y; }}
                scrollEventThrottle={16}
                showsVerticalScrollIndicator={docked}
                initialNumToRender={14}
                windowSize={11}
                contentContainerStyle={{ paddingHorizontal: 22, paddingBottom: insets.bottom + 110 }}
                renderItem={({ item }) => (item.kind === 'day' ? (
                  <T style={{ fontFamily: fonts.semibold, fontSize: 13, color: c.ink2, paddingTop: 16, paddingBottom: 2 }}>{item.label}</T>
                ) : (
                  <RecordRow h={h} r={item.r} hide={hide} fresh={freshRecord.has(item.r.id)} last={item.last}
                    onPress={() => openSheet({ type: 'detail', recordId: item.r.id })} />
                ))}
                ListEmptyComponent={<EmptyState />}
                ListFooterComponent={data.length > 12 ? (
                  <T style={{ fontSize: 13, color: c.ink3, textAlign: 'center', paddingTop: 22 }}>That’s everything in {h.name}</T>
                ) : null}
              />
            </GestureDetector>
          </Animated.View>
        </GestureDetector>
        {docked ? <OrbButton size={64} plus={24} style={{ position: 'absolute', right: 18, bottom: insets.bottom + 18 }} /> : null}
      </View>
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
      <T style={{ fontSize: 14, color: c.ink2, textAlign: 'center', maxWidth: 300 }}>Tap the orb to add the first expense. Everyone in {h.name} sees it straight away.</T>
      <View style={{ alignSelf: 'stretch', marginTop: 10, backgroundColor: c.card, borderRadius: 18 }}>
        <Press noScale onPress={() => router.push('/setup/opening')} accessibilityLabel="Already owe each other money? Add an opening balance"
          style={{ padding: 16, borderBottomWidth: invited.length ? 1 : 0, borderBottomColor: c.hair }}>
          <T style={{ fontSize: 16 }}>Already owe each other money?</T>
          <T style={{ fontSize: 13, color: c.ink2, marginTop: 2 }}>Add an opening balance</T>
        </Press>
        {invited.length ? (
          <Press noScale onPress={() => router.push('/setup/invite')} accessibilityLabel="Invite people" style={{ padding: 16 }}>
            <T style={{ fontSize: 16 }}>{invited.map((p) => p.name).join(', ')} {invited.length > 1 ? 'haven’t' : 'hasn’t'} joined yet</T>
            <T style={{ fontSize: 13, color: c.ink2, marginTop: 2 }}>Send the invite again</T>
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

