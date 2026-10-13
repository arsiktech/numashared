// The history thread: a conversation of bubbles in the payer group's color, repayment cards and
// centered system lines for openings, edits and voids. Newest at the bottom, with a compose bar.
// Phone renders its own header (back, search, title, filters); the desk variant renders a title
// row with the filters, a centered 720 pt column and a ring around the selected record.
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
import { OrbButton, settlementTitle } from '../records';
import { clock, effectLine, initials, money, personName, recordTitle, useHousehold } from '../hooks';
import {
  dayLabel, FILTERS, isMine, METHOD_LABEL, openingLine, sameDay, seenBy, splitLabel, threadItems,
  type Filter, type ThreadItem,
} from './model';
import { requestHistorySearch, setHistoryQuery, useHistoryQuery, useHistorySearchOpen } from './search';

export function HistoryThread({ selectedId, onSelect, desk }: { selectedId?: ID | null; onSelect: (id: ID) => void; desk?: boolean }) {
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
      {desk ? <DeskHeader filter={filter} setFilter={setFilter} query={query} /> : <PhoneHeader h={h} filter={filter} setFilter={setFilter} query={query} />}
      <ScrollView ref={scroller} style={{ flex: 1 }} onScroll={onScroll} scrollEventThrottle={32}
        onContentSizeChange={() => { if (stick.current) scroller.current?.scrollToEnd({ animated: false }); }}
        contentContainerStyle={{ flexGrow: 1, justifyContent: 'flex-end', paddingHorizontal: desk ? 20 : 12, paddingTop: 8, paddingBottom: desk ? 28 : 12 }}>
        <View accessibilityRole={isWeb ? ('list' as never) : undefined} style={{ gap: 4, width: '100%', maxWidth: desk ? 720 : undefined, alignSelf: 'center' }}>
          {items.length ? items.map((it, i) => (
            <View key={it.key} style={{ gap: 4 }}>
              {i === 0 || !sameDay(items[i - 1].at, it.at) ? <DaySeparator at={it.at} desk={!!desk} /> : null}
              <Item h={h} it={it} hide={hide} desk={!!desk} selected={selectedId === it.record.id && it.kind !== 'change'} onSelect={onSelect} />
            </View>
          )) : <EmptyThread empty={empty} query={query} filter={filter} />}
        </View>
      </ScrollView>
      <Compose desk={!!desk} bottom={desk ? 12 : Math.max(insets.bottom - 4, 10)} />
    </View>
  );
}

// ---------- headers ----------

function Filters({ filter, setFilter, compact }: { filter: Filter; setFilter: (f: Filter) => void; compact?: boolean }) {
  const { c } = useTheme();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: compact ? 6 : 8 }}
      accessibilityRole={isWeb ? ('tablist' as never) : undefined}>
      {FILTERS.map((f) => {
        const on = f.id === filter;
        return (
          <Press key={f.id} onPress={() => setFilter(f.id)} accessibilityRole={isWeb ? ('tab' as never) : 'button'} accessibilityState={{ selected: on }}
            accessibilityLabel={`Show ${f.label.toLowerCase()}`}
            style={{ height: 44, justifyContent: 'center' }}>
            <View style={{ height: 36, borderRadius: 18, paddingHorizontal: compact ? 11 : 14, flexDirection: 'row', alignItems: 'center', gap: 6,
              backgroundColor: on ? c.ink : c.chip }}>
              {on && isAndroid ? <Check size={16} color={c.bg} /> : null}
              <T style={{ fontFamily: fonts.semibold, fontSize: compact ? 13.5 : 14.5, color: on ? c.bg : c.ink }}>{f.label}</T>
            </View>
          </Press>
        );
      })}
    </ScrollView>
  );
}

