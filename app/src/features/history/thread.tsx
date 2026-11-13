// The phone history: a conversation of bubbles in the payer group's color, repayment cards and
// centered system lines for openings, edits and voids. Newest at the bottom, with a compose bar.
// The filters, search field and empty state are shared with the desk history (desk.tsx).
import { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, TextInput, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Household, ID, LedgerRecord } from '@/core/types';
import { groupOfPerson } from '@/store/store';
import { openSheet } from '@/store/ui';
import { ArrowBack, Back, CategoryIcon, Check, Checks, Close, Search } from '@/ui/icons';
import { Avatar, Press, T } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { alpha, fonts, isAndroid, isWeb } from '@/ui/tokens';
import { space, text } from '@/ui/scale';
import { OrbButton } from '../records';
import { addedByLine, authorName, clock, effectLine, initials, money, personName, recordTitle, settlementTitle, useHousehold } from '../hooks';
import {
  dayLabel, FILTERS, isMine, METHOD_LABEL, openingLine, sameDay, seenBy, splitLabel, threadItems,
  type Filter, type ThreadItem,
} from './model';
import { closeHistorySearch, onHistorySearchX, setHistoryQuery, useHistoryQuery, useHistorySearchOpen } from './search';

export function HistoryThread({ onSelect }: { onSelect: (id: ID) => void }) {
  const { h, ledger, hide } = useHousehold();
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const [filter, setFilter] = useState<Filter>('all');
  const query = useHistoryQuery();
  const items = useMemo(() => (h && ledger ? threadItems(h, ledger.records, filter, query, hide) : []), [h, ledger, filter, query, hide]);

  // Keep the newest item in view unless the reader has scrolled up.
  const scroller = useRef<ScrollView>(null);
  const stick = useRef(true);
  useEffect(() => { stick.current = true; }, [filter, query]);
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    stick.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 48;
  };

  if (!h || !ledger) return null;
  const empty = ledger.records.length === 0;

  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <PhoneHeader h={h} filter={filter} setFilter={setFilter} query={query} />
      <ScrollView ref={scroller} style={{ flex: 1 }} onScroll={onScroll} scrollEventThrottle={32}
        onContentSizeChange={() => { if (stick.current) scroller.current?.scrollToEnd({ animated: false }); }}
        contentContainerStyle={{ flexGrow: 1, justifyContent: 'flex-end', paddingHorizontal: 12, paddingTop: 8, paddingBottom: 12 }}>
        <View accessibilityRole={isWeb ? ('list' as never) : undefined} style={{ gap: 4, width: '100%' }}>
          {items.length ? items.map((it, i) => (
            <View key={it.key} style={{ gap: 4 }}>
              {i === 0 || !sameDay(items[i - 1].at, it.at) ? <DaySeparator at={it.at} /> : null}
              <Item h={h} it={it} hide={hide} onSelect={onSelect} />
            </View>
          )) : <EmptyThread empty={empty} query={query} filter={filter} shared={!!h?.sync} />}
        </View>
      </ScrollView>
      <Compose bottom={Math.max(insets.bottom - 4, 10)} />
    </View>
  );
}

// ---------- headers ----------

export function Filters({ filter, setFilter, compact }: { filter: Filter; setFilter: (f: Filter) => void; compact?: boolean }) {
  const { ui } = useTheme();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: space[2] }}
      accessibilityRole={isWeb ? ('tablist' as never) : undefined}>
      {FILTERS.map((f) => {
        const on = f.id === filter;
        return (
          <Press key={f.id} onPress={() => setFilter(f.id)} accessibilityRole={isWeb ? ('tab' as never) : 'button'} accessibilityState={{ selected: on }}
            accessibilityLabel={`Show ${f.label.toLowerCase()}`}
            style={{ height: 44, justifyContent: 'center' }}>
            <View style={{ height: space[6], borderRadius: space[4], paddingHorizontal: compact ? space[3] : space[4], flexDirection: 'row', alignItems: 'center', gap: space[1],
              backgroundColor: on ? ui.ink : ui.wash }}>
              {on && isAndroid ? <Check size={16} color={ui.canvas} /> : null}
              <T style={[compact ? text.meta : text.strong, { fontFamily: fonts.semibold, color: on ? ui.canvas : ui.ink }]}>{f.label}</T>
            </View>
          </Press>
        );
      })}
    </ScrollView>
  );
}

