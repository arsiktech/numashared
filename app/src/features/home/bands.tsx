// Home bands: your group on top with the balance ticket and the orb on its edge, then one band per
// other group. Two groups get the big two-band layout; three or more get compact bands that say what
// each group means for you.
import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { planSettlement } from '@/core';
import type { Group, Household, ID } from '@/core/types';
import { yourGroup } from '@/store/store';
import { openSheet } from '@/store/ui';
import { ArrowDown, ArrowUp, Check, ChevDown, Gear, People } from '@/ui/icons';
import { Dot, Pill, Press, T } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { alpha, fonts, isAndroid } from '@/ui/tokens';
import { OrbButton } from '../records';
import { money, nameOf, standingWords } from '../hooks';

/**
 * `tail` extends the lowest band's color that far below, for a list that slides up over the bands.
 * `onOrb` reports where the orb's lower edge sits, for the history's detent there.
 */
export function Bands({ h, balances, hide, compact, tail, onOrb }: {
  h: Household; balances: Record<ID, number>; hide: boolean; compact?: boolean; tail?: number; onOrb?: (bottom: number) => void;
}) {
  const { tone, c, width } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const mine = yourGroup(h);
  const others = h.groups.filter((g) => g.id !== mine.id);
  const t = tone(mine);
  const bal = balances[mine.id] ?? 0;
  const many = others.length > 1;
  const nameSize = compact ? 56 : Math.min(74, (width - 44) / 4.6);
  const plan = planSettlement(balances);
  const transfers = plan.status === 'exact' ? plan.transfers : [];
  const topH = (compact ? 20 : insets.top) + (compact ? 0 : 44) + 14 + 20 + nameSize * 0.95 + (many ? 34 : 60);
  const square = Object.values(balances).every((v) => v === 0);
  const empty = h.events.length === 0;
  const partners = mine.memberIds.filter((id) => id !== h.youId).map((id) => h.people.find((p) => p.id === id)!);
  const me = h.people.find((p) => p.id === h.youId)?.name.trim();
  const named = me && me !== 'You' ? me : '';

  const ticketTop = topH - 39;
  const lowest = others.length ? tone(others[others.length - 1]).band : c.chip;
  return (
    <View>
      {tail ? <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: '100%', height: tail, backgroundColor: lowest }} /> : null}
      <View style={{ backgroundColor: t.band, height: topH, paddingTop: compact ? 20 : insets.top, paddingHorizontal: 22 }}>
        {!compact ? (
          <View style={{ height: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Press accessibilityLabel={`Household: ${h.name}. Switch`} onPress={() => openSheet({ type: 'households' })}
              style={{ height: 44, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <T style={{ fontFamily: fonts.semibold, fontSize: 17, color: t.ink }}>{h.name}</T>
              <ChevDown size={16} color={t.ink} />
            </Press>
            <Press accessibilityLabel="Household settings" onPress={() => router.push('/settings')}
              style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: alpha('#FFFFFF', 0.5), alignItems: 'center', justifyContent: 'center' }}>
              {isAndroid ? <Gear size={22} color={t.ink} /> : <People size={22} color={t.ink} />}
            </Press>
          </View>
        ) : null}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
          <T style={{ fontFamily: fonts.semibold, fontSize: 14, color: t.ink, opacity: 0.85 }}>
            {partners.length ? (named ? `Your group · ${named} (you) ·` : 'Your group ·') : named ? `${named} (you)` : h.groups.length > 2 ? `${h.people.length} people` : 'Only you'}
          </T>
          {partners.map((p) => (
            <View key={p.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Dot color={p.joined ? c.good : alpha('#000000', 0.3)} />
              <T style={{ fontFamily: fonts.semibold, fontSize: 14, color: t.ink, opacity: 0.85 }}>{p.name}</T>
            </View>
          ))}
        </View>
        <T accessibilityRole="header" numberOfLines={1} adjustsFontSizeToFit style={{ fontFamily: fonts.cond, fontSize: nameSize, lineHeight: nameSize * 0.98, color: t.ink, marginTop: 2 }}>
          {nameOf(h, mine)}
        </T>
      </View>

      {others.length === 0 ? (
        <AloneBand />
      ) : others.length === 1 ? (
        <TwoGroupBand h={h} g={others[0]} balances={balances} nameSize={nameSize} square={square} />
      ) : others.map((g, i) => (
        <CompactBand key={g.id} h={h} g={g} hide={hide} first={i === 0} balances={balances} transfers={transfers} mine={mine} last={i === others.length - 1} />
      ))}

      <Press accessibilityLabel={square ? 'All square. See the balance' : `${nameOf(h, mine)} ${bal < 0 ? 'owe' : 'get back'} ${money(h, Math.abs(bal), hide)}. See why`}
        onPress={() => openSheet({ type: 'plan' })}
        style={{ position: 'absolute', left: 20, top: ticketTop, height: 78, paddingHorizontal: 20, borderRadius: 39, backgroundColor: c.dark ? c.card : '#FBFAF6',
          flexDirection: 'row', alignItems: 'center', gap: 12, maxWidth: (compact ? 360 : width) - 132,
          shadowColor: '#1E2420', shadowOpacity: 0.2, shadowRadius: 15, shadowOffset: { width: 0, height: 12 }, elevation: 6 }}>
        {square || empty ? (
          <>
            <T style={{ fontFamily: fonts.cond, fontSize: 30, color: c.dark ? c.ink : '#1E2420' }}>All square</T>
            <Check size={22} color={c.dark ? c.ink : '#1E2420'} />
          </>
        ) : (
          <>
            <View style={{ flexShrink: 1, minWidth: 0 }}>
              <T numberOfLines={1} style={{ fontFamily: fonts.semibold, fontSize: 13, color: c.dark ? c.ink2 : '#595D56' }}>
                {partners.length ? (bal < 0 ? 'Your group owes' : 'Your group gets back') : bal < 0 ? 'You owe' : 'You get back'}
              </T>
              <T numberOfLines={1} adjustsFontSizeToFit style={{ fontFamily: fonts.display, fontSize: ticketSize(money(h, Math.abs(bal), hide), compact ? 32 : 38, (compact ? 360 : width) - 132 - 74), lineHeight: compact ? 36 : 42, letterSpacing: -1, color: c.dark ? c.ink : '#1E2420', fontVariant: ['tabular-nums'] }}>
                {money(h, Math.abs(bal), hide)}
              </T>
            </View>
            {bal < 0 ? <ArrowDown size={22} color={c.dark ? c.ink : '#1E2420'} /> : <ArrowUp size={22} color={c.dark ? c.ink : '#1E2420'} />}
          </>
        )}
      </Press>
      <OrbButton size={compact ? 76 : 92} plus={compact ? 28 : 32} style={{ position: 'absolute', right: 20, top: ticketTop - (compact ? -1 : 7) }} />
      {onOrb ? <View pointerEvents="none" onLayout={(e) => onOrb(e.nativeEvent.layout.y + e.nativeEvent.layout.height)}
        style={{ position: 'absolute', right: 20, top: ticketTop - (compact ? -1 : 7), width: compact ? 76 : 92, height: compact ? 76 : 92 }} /> : null}
    </View>
  );
}

function TwoGroupBand({ h, g, balances, nameSize, square }: { h: Household; g: Group; balances: Record<ID, number>; nameSize: number; square: boolean }) {
  const { tone, c } = useTheme();
  const t = tone(g);
  const mine = yourGroup(h);
  const bal = balances[mine.id] ?? 0;
  const members = g.memberIds.map((id) => h.people.find((p) => p.id === id)!);
  return (
    <View style={{ backgroundColor: t.band, paddingTop: 58, paddingHorizontal: 22, paddingBottom: 52, minHeight: 250 }}>
      <T numberOfLines={1} adjustsFontSizeToFit style={{ fontFamily: fonts.cond, fontSize: nameSize, lineHeight: nameSize * 0.98, color: t.ink }}>{nameOf(h, g)}</T>
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 6, flexWrap: 'wrap' }}>
        {members.map((p) => (
          <View key={p.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Dot color={p.joined ? c.good : alpha('#000000', 0.3)} />
            <T style={{ fontFamily: fonts.semibold, fontSize: 14, color: t.ink, opacity: 0.85 }}>{p.joined || !h.sync ? p.name : `${p.name} · invited`}</T>
          </View>
        ))}
      </View>
      {!square ? (
        <Pill style={{ marginTop: 18 }} label={bal < 0 ? `${mine.memberIds.length > 1 ? 'We' : 'I'} paid ${nameOf(h, g)}` : `${nameOf(h, g)} paid ${mine.memberIds.length > 1 ? 'us' : 'me'}`}
          onPress={() => openSheet({ type: 'repay', fromGroupId: bal < 0 ? mine.id : g.id, toGroupId: bal < 0 ? g.id : mine.id, amount: Math.abs(bal) })} />
      ) : null}
    </View>
  );
}