function SearchField({ query, onDone, autoFocus }: { query: string; onDone?: () => void; autoFocus?: boolean }) {
  const { c } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, height: 44, borderRadius: 22, backgroundColor: c.card, borderWidth: 1, borderColor: c.hair, paddingLeft: 14, flex: 1 }}>
      <Search size={18} color={c.ink2} />
      <TextInput value={query} onChangeText={setHistoryQuery} autoFocus={autoFocus} placeholder="Search history" placeholderTextColor={c.ink3}
        accessibilityLabel="Search history" returnKeyType="search" autoCorrect={false}
        style={{ flex: 1, minWidth: 0, height: 42, fontFamily: fonts.medium, fontSize: 16, color: c.ink, outlineStyle: 'none' } as never} />
      {onDone || query ? (
        <Press accessibilityLabel={query ? 'Clear search' : 'Close search'} onPress={() => { if (query) setHistoryQuery(''); else onDone?.(); }}
          style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
          <Close size={18} color={c.ink2} />
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
  const closeSearch = () => { setHistoryQuery(''); requestHistorySearch(false); setSearching(false); };

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

function DeskHeader({ filter, setFilter, query }: { filter: Filter; setFilter: (f: Filter) => void; query: string }) {
  const searchOpen = useHistorySearchOpen();
  return (
    <View style={{ padding: 20, paddingBottom: 8 }}>
      <View style={{ width: '100%', maxWidth: 720, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <T accessibilityRole="header" style={{ fontFamily: fonts.cond, fontSize: 34, lineHeight: 38 }}>History</T>
        <Filters filter={filter} setFilter={setFilter} />
      </View>
      {query || searchOpen ? (
        <View style={{ width: '100%', maxWidth: 720, alignSelf: 'center', marginTop: 8, flexDirection: 'row' }}>
          <SearchField query={query} autoFocus={searchOpen} onDone={() => { setHistoryQuery(''); requestHistorySearch(false); }} />
        </View>
      ) : null}
    </View>
  );
}

// ---------- items ----------

function DaySeparator({ at, desk }: { at: number; desk: boolean }) {
  const { c } = useTheme();
  return (
    <T accessibilityRole="header" style={{ alignSelf: 'center', fontFamily: fonts.bold, fontSize: 12.5, color: c.ink2, paddingTop: 8, paddingBottom: 2 }}>{dayLabel(at, desk)}</T>
  );
}

function Item({ h, it, hide, desk, selected, onSelect }: { h: Household; it: ThreadItem; hide: boolean; desk: boolean; selected: boolean; onSelect: (id: ID) => void }) {
  switch (it.kind) {
    case 'expense': return <Bubble h={h} r={it.record} hide={hide} desk={desk} selected={selected} onSelect={onSelect} />;
    case 'repayment': return <RepayCard h={h} r={it.record} hide={hide} selected={selected} onSelect={onSelect} />;
    case 'opening': return <SystemLine text={openingLine(h, it.record, hide)} selected={selected} onPress={() => onSelect(it.record.id)} />;
    case 'change': return <SystemLine text={it.text} onPress={() => onSelect(it.record.id)} />;
  }
}

/** A 3 pt ink ring that does not move the layout. */
function Ring({ on, radius, gap = 0, children }: { on: boolean; radius: number; gap?: number; children: React.ReactNode }) {
  const { c } = useTheme();
  if (!on) return <>{children}</>;
  return <View style={{ margin: -3 - gap, padding: gap, borderWidth: 3, borderColor: c.ink, borderRadius: radius + 3 + gap }}>{children}</View>;
}

function Bubble({ h, r, hide, desk, selected, onSelect }: { h: Household; r: LedgerRecord; hide: boolean; desk: boolean; selected: boolean; onSelect: (id: ID) => void }) {
  const { c, tone } = useTheme();
  const e = r.expense!;
  const mine = isMine(h, r);
  const t = tone(groupOfPerson(h, e.payerId));
  const title = recordTitle(r);
  const edited = r.revisions.length > 1;
  const effect = hide ? null : effectLine(h, r);
  const seen = r.createdBy === h.youId ? seenBy(h, r) : null;
  const added = r.createdBy !== e.payerId ? ` · added by ${personName(h, r.createdBy)}` : '';
  const foot = `${personName(h, e.payerId)} · ${clock(r.createdAt)}${added}${edited && !r.voided ? ' · edited' : ''}${r.voided ? ' · voided' : ''}${seen ? ` · Seen by ${seen}` : ''}`;
  const strike = r.voided ? ({ textDecorationLine: 'line-through' } as const) : null;
  const label = [title, money(h, e.amount, hide), `${personName(h, e.payerId)} paid`, r.voided ? `voided: ${r.voidReason}` : effect, edited ? 'edited' : null, e.note ? `note: ${e.note}` : null]
    .filter(Boolean).join(', ');
  return (
    <View style={{ flexDirection: mine ? 'row-reverse' : 'row', alignItems: 'flex-end', gap: 8, maxWidth: '86%', alignSelf: mine ? 'flex-end' : 'flex-start' }}>
      <Avatar initials={initials(h, e.payerId)} tone={t} size={26} />
      <View style={{ flexShrink: 1, minWidth: 0 }}>
        <Ring on={selected} radius={22}>
          <Press noScale onPress={() => onSelect(r.id)} accessibilityLabel={`${label}. Open details`} accessibilityState={{ selected }}
            style={{ minWidth: 190, maxWidth: '100%', backgroundColor: t.band, borderRadius: 22, paddingHorizontal: 14, paddingTop: 9, paddingBottom: 8,
              borderBottomLeftRadius: mine ? 22 : 6, borderBottomRightRadius: mine ? 6 : 22, opacity: r.voided ? 0.72 : 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              {desk ? <CategoryIcon category={e.category} size={20} color={t.ink} /> : null}
              <T numberOfLines={2} style={[{ fontFamily: fonts.bold, fontSize: 15, color: t.ink, flexShrink: 1 }, strike]}>{title}</T>
            </View>
            <T style={[{ fontFamily: fonts.display, fontSize: 26, lineHeight: 30, letterSpacing: -0.5, color: t.ink, fontVariant: ['tabular-nums'] }, strike]}>{money(h, e.amount, hide)}</T>
            {e.note && !r.voided ? <T style={{ fontFamily: fonts.semibold, fontSize: 13.5, color: t.ink, marginTop: 1 }}>“{e.note}”</T> : null}
            <T style={{ fontFamily: fonts.semibold, fontSize: 13, color: t.ink, opacity: 0.88 }}>
              {splitLabel(r)}{effect ? ` · ${effect}` : ''}
            </T>
            {!desk || seen ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 4, opacity: 0.9 }}>
                {seen ? <Checks size={16} color={t.ink} /> : null}
                <T style={{ fontFamily: fonts.bold, fontSize: 12, color: t.ink, flexShrink: 1 }}>{desk ? `Seen by ${seen}` : foot}</T>
              </View>
            ) : null}
          </Press>
        </Ring>
      </View>
    </View>
  );
}

function RepayCard({ h, r, hide, selected, onSelect }: { h: Household; r: LedgerRecord; hide: boolean; selected: boolean; onSelect: (id: ID) => void }) {
  const { c } = useTheme();
  const s = r.settlement!;
  const title = `${settlementTitle(h, r)} ${money(h, s.amount, hide)}`;
  const meta = [s.method ? METHOD_LABEL[s.method] : null, s.note ? `“${s.note}”` : null].filter(Boolean).join(' · ');
  const seen = seenBy(h, r);
  const foot = `Recorded by ${personName(h, r.createdBy)}${seen ? ` · Seen by ${seen}` : ''}${r.flagged ? ' · Flagged' : ''}${r.voided ? ' · Voided' : ''}`;
  const strike = r.voided ? ({ textDecorationLine: 'line-through' } as const) : null;
  return (
    <View style={{ alignSelf: 'center', maxWidth: '92%' }}>
      <Ring on={selected} radius={20} gap={2}>
        <Press noScale onPress={() => onSelect(r.id)} accessibilityLabel={`Repayment: ${title}. ${meta}. ${foot}. Open details`} accessibilityState={{ selected }}
          style={{ backgroundColor: c.ink, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, alignItems: 'center', opacity: r.voided ? 0.6 : 1 }}>
          <T style={[{ fontFamily: fonts.bold, fontSize: 15, color: c.bg, textAlign: 'center' }, strike]}>{title}</T>
          {meta ? <T style={{ fontFamily: fonts.semibold, fontSize: 13.5, color: c.bg, marginTop: 3, textAlign: 'center' }}>{meta}</T> : null}
          <T style={{ fontFamily: fonts.semibold, fontSize: 12.5, color: alpha(c.bg, 0.75), marginTop: 2, textAlign: 'center' }}>{foot}</T>
        </Press>
      </Ring>
    </View>
  );
}

function SystemLine({ text, onPress, selected }: { text: string; onPress: () => void; selected?: boolean }) {
  const { c } = useTheme();
  return (
    <View style={{ alignSelf: 'center', maxWidth: '94%' }}>
      <Ring on={!!selected} radius={14}>
        <Press noScale onPress={onPress} accessibilityLabel={`${text}. Open details`} accessibilityState={selected ? { selected } : undefined}
          style={{ minHeight: 34, justifyContent: 'center', backgroundColor: c.chip, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 7 }}>
          <T style={{ fontFamily: fonts.semibold, fontSize: 13, color: c.ink2, textAlign: 'center' }}>{text}</T>
        </Press>
      </Ring>
    </View>
  );
}

function EmptyThread({ empty, query, filter }: { empty: boolean; query: string; filter: Filter }) {
  const { c } = useTheme();
  const what = filter === 'expenses' ? 'expenses' : filter === 'repayments' ? 'repayments' : filter === 'changes' ? 'edits or voids' : 'records';
  return (
    <View style={{ alignItems: 'center', paddingVertical: 40, gap: 6 }}>
      <T style={{ fontFamily: fonts.bold, fontSize: 18, textAlign: 'center' }}>
        {query ? `Nothing matches “${query}”` : empty ? 'Nothing here yet' : `No ${what} yet`}
      </T>
      <T style={{ fontSize: 14, color: c.ink2, textAlign: 'center', maxWidth: 300 }}>
        {query ? 'Try a name, a category or a word from a note.' : empty ? 'Add the first expense and it shows up here for everyone.' : 'They show up here as soon as anyone adds one.'}
      </T>
    </View>
  );
}

// ---------- compose ----------

function Compose({ desk, bottom }: { desk: boolean; bottom: number }) {
  const { c } = useTheme();
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: c.hair, backgroundColor: c.dark ? c.bg : alpha('#FBFAF6', 0.95), paddingTop: 10, paddingHorizontal: 12, paddingBottom: bottom }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, width: '100%', maxWidth: desk ? 720 : undefined, alignSelf: 'center' }}>
        <Press noScale accessibilityLabel="Add an expense" onPress={() => openSheet({ type: 'add' })}
          style={{ flex: 1, height: 48, borderRadius: 24, backgroundColor: c.card, borderWidth: 1, borderColor: c.hair, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 10 }}>
          <T style={{ flex: 1, fontFamily: fonts.semibold, fontSize: 16, color: c.ink2 }} numberOfLines={1}>Add an expense…</T>
          {desk ? (
            <View style={{ minWidth: 22, height: 22, borderRadius: 6, borderWidth: 1, borderColor: c.hair, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 }}>
              <T style={{ fontFamily: fonts.semibold, fontSize: 12, color: c.ink2 }}>N</T>
            </View>
          ) : null}
        </Press>
        <OrbButton size={56} plus={24} />
      </View>
    </View>
  );
}