export function SearchField({ query, onDone, autoFocus }: { query: string; onDone?: () => void; autoFocus?: boolean }) {
  const { ui } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2], height: 44, borderRadius: 22, backgroundColor: ui.canvas, borderWidth: 1, borderColor: ui.line, paddingLeft: space[3], flex: 1 }}>
      <Search size={18} color={ui.muted} />
      <TextInput value={query} onChangeText={setHistoryQuery} autoFocus={autoFocus} placeholder="Search history" placeholderTextColor={ui.muted}
        accessibilityLabel="Search history" returnKeyType="search" autoCorrect={false}
        style={[text.body, { flex: 1, minWidth: 0, height: 42, color: ui.ink, outlineStyle: 'none' }] as never} />
      {onDone || query ? (
        <Press accessibilityLabel="Close search" onPress={() => onHistorySearchX(query, () => onDone?.())}
          style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
          <Close size={18} color={ui.muted} />
        </Press>
      ) : null}
    </View>
  );
}

function PhoneHeader({ h, filter, setFilter, query }: { h: Household; filter: Filter; setFilter: (f: Filter) => void; query: string }) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const searchOpen = useHistorySearchOpen();
  const [searching, setSearching] = useState(!!query || searchOpen);
  const back = () => (router.canGoBack() ? router.back() : router.replace('/home'));
  const closeSearch = () => { closeHistorySearch(); setSearching(false); };

  if (isAndroid) {
    return (
      <View style={{ paddingTop: insets.top, backgroundColor: c.bg, borderBottomWidth: 1, borderBottomColor: c.hair }}>
        <View style={{ height: 64, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 4 }}>
          <Press accessibilityLabel="Back" onPress={back} style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center' }}>
            <ArrowBack size={24} color={c.ink} />
          </Press>
          {searching ? <SearchField query={query} onDone={closeSearch} autoFocus /> : (
            <T accessibilityRole="header" style={{ flex: 1, fontFamily: fonts.semibold, fontSize: 22, paddingLeft: 8 }}>History</T>
          )}
          {!searching ? (
            <Press accessibilityLabel="Search history" onPress={() => setSearching(true)} style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center' }}>
              <Search size={22} color={c.ink} />
            </Press>
          ) : null}
        </View>
        <T style={{ fontSize: 14, color: c.ink2, lineHeight: 19, paddingHorizontal: 16 }}>Every expense, edit, void and repayment, in order. Nothing is ever deleted.</T>
        <View style={{ paddingHorizontal: 16, paddingVertical: 6 }}><Filters filter={filter} setFilter={setFilter} /></View>
      </View>
    );
  }

  return (
    <View style={{ paddingTop: insets.top + (isWeb ? 8 : 0), paddingHorizontal: 20, paddingBottom: 4, backgroundColor: c.bg, borderBottomWidth: 1, borderBottomColor: c.hair }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginLeft: -6, marginRight: -10, gap: 8 }}>
        {searching ? <SearchField query={query} onDone={closeSearch} autoFocus /> : (
          <Press accessibilityRole="link" accessibilityLabel={`Back to ${h.name}`} onPress={back}
            style={{ height: 44, flexDirection: 'row', alignItems: 'center', gap: 4, paddingRight: 6 }}>
            <Back size={22} color={c.ink} />
            <T style={{ fontSize: 17 }}>{h.name}</T>
          </Press>
        )}
        {searching ? (
          <Press accessibilityLabel="Cancel search" onPress={closeSearch} style={{ height: 44, justifyContent: 'center', paddingHorizontal: 6 }}>
            <T style={{ fontSize: 17 }}>Cancel</T>
          </Press>
        ) : (
          <Press accessibilityLabel="Search history" onPress={() => setSearching(true)} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
            <Search size={22} color={c.ink} />
          </Press>
        )}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <T accessibilityRole="header" style={{ fontFamily: fonts.cond, fontSize: 40, lineHeight: 44, letterSpacing: -0.4 }}>History</T>
        <T style={{ fontFamily: fonts.semibold, fontSize: 12.5, color: c.ink2 }}>Nothing is ever deleted</T>
      </View>
      <View style={{ marginTop: 2 }}><Filters filter={filter} setFilter={setFilter} compact /></View>
    </View>
  );
}