function CompactBand({ h, g, hide, first, last, balances, transfers, mine }: {
  h: Household; g: Group; hide: boolean; first: boolean; last: boolean; balances: Record<ID, number>;
  transfers: { fromGroupId: ID; toGroupId: ID; amount: number }[]; mine: Group;
}) {
  const { tone, c } = useTheme();
  const t = tone(g);
  const owesMe = transfers.find((x) => x.fromGroupId === g.id && x.toGroupId === mine.id);
  const iOwe = transfers.find((x) => x.fromGroupId === mine.id && x.toGroupId === g.id);
  const own = balances[g.id] ?? 0;
  const single = g.memberIds.length === 1;
  const overall = standingWords(h, own, single, hide);
  return (
    <View style={{ backgroundColor: t.band, paddingTop: first ? 50 : 16, paddingBottom: last ? 44 : 16, paddingHorizontal: 22 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <T numberOfLines={1} adjustsFontSizeToFit style={{ fontFamily: fonts.cond, fontSize: 48, lineHeight: 48, color: t.ink }}>{nameOf(h, g)}</T>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>
            <Dot color={g.memberIds.every((id) => h.people.find((p) => p.id === id)?.joined) ? c.good : alpha('#000000', 0.3)} />
            <T style={{ fontFamily: fonts.semibold, fontSize: 14, color: t.ink, opacity: 0.85 }}>{overall}</T>
          </View>
        </View>
        {iOwe ? (
          <Pill small label={`Pay ${money(h, iOwe.amount, hide)}`} accessibilityLabel={`Record paying ${nameOf(h, g)} ${money(h, iOwe.amount, hide)}`}
            onPress={() => openSheet({ type: 'repay', fromGroupId: mine.id, toGroupId: g.id, amount: iOwe.amount })} />
        ) : owesMe ? (
          <Pill small label={`${nameOf(h, g)} paid you`} accessibilityLabel={`Record ${nameOf(h, g)} paying you ${money(h, owesMe.amount, hide)}`}
            onPress={() => openSheet({ type: 'repay', fromGroupId: g.id, toGroupId: mine.id, amount: owesMe.amount })} />
        ) : (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 44 }}>
            <Check size={18} color={t.ink} />
            <T style={{ fontFamily: fonts.semibold, fontSize: 14, color: t.ink }}>Square with you</T>
          </View>
        )}
      </View>
    </View>
  );
}

/** Shrink the ticket number so long amounts fit instead of being cut off. */
function ticketSize(text: string, max: number, room: number) {
  return Math.max(20, Math.min(max, Math.floor(room / (text.length * 0.66))));
}

/** A household with only your group: nothing to split yet, so point at adding people. */
function AloneBand() {
  const { c } = useTheme();
  const router = useRouter();
  return (
    <View style={{ backgroundColor: c.chip, paddingTop: 58, paddingHorizontal: 22, paddingBottom: 52, minHeight: 230 }}>
      <T style={{ fontFamily: fonts.cond, fontSize: 48, lineHeight: 50, color: c.ink }}>Who else lives here?</T>
      <T style={{ fontSize: 15, color: c.ink2, marginTop: 6, maxWidth: 320 }}>Add the people you share costs with. Each one gets a color.</T>
      <Pill style={{ marginTop: 18 }} label="Add people" onPress={() => router.push('/settings/people')} />
    </View>
  );
}
