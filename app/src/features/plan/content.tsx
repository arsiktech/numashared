// "Balance": where each group stands, the fewest repayments that settle it, and every line that
// moved your group's balance. Two groups read as one sentence; three or more get the diverging
// owes / gets-back chart and one card per repayment.
import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { explain, formatMoney, isPlural, planSettlement } from '@/core';
import type { ExplainLine, Group, Household, Transfer } from '@/core/types';
import { yourGroup } from '@/store/store';
import { openSheet, replaceSheet } from '@/store/ui';
import { ArrowRight, Check, Close } from '@/ui/icons';
import { CTA, Dot, Pill, Press, T, TextButton } from '@/ui/primitives';
import { SheetHead, useSheet } from '@/ui/sheet';
import { useTheme } from '@/ui/theme';
import { fonts, isAndroid } from '@/ui/tokens';
import { money, nameOf, useHousehold } from '../hooks';
import { dayMonth, isoDay } from '../history/model';

export function PlanContent() {
  const { h, ledger, hide } = useHousehold();
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const { close } = useSheet();
  if (!h || !ledger) return null;
  const mine = yourGroup(h);
  const balances = ledger.balances;
  const many = h.groups.length > 2;
  const square = Object.values(balances).every((v) => v === 0);
  const plan = planSettlement(balances);
  const transfers = plan.status === 'exact' ? plan.transfers : [];
  const lines = explain(ledger, h, mine.id);
  const bal = balances[mine.id] ?? 0;
  const other = h.groups.find((g) => g.id !== mine.id);

  const record = (t: Transfer) => replaceSheet({ type: 'repay', fromGroupId: t.fromGroupId, toGroupId: t.toGroupId, amount: t.amount });

  let title: string;
  if (square) title = many ? 'Everyone is square' : 'All square';
  else if (many) title = 'Getting everyone square';
  else {
    const debtor = bal < 0 ? mine : other!;
    const creditor = bal < 0 ? other! : mine;
    title = `${nameOf(h, debtor)} ${isPlural(debtor, h.people, h.youId) ? 'owe' : 'owes'}\n${nameOf(h, creditor)} ${money(h, Math.abs(bal), hide)}`;
  }
  const sub = square
    ? `Nobody owes anything in ${h.name} right now.`
    : many ? `Where each group stands in ${h.name}, and the fewest repayments that settle it.` : 'Every line that moved the balance, oldest first.';

  // Two groups: one CTA. You owe: record paying them. They owe you: record their repayment.
  const cta = !many && !square && other ? (
    bal < 0
      ? <CTA label="Record a repayment" onPress={() => record({ fromGroupId: mine.id, toGroupId: other.id, amount: -bal })} />
      : <CTA variant="second" label={`${nameOf(h, other)} paid you back`} onPress={() => record({ fromGroupId: other.id, toGroupId: mine.id, amount: bal })} />
  ) : null;

  return (
    <View style={{ flex: 1 }}>
      {isAndroid ? (
        <View style={{ height: 56, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, gap: 4 }}>
          <Press accessibilityLabel="Close" onPress={() => close()} style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center' }}>
            <Close size={22} color={c.ink} />
          </Press>
          <T accessibilityRole="header" style={{ flex: 1, fontFamily: fonts.semibold, fontSize: 22, paddingLeft: 4 }}>Balance</T>
        </View>
      ) : (
        <SheetHead title="Balance" right={<TextButton label="Done" bold onPress={() => close('done')} />} />
      )}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 22, paddingTop: 8, paddingBottom: 20 }}>
        <T accessibilityRole="header" style={{ fontFamily: fonts.cond, fontSize: many || square ? 40 : 36, lineHeight: many || square ? 42 : 38, letterSpacing: -0.4 }}>{title}</T>
        <T style={{ fontSize: 14, lineHeight: 19, color: c.ink2, marginTop: 8 }}>{sub}</T>

        {square ? <AllSquare h={h} /> : null}
        {many && !square ? <Diverging h={h} balances={balances} hide={hide} /> : null}

        {many && !square ? (
          plan.status === 'exact' ? (
            <View>
              <Section>{transfers.length === 1 ? '1 repayment settles everything' : `${transfers.length} repayments settle everything`}</Section>
              <View style={{ gap: 10 }}>
                {[...transfers].sort((a, b) => Number(b.fromGroupId === mine.id || b.toGroupId === mine.id) - Number(a.fromGroupId === mine.id || a.toGroupId === mine.id)).map((t) => <Move key={`${t.fromGroupId}-${t.toGroupId}`} h={h} t={t} mine={mine} hide={hide} onRecord={() => record(t)} />)}
              </View>
              <T style={{ fontFamily: fonts.semibold, fontSize: 12.5, lineHeight: 18, color: c.ink2, marginTop: 16 }}>
                Worked out from today’s balances and updated whenever anything changes. Paying someone else directly is fine too: Numa Shared keeps every balance right either way.
              </T>
            </View>
          ) : (
            <T style={{ fontSize: 14, lineHeight: 19, color: c.ink2, marginTop: 20 }}>
              There are too many balances to work out the fewest repayments here. Each group’s balance above is still exact.
            </T>
          )
        ) : null}

        {lines.length ? (
          <View>
            {many || square ? <Section>Every line that moved your balance</Section> : null}
            <WhyTable h={h} lines={lines} hide={hide} />
            <T style={{ fontFamily: fonts.semibold, fontSize: 12.5, color: c.ink2, marginTop: 14 }}>Tap any line to see who added it and every change.</T>
          </View>
        ) : null}
      </ScrollView>
      {cta ? <View style={{ paddingHorizontal: 18, paddingTop: 8, paddingBottom: Math.max(insets.bottom, 12) + 4 }}>{cta}</View> : null}
    </View>
  );
}