// ---------- items ----------

function DaySeparator({ at }: { at: number }) {
  const { c } = useTheme();
  return (
    <T accessibilityRole="header" style={{ alignSelf: 'center', fontFamily: fonts.bold, fontSize: 12.5, color: c.ink2, paddingTop: 8, paddingBottom: 2 }}>{dayLabel(at)}</T>
  );
}

function Item({ h, it, hide, onSelect }: { h: Household; it: ThreadItem; hide: boolean; onSelect: (id: ID) => void }) {
  switch (it.kind) {
    case 'expense': return <Bubble h={h} r={it.record} hide={hide} onSelect={onSelect} />;
    case 'repayment': return <RepayCard h={h} r={it.record} hide={hide} onSelect={onSelect} />;
    case 'opening': return <SystemLine line={openingLine(h, it.record, hide)} onPress={() => onSelect(it.record.id)} />;
    case 'change': return <SystemLine line={it.text} onPress={() => onSelect(it.record.id)} />;
  }
}

function Bubble({ h, r, hide, onSelect }: { h: Household; r: LedgerRecord; hide: boolean; onSelect: (id: ID) => void }) {
  const { c, tone } = useTheme();
  const e = r.expense!;
  const mine = isMine(h, r);
  const t = tone(groupOfPerson(h, e.payerId));
  const title = recordTitle(r);
  const edited = r.revisions.length > 1;
  const effect = hide ? null : effectLine(h, r);
  const seen = r.createdBy === h.youId ? seenBy(h, r) : null;
  const added = addedByLine(h, r, e.payerId);
  const foot = `${personName(h, e.payerId)} · ${clock(r.createdAt)}${added}${edited && !r.voided ? ' · edited' : ''}${r.voided ? ' · voided' : ''}${seen ? ` · Seen by ${seen}` : ''}`;
  const strike = r.voided ? ({ textDecorationLine: 'line-through' } as const) : null;
  const label = [title, money(h, e.amount, hide), `${personName(h, e.payerId)} paid`, r.createdVia ? `added by ${authorName(h, r.createdBy, r.createdVia)}` : null, r.voided ? `voided: ${r.voidReason}` : effect, edited ? 'edited' : null, e.note ? `note: ${e.note}` : null]
    .filter(Boolean).join(', ');
  return (
    <View style={{ flexDirection: mine ? 'row-reverse' : 'row', alignItems: 'flex-end', gap: 8, maxWidth: '86%', alignSelf: mine ? 'flex-end' : 'flex-start' }}>
      <Avatar initials={initials(h, e.payerId)} tone={t} size={26} />
      <View style={{ flexShrink: 1, minWidth: 0 }}>
        <Press noScale onPress={() => onSelect(r.id)} accessibilityLabel={`${label}. Open details`}
            style={{ minWidth: 190, maxWidth: '100%', backgroundColor: t.band, borderRadius: 22, paddingHorizontal: 14, paddingTop: 9, paddingBottom: 8,
              borderBottomLeftRadius: mine ? 22 : 6, borderBottomRightRadius: mine ? 6 : 22, opacity: r.voided ? 0.72 : 1 }}>
            <T numberOfLines={2} style={[{ fontFamily: fonts.bold, fontSize: 15, color: t.ink, flexShrink: 1 }, strike]}>{title}</T>
            <T style={[{ fontFamily: fonts.display, fontSize: 26, lineHeight: 30, letterSpacing: -0.5, color: t.ink, fontVariant: ['tabular-nums'] }, strike]}>{money(h, e.amount, hide)}</T>
            {e.note && !r.voided ? <T style={{ fontFamily: fonts.semibold, fontSize: 13.5, color: t.ink, marginTop: 1 }}>“{e.note}”</T> : null}
            <T style={{ fontFamily: fonts.semibold, fontSize: 13, color: t.ink, opacity: 0.88 }}>
              {splitLabel(r)}{effect ? ` · ${effect}` : ''}
            </T>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 4, opacity: 0.9 }}>
              {seen ? <Checks size={16} color={t.ink} /> : null}
              <T style={{ fontFamily: fonts.bold, fontSize: 12, color: t.ink, flexShrink: 1 }}>{foot}</T>
            </View>
          </Press>
      </View>
    </View>
  );
}

