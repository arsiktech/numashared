// Home. Phone: bands, ticket and orb, then the latest records. Desk: three panes, balance on the
// left, the history thread in the middle and the selected record on the right.
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Redirect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { markSeen, useStore } from '@/store/store';
import { openSheet } from '@/store/ui';
import { Check } from '@/ui/icons';
import { Press, T } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { fonts } from '@/ui/tokens';
import { money, nameOf, useHousehold } from '@/features/hooks';
import { Bands } from '@/features/home/bands';
import { RecordRow } from '@/features/records';
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

function PhoneHome({ freshIds }: { freshIds: Set<string> }) {
  const { h, ledger, hide } = useHousehold();
  const { c } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  if (!h || !ledger) return null;
  const latest = [...ledger.records].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6);
  const freshRecord = new Set(h.events.filter((e) => freshIds.has(e.id)).map((e) => ('recordId' in e ? e.recordId : '')));
  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={{ paddingBottom: insets.bottom + 90 }} showsVerticalScrollIndicator={false}>
      <Bands h={h} balances={ledger.balances} hide={hide} />
      <View style={{ marginTop: -26, backgroundColor: c.bg, borderTopLeftRadius: 26, borderTopRightRadius: 26, paddingHorizontal: 22, paddingTop: 14 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 44 }}>
          <T accessibilityRole="header" style={{ fontFamily: fonts.bold, fontSize: 20 }}>Latest</T>
          {ledger.records.length ? (
            <Press accessibilityRole="link" accessibilityLabel="All history" onPress={() => router.push('/history')} style={{ height: 44, justifyContent: 'center' }}>
              <T style={{ fontSize: 16, fontFamily: fonts.medium }}>All history</T>
            </Press>
          ) : null}
        </View>
        <SyncLine />
        {latest.length ? latest.map((r, i) => (
          <RecordRow key={r.id} h={h} r={r} hide={hide} fresh={freshRecord.has(r.id)} last={i === latest.length - 1}
            onPress={() => openSheet({ type: 'detail', recordId: r.id })} />
        )) : <EmptyState />}
      </View>
    </ScrollView>
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

