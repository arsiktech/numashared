// Home. Phone: bands, ticket and orb, then the latest records. Desk: three panes, balance on the
// left, the history thread in the middle and the selected record on the right.
import { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { Extrapolation, interpolate, runOnJS, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { Redirect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { markSeen, useStore } from '@/store/store';
import { openSheet } from '@/store/ui';
import { Check, ChevUp, Search } from '@/ui/icons';
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

// The bands stay put. The list below is one endless history that slides up over them; once its top
// reaches the status bar it becomes History, with a bar to get back and a small orb to keep adding.
function PhoneHome({ freshIds }: { freshIds: Set<string> }) {
  const { h, ledger, hide } = useHousehold();
  const { c, height: H } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const list = useRef<FlatList<Row>>(null);
  const y = useSharedValue(0);
  const [bandsH, setBandsH] = useState(0);
  const [docked, setDocked] = useState(false);
  const dockedSV = useSharedValue(false);
  const dock = Math.max(1, bandsH - 26 - insets.top);
  const data = useMemo(() => (ledger ? rows(ledger.records) : []), [ledger]);
  const onScroll = useAnimatedScrollHandler((e) => {
    y.value = e.contentOffset.y;
    const now = e.contentOffset.y >= dock - 4;
    if (now !== dockedSV.value) { dockedSV.value = now; runOnJS(setDocked)(now); }
  });
  // Counter-scroll the bands so they never move, even when the list is pulled down past its top.
  // Once the list has docked they are covered, so they stop there and scroll away.
  const pinned = useAnimatedStyle(() => ({ transform: [{ translateY: Math.min(y.value, dock) }] }));
  const bar = useAnimatedStyle(() => ({ opacity: interpolate(y.value, [dock - 36, dock], [0, 1], Extrapolation.CLAMP) }));
  const fold = useAnimatedStyle(() => ({ opacity: interpolate(y.value, [dock - 36, dock - 6], [1, 0], Extrapolation.CLAMP) }));
  if (!h || !ledger) return null;
  const freshRecord = new Set(h.events.filter((e) => freshIds.has(e.id)).map((e) => ('recordId' in e ? e.recordId : '')));
  const search = () => { requestHistorySearch(true); router.push('/history'); };

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <Animated.FlatList
        ref={list}
        data={data}
        keyExtractor={(row) => row.key}
        onScroll={onScroll}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={docked}
        initialNumToRender={14}
        windowSize={11}
        contentContainerStyle={{ flexGrow: 1 }}
        ListHeaderComponent={(
          <>
            <Animated.View style={pinned} onLayout={(e) => setBandsH(e.nativeEvent.layout.height)}>
              <Bands h={h} balances={ledger.balances} hide={hide} tail={isWeb ? undefined : H} />
            </Animated.View>
            <Animated.View style={[{ marginTop: -26, backgroundColor: c.bg, borderTopLeftRadius: 26, borderTopRightRadius: 26, paddingHorizontal: 22, paddingTop: 14 }]}>
              <Animated.View style={[{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 44 }, fold]}>
                <T accessibilityRole="header" style={{ fontFamily: fonts.bold, fontSize: 20 }}>Latest</T>
                {ledger.records.length ? (
                  <Press accessibilityRole="button" accessibilityLabel="Search history" onPress={search} style={{ height: 44, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Search size={18} color={c.ink} />
                    <T style={{ fontSize: 16, fontFamily: fonts.medium }}>Search</T>
                  </Press>
                ) : null}
              </Animated.View>
              <SyncLine />
            </Animated.View>
          </>
        )}
        renderItem={({ item }) => (
          <View style={{ backgroundColor: c.bg, paddingHorizontal: 22 }}>
            {item.kind === 'day' ? (
              <T style={{ fontFamily: fonts.semibold, fontSize: 13, color: c.ink2, paddingTop: 16, paddingBottom: 2 }}>{item.label}</T>
            ) : (
              <RecordRow h={h} r={item.r} hide={hide} fresh={freshRecord.has(item.r.id)} last={item.last}
                onPress={() => openSheet({ type: 'detail', recordId: item.r.id })} />
            )}
          </View>
        )}
        ListEmptyComponent={<View style={{ backgroundColor: c.bg, paddingHorizontal: 22 }}><EmptyState /></View>}
        ListFooterComponentStyle={{ flexGrow: 1, backgroundColor: c.bg }}
        ListFooterComponent={(
          <View style={{ flexGrow: 1, minHeight: insets.bottom + 120, alignItems: 'center', paddingTop: 22 }}>
            {data.length > 12 ? <T style={{ fontSize: 13, color: c.ink3 }}>That’s everything in {h.name}</T> : null}
            {/* A floor, so pulling past the end never shows the bands behind the list. */}
            {isWeb ? null : <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: '100%', height: H, backgroundColor: c.bg }} />}
          </View>
        )}
      />

      {/* History bar: appears as the list reaches the top. */}
      <Animated.View pointerEvents={docked ? 'box-none' : 'none'} style={[StyleSheet.absoluteFill, bar]}>
        <View style={{ paddingTop: insets.top, backgroundColor: c.bg, borderBottomWidth: 1, borderBottomColor: c.hair }}>
          <View style={{ height: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12 }}>
            <Press accessibilityRole="button" accessibilityLabel="Back to balances" onPress={() => list.current?.scrollToOffset({ offset: 0, animated: true })}
              style={{ height: 44, minWidth: 44, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8 }}>
              <ChevUp size={18} color={c.ink} />
              <T style={{ fontSize: 16, fontFamily: fonts.medium }}>Balances</T>
            </Press>
            <T accessibilityRole="header" style={{ fontFamily: fonts.bold, fontSize: 17 }}>History</T>
            <Press accessibilityRole="button" accessibilityLabel="Search history" onPress={search}
              style={{ height: 44, minWidth: 92, alignItems: 'flex-end', justifyContent: 'center', paddingHorizontal: 8 }}>
              <Search size={20} color={c.ink} />
            </Press>
          </View>
        </View>
        {docked ? <OrbButton size={64} plus={24} style={{ position: 'absolute', right: 18, bottom: insets.bottom + 18 }} /> : null}
      </Animated.View>
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

