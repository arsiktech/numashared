// Home. Phone: the household, the balance panels and the latest records in one list, with one add
// button. Tablet and desk: balance on the left, the history in the middle and, on the desk, this
// month's totals or the selected record on the right. Built only from the Home system in ui/scale.ts.
import { useEffect, useMemo, useState } from 'react';
import { FlatList, ScrollView, View } from 'react-native';
import { Redirect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { markSeen, useStore } from '@/store/store';
import { openSheet } from '@/store/ui';
import { ChevDown, Gear, People, Search } from '@/ui/icons';
import { Press, T } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { corner, figures, space, text } from '@/ui/scale';
import { isAndroid, isWeb } from '@/ui/tokens';
import { money, nameOf, useHousehold } from '@/features/hooks';
import { Bands, ORB } from '@/features/home/balance';
import { OrbButton, RecordRow } from '@/features/records';
import type { LedgerRecord } from '@/core/types';
import { dayLabel, sameDay } from '@/features/history/model';
import { requestHistorySearch } from '@/features/history/search';
import { SyncLine } from '@/features/home/syncline';
import { DayStamp } from '@/features/home/stamp';
import { DeskHistory } from '@/features/history/desk';
import { RecordDetail } from '@/features/detail/content';
import { WebTopBar } from '@/features/web/topbar';

export default function Home() {
  const { h, ledger } = useHousehold();
  const { layout } = useTheme();
  const recent = useStore((s) => s.recent);
  useEffect(() => {
    if (h) markSeen(h.id, h.events.map((e) => e.id));
  }, [h]);
  if (!h || !ledger) return <Redirect href="/welcome" />;
  if (layout === 'desk' || layout === 'tablet') return <DeskHome />;
  return <PhoneHome freshIds={new Set(recent.filter((r) => Date.now() - r.at < 8000).map((r) => r.eventId))} />;
}

type Row = { kind: 'day'; key: string; label: string } | { kind: 'record'; key: string; r: LedgerRecord };

/** Every record, newest first, with a heading for each day. */
function rows(records: LedgerRecord[]): Row[] {
  const sorted = [...records].sort((a, b) => b.updatedAt - a.updatedAt);
  const out: Row[] = [];
  sorted.forEach((r, i) => {
    if (i === 0 || !sameDay(sorted[i - 1].updatedAt, r.updatedAt)) out.push({ kind: 'day', key: `d${r.updatedAt}`, label: dayLabel(r.updatedAt) });
    out.push({ kind: 'record', key: r.id, r });
  });
  return out;
}

type Item = { kind: 'bands'; key: string } | { kind: 'head'; key: string } | { kind: 'sync'; key: string } | Row;

/** The docked orb in the "Latest" header, shown once the orb on the seam has scrolled away. */
const DOCKED_ORB = 40;

function PhoneHome({ freshIds }: { freshIds: Set<string> }) {
  const { h, ledger, hide } = useHousehold();
  const { ui } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [seam, setSeam] = useState(0);
  const [docked, setDocked] = useState(false);
  const data = useMemo<Item[]>(() => (ledger ? [{ kind: 'bands', key: 'bands' }, { kind: 'head', key: 'head' }, { kind: 'sync', key: 'sync' }, ...rows(ledger.records)] : []), [ledger]);
  if (!h || !ledger) return null;
  const freshRecord = new Set(h.events.filter((e) => freshIds.has(e.id)).map((e) => ('recordId' in e ? e.recordId : '')));
  const search = () => { requestHistorySearch(true); router.push('/history'); };
  const header = (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space[2], paddingTop: space[2] }}>
      <Press accessibilityLabel={`Household: ${h.name}. Switch`} onPress={() => openSheet({ type: 'households' })}
        style={{ minHeight: 44, flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: space[1] }}>
        <T style={[text.title, { flexShrink: 1, color: ui.onFill }]}>{h.name}</T>
        <ChevDown size={16} color={ui.onFill} />
      </Press>
      <Press accessibilityLabel="Household settings" onPress={() => router.push('/settings')}
        style={{ width: 44, height: 44, borderRadius: 22, borderWidth: 1, borderColor: ui.onFill, alignItems: 'center', justifyContent: 'center' }}>
        {isAndroid ? <Gear size={22} color={ui.onFill} /> : <People size={22} color={ui.onFill} />}
      </Press>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: ui.canvas }}>
      <FlatList
        data={data}
        keyExtractor={(item) => item.key}
        stickyHeaderIndices={[1]}
        showsVerticalScrollIndicator={false}
        initialNumToRender={16}
        scrollEventThrottle={32}
        // The orb on the seam is the add button until it scrolls under the sticky header.
        onScroll={(e) => { const now = seam > 0 && e.nativeEvent.contentOffset.y > seam + ORB / 2; if (now !== docked) setDocked(now); }}
        contentContainerStyle={{ paddingBottom: insets.bottom + space[6] }}
        renderItem={({ item }) => {
          if (item.kind === 'bands') return <Bands h={h} balances={ledger.balances} hide={hide} repay top={insets.top} header={header} onSeam={setSeam} />;
          if (item.kind === 'head') {
            return (
              <View style={{ backgroundColor: ui.canvas, paddingHorizontal: space[4], paddingTop: docked ? insets.top + space[2] : space[4],
                borderBottomWidth: docked ? 1 : 0, borderBottomColor: ui.line }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 44, gap: space[3] }}>
                  <T accessibilityRole="header" style={[text.heading, { flex: 1 }]}>Latest</T>
                  {ledger.records.length ? (
                    <Press accessibilityLabel="Search history" onPress={search} style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
                      <Search size={18} color={ui.ink} />
                      <T style={text.strong}>Search</T>
                    </Press>
                  ) : null}
                  {docked ? <OrbButton size={DOCKED_ORB} plus={18} /> : null}
                </View>
              </View>
            );
          }
          if (item.kind === 'sync') return <View style={{ paddingHorizontal: space[4] }}><SyncLine /></View>;
          return (
            <View style={{ paddingHorizontal: space[4] }}>
              {item.kind === 'day' ? (
                <DayStamp label={item.label} />
              ) : (
                <RecordRow h={h} r={item.r} hide={hide} day={item.r.updatedAt} fresh={freshRecord.has(item.r.id)}
                  onPress={() => openSheet({ type: 'detail', recordId: item.r.id })} />
              )}
            </View>
          );
        }}
        ListFooterComponent={(
          <View style={{ paddingHorizontal: space[4] }}>
            {ledger.records.length ? (data.length > 16 ? <T style={[text.meta, { color: ui.muted, textAlign: 'center', paddingTop: space[5] }]}>That’s everything in {h.name}</T> : null) : <EmptyState />}
          </View>
        )}
      />
    </View>
  );
}