function RepayCard({ h, r, hide, onSelect }: { h: Household; r: LedgerRecord; hide: boolean; onSelect: (id: ID) => void }) {
  const { c } = useTheme();
  const s = r.settlement!;
  const title = `${settlementTitle(h, r)} ${money(h, s.amount, hide)}`;
  const meta = [s.method ? METHOD_LABEL[s.method] : null, s.note ? `“${s.note}”` : null].filter(Boolean).join(' · ');
  const seen = seenBy(h, r);
  const foot = `Recorded by ${authorName(h, r.createdBy, r.createdVia)}${seen ? ` · Seen by ${seen}` : ''}${r.flagged ? ' · Flagged' : ''}${r.voided ? ' · Voided' : ''}`;
  const strike = r.voided ? ({ textDecorationLine: 'line-through' } as const) : null;
  return (
    <View style={{ alignSelf: 'center', maxWidth: '92%' }}>
      <Press noScale onPress={() => onSelect(r.id)} accessibilityLabel={`Repayment: ${title}. ${meta}. ${foot}. Open details`}
          style={{ backgroundColor: c.ink, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, alignItems: 'center', opacity: r.voided ? 0.6 : 1 }}>
          <T style={[{ fontFamily: fonts.bold, fontSize: 15, color: c.bg, textAlign: 'center' }, strike]}>{title}</T>
          {meta ? <T style={{ fontFamily: fonts.semibold, fontSize: 13.5, color: c.bg, marginTop: 3, textAlign: 'center' }}>{meta}</T> : null}
          <T style={{ fontFamily: fonts.semibold, fontSize: 12.5, color: alpha(c.bg, 0.75), marginTop: 2, textAlign: 'center' }}>{foot}</T>
      </Press>
    </View>
  );
}

function SystemLine({ line, onPress }: { line: string; onPress: () => void }) {
  const { c } = useTheme();
  return (
    <View style={{ alignSelf: 'center', maxWidth: '94%' }}>
      <Press noScale onPress={onPress} accessibilityLabel={`${line}. Open details`}
        style={{ minHeight: 34, justifyContent: 'center', backgroundColor: c.chip, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 7 }}>
        <T style={{ fontFamily: fonts.semibold, fontSize: 13, color: c.ink2, textAlign: 'center' }}>{line}</T>
      </Press>
    </View>
  );
}

export function EmptyThread({ empty, query, filter, shared }: { empty: boolean; query: string; filter: Filter; shared: boolean }) {
  const { ui } = useTheme();
  const what = filter === 'expenses' ? 'expenses' : filter === 'repayments' ? 'repayments' : filter === 'changes' ? 'edits or voids' : 'records';
  return (
    <View style={{ alignItems: 'center', paddingVertical: space[7], gap: space[1] }}>
      <T style={[text.title, { textAlign: 'center' }]}>
        {query ? `Nothing matches “${query}”` : empty ? 'Nothing here yet' : `No ${what} yet`}
      </T>
      <T style={[text.body, { color: ui.muted, textAlign: 'center', maxWidth: 300 }]}>
        {query ? 'Try a name, a category or a word from a note.' : empty ? shared ? 'Add the first expense and it shows up here for everyone.' : 'Add the first expense and it shows up here.' : 'They show up here as soon as anyone adds one.'}
      </T>
    </View>
  );
}

// ---------- compose ----------

function Compose({ bottom }: { bottom: number }) {
  const { c } = useTheme();
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: c.hair, backgroundColor: c.dark ? c.bg : alpha('#FBFAF6', 0.95), paddingTop: 10, paddingHorizontal: 12, paddingBottom: bottom }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, width: '100%' }}>
        <Press noScale accessibilityLabel="Add an expense" onPress={() => openSheet({ type: 'add' })}
          style={{ flex: 1, height: 48, borderRadius: 24, backgroundColor: c.card, borderWidth: 1, borderColor: c.hair, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 10 }}>
          <T style={{ flex: 1, fontFamily: fonts.semibold, fontSize: 16, color: c.ink2 }} numberOfLines={1}>Add an expense…</T>
        </Press>
        <OrbButton size={56} plus={24} />
      </View>
    </View>
  );
}