function Section({ children }: { children: string }) {
  const { c } = useTheme();
  return <T accessibilityRole="header" style={{ fontFamily: fonts.semibold, fontSize: 13, color: c.ink2, paddingTop: 24, paddingBottom: 8, paddingHorizontal: 4 }}>{children}</T>;
}

function AllSquare({ h }: { h: Household }) {
  const { c } = useTheme();
  return (
    <View style={{ marginTop: 20, borderRadius: 18, backgroundColor: c.card, borderWidth: 1, borderColor: c.hair, padding: 16, flexDirection: 'row', gap: 12, alignItems: 'center' }}>
      <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: c.chip, alignItems: 'center', justifyContent: 'center' }}>
        <Check size={22} color={c.ink} />
      </View>
      <T style={{ flex: 1, fontSize: 15, lineHeight: 21 }}>Nothing to repay. New expenses in {h.name} show up here as soon as anyone adds one.</T>
    </View>
  );
}

// ---------- diverging chart ----------

function Diverging({ h, balances, hide }: { h: Household; balances: Record<string, number>; hide: boolean }) {
  const { c, tone } = useTheme();
  const max = Math.max(1, ...h.groups.map((g) => Math.abs(balances[g.id] ?? 0)));
  const nameW = 96;
  return (
    <View style={{ marginTop: 22 }} accessibilityLabel={h.groups.map((g) => {
      const b = balances[g.id] ?? 0;
      return `${nameOf(h, g)} ${b < 0 ? `owes ${money(h, -b)}` : b > 0 ? `gets back ${money(h, b)}` : 'square'}`;
    }).join('. ')}>
      <View style={{ flexDirection: 'row', marginBottom: 4 }}>
        <View style={{ width: nameW }} />
        <T style={{ flex: 1, textAlign: 'right', paddingRight: 10, fontFamily: fonts.semibold, fontSize: 12.5, color: c.ink2 }}>owes</T>
        <T style={{ flex: 1, paddingLeft: 10, fontFamily: fonts.semibold, fontSize: 12.5, color: c.ink2 }}>gets back</T>
      </View>
      {h.groups.map((g) => {
        const b = balances[g.id] ?? 0;
        const t = tone(g);
        const w = `${Math.max(8, Math.round((Math.abs(b) / max) * 96))}%` as const;
        const bar = (side: 'l' | 'r') => (
          <View style={{ position: 'absolute', top: 0, bottom: 0, [side === 'l' ? 'right' : 'left']: 4, width: w, minWidth: 72, borderRadius: 8,
            backgroundColor: t.band, justifyContent: 'center', paddingHorizontal: 8 }}>
            <T numberOfLines={1} style={{ fontFamily: fonts.bold, fontSize: 13, color: t.ink, fontVariant: ['tabular-nums'], textAlign: side === 'l' ? 'left' : 'left' }}>{money(h, Math.abs(b), hide)}</T>
          </View>
        );
        return (
          <View key={g.id} style={{ flexDirection: 'row', alignItems: 'center', minHeight: 46 }}>
            <T numberOfLines={2} style={{ width: nameW, paddingRight: 6, fontFamily: fonts.semibold, fontSize: 14.5 }}>{nameOf(h, g)}</T>
            <View style={{ flex: 1, height: 30, borderRightWidth: 2, borderRightColor: c.ink }}>{b < 0 ? bar('l') : null}</View>
            <View style={{ flex: 1, height: 30, justifyContent: 'center' }}>
              {b > 0 ? bar('r') : b === 0 ? <T style={{ paddingLeft: 10, fontFamily: fonts.semibold, fontSize: 13, color: c.ink2 }}>square</T> : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

// ---------- repayment cards ----------

function Move({ h, t, mine, hide, onRecord }: { h: Household; t: Transfer; mine: Group; hide: boolean; onRecord: () => void }) {
  const { c, tone } = useTheme();
  const from = h.groups.find((g) => g.id === t.fromGroupId)!;
  const to = h.groups.find((g) => g.id === t.toGroupId)!;
  const yours = from.id === mine.id || to.id === mine.id;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 14, paddingHorizontal: 16, borderRadius: 18, backgroundColor: c.card,
      borderWidth: yours ? 2 : 1, borderColor: yours ? c.ink : c.hair }}
      accessibilityLabel={`${nameOf(h, from)} pay ${nameOf(h, to)} ${money(h, t.amount, hide)}`}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Pair h={h} from={from} to={to} dot={(g) => tone(g).deep} />
        <T style={{ fontFamily: fonts.display, fontSize: 26, letterSpacing: -0.8, marginTop: 2, fontVariant: ['tabular-nums'] }}>{money(h, t.amount, hide)}</T>
      </View>
      {yours ? (
        <Pill label="Record it" accessibilityLabel={`Record ${nameOf(h, from)} paying ${nameOf(h, to)} ${money(h, t.amount)}`} onPress={onRecord} />
      ) : (
        <T style={{ fontFamily: fonts.semibold, fontSize: 12.5, lineHeight: 17, color: c.ink2, textAlign: 'right', maxWidth: 130 }}>
          {nameOf(h, from)} or {nameOf(h, to)}{'\n'}record this one
        </T>
      )}
    </View>
  );
}

function Pair({ h, from, to, dot }: { h: Household; from: Group; to: Group; dot: (g: Group) => string }) {
  const { c } = useTheme();
  const name = (g: Group): ReactNode => <T style={{ fontFamily: fonts.semibold, fontSize: 15 }}>{nameOf(h, g)}</T>;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <Dot color={dot(from)} />{name(from)}
      <ArrowRight size={16} color={c.ink} />
      <Dot color={dot(to)} />{name(to)}
    </View>
  );
}

// ---------- why table ----------

function WhyTable({ h, lines, hide }: { h: Household; lines: ExplainLine[]; hide: boolean }) {
  const { c } = useTheme();
  const num = (cents: number, sign: 'always' | 'auto') => (hide ? '••••' : formatMoney(cents, h.currency, { symbol: false, sign }));
  const cols = { date: 62, change: 78, run: 84 };
  const numStyle = { fontFamily: fonts.semibold, fontSize: 15, textAlign: 'right' as const, fontVariant: ['tabular-nums' as const] };
  return (
    <View style={{ marginTop: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: 28, paddingBottom: 4, borderBottomWidth: 1, borderBottomColor: c.hair }}>
        <View style={{ width: cols.date }} /><View style={{ flex: 1 }} />
        <T style={{ width: cols.change, textAlign: 'right', fontFamily: fonts.semibold, fontSize: 12.5, color: c.ink2 }}>Change</T>
        <T style={{ width: cols.run, textAlign: 'right', fontFamily: fonts.semibold, fontSize: 12.5, color: c.ink2 }}>Balance</T>
      </View>
      {lines.map((l) => {
        const date = l.date ? dayMonth(isoDay(l.date)) : '';
        const change = l.voided ? 'no effect' : num(l.change, 'always');
        return (
          <Press key={l.recordId} noScale onPress={() => openSheet({ type: 'detail', recordId: l.recordId })}
            accessibilityLabel={`${date}, ${l.label}, ${l.detail}, ${l.voided ? 'no effect' : `change ${change}`}, balance ${num(l.running, 'auto')}. Open details`}
            style={{ flexDirection: 'row', alignItems: 'center', minHeight: 58, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: c.hair }}>
            <T style={{ width: cols.date, fontFamily: fonts.medium, fontSize: 13.5, color: c.ink2 }}>{date}</T>
            <View style={{ flex: 1, minWidth: 0, paddingRight: 6 }}>
              <T style={{ fontFamily: fonts.semibold, fontSize: 14.5, letterSpacing: -0.15, color: l.voided ? c.ink2 : c.ink, textDecorationLine: l.voided ? 'line-through' : 'none' }}>{l.label}</T>
              {l.detail ? <T style={{ fontFamily: fonts.medium, fontSize: 12.5, color: c.ink2, marginTop: 1 }}>{l.voided ? 'voided' : l.detail}</T> : null}
            </View>
            <T style={[numStyle, { width: cols.change }, l.voided ? { fontFamily: fonts.medium, fontSize: 13.5, color: c.ink2 } : null]}>{change}</T>
            <T style={[numStyle, { width: cols.run }]}>{num(l.running, 'auto')}</T>
          </Press>
        );
      })}
    </View>
  );
}