function EmptyState() {
  const { ui } = useTheme();
  const { h } = useHousehold();
  const router = useRouter();
  if (!h) return null;
  const invited = h.people.filter((p) => !p.joined && p.id !== h.youId);
  const actions = [
    { key: 'opening', title: 'Already owe each other money?', sub: 'Add an opening balance', go: () => router.push('/setup/opening'), a11y: 'Already owe each other money? Add an opening balance' },
    ...(invited.length ? [{
      key: 'invite',
      title: `${invited.map((p) => p.name).join(', ')} ${invited.length > 1 ? 'haven’t' : 'hasn’t'} joined yet`,
      sub: invited.some((p) => h.sync?.invites?.[p.id]?.issued) ? 'Send the invite again' : 'Invite them',
      go: () => router.push('/setup/invite'), a11y: 'Invite people',
    }] : []),
  ];
  return (
    <View style={{ paddingTop: space[4], gap: space[4] }}>
      <View style={{ gap: space[1] }}>
        <T style={text.title}>Nothing here yet</T>
        <T style={[text.body, { color: ui.muted }]}>{isWeb ? 'Press' : 'Tap'} the orb to add the first expense. {h.sync ? `Everyone in ${h.name} sees it straight away.` : 'It stays on this device until you share the household.'}</T>
      </View>
      <View style={{ borderRadius: corner, borderWidth: 1, borderColor: ui.line }}>
        {actions.map((a, i) => (
          <Press key={a.key} noScale onPress={a.go} accessibilityLabel={a.a11y}
            style={{ padding: space[4], borderTopWidth: i ? 1 : 0, borderTopColor: ui.line }}>
            <T style={text.strong}>{a.title}</T>
            <T style={[text.meta, { color: ui.muted }]}>{a.sub}</T>
          </Press>
        ))}
      </View>
    </View>
  );
}

function DeskHome() {
  const { h, ledger, hide } = useHousehold();
  const { ui, layout } = useTheme();
  const [selected, setSelected] = useState<string | null>(null);
  const sel = useMemo(() => (selected && ledger?.byId[selected] ? selected : null), [selected, ledger]);
  if (!h || !ledger) return null;
  const desk = layout === 'desk';
  return (
    <View style={{ flex: 1, backgroundColor: ui.canvas }}>
      <WebTopBar />
      <View style={{ flex: 1, flexDirection: 'row' }}>
        <ScrollView style={{ width: desk ? 360 : 320, flexGrow: 0, borderRightWidth: 1, borderRightColor: ui.line }}>
          <Bands h={h} balances={ledger.balances} hide={hide} repay={false} />
          {desk ? null : <View style={{ padding: space[5] }}><MonthStats /></View>}
        </ScrollView>
        <View style={{ flex: 1, minWidth: 0 }}>
          <DeskHistory selectedId={sel} onSelect={(id) => (desk ? setSelected(id) : openSheet({ type: 'detail', recordId: id }))} />
        </View>
        {desk ? (
          <View style={{ width: 380, borderLeftWidth: 1, borderLeftColor: ui.line }}>
            {sel ? <RecordDetail recordId={sel} variant="panel" onClose={() => setSelected(null)} /> : (
              <ScrollView contentContainerStyle={{ padding: space[5] }}><MonthStats /></ScrollView>
            )}
          </View>
        ) : null}
      </View>
    </View>
  );
}

function MonthStats() {
  const { h, ledger, hide } = useHousehold();
  const { ui } = useTheme();
  if (!h || !ledger) return null;
  const month = new Date().toISOString().slice(0, 7);
  const ex = ledger.records.filter((r) => r.kind === 'expense' && !r.voided && r.expense!.date.startsWith(month));
  const total = ex.reduce((a, r) => a + r.expense!.amount, 0);
  const byGroup = h.groups.map((g) => ({ g, sum: ex.filter((r) => h.people.find((p) => p.id === r.expense!.payerId)?.groupId === g.id).reduce((a, r) => a + r.expense!.amount, 0) }));
  const stats = [{ key: 'all', label: 'Spent together', value: total }, ...byGroup.map(({ g, sum }) => ({ key: g.id, label: `${nameOf(h, g)} paid`, value: sum }))];
  return (
    <View>
      <T accessibilityRole="header" style={[text.heading, { paddingBottom: space[3] }]}>This month</T>
      {stats.map((s) => (
        <View key={s.key} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: space[3], paddingVertical: space[3], borderTopWidth: 1, borderTopColor: ui.line }}>
          <T style={[text.body, { color: ui.muted, flexShrink: 1 }]}>{s.label}</T>
          <T style={[text.strong, figures]}>{money(h, s.value, hide)}</T>
        </View>
      ))}
    </View>
  );
}
