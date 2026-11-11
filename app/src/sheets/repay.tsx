// Record a repayment: "You + Sam paid Alex + Jo €40.00" on the paying group's color, with quick
// amounts, how it was paid, a note, and a receipt that says what is left. Numa Shared never moves money.
import { useEffect, useMemo, useRef, useState } from 'react';
import { TextInput, View, type TextStyle } from 'react-native';
import { applyKey, currencyDigits, isPlural, formatMoney, inputFromCents, parseInput, planSettlement, type Key } from '@/core';
import type { Household, ID, PaymentMethod, SettlementContent } from '@/core/types';
import { getState, ledgerOf, recordSettlement, SaveError, activeHousehold, yourGroup } from '@/store/store';
import { celebrate, showToast, useUI, type OpenSheet } from '@/store/ui';
import { todayISO } from '@/store/ids';
import { Warn } from '@/ui/icons';
import { BigAmount, Keypad, Word } from '@/ui/money-ui';
import { Banner, BannerText, CTA, haptic, T, TChip } from '@/ui/primitives';
import { saveGuard, Sheet, SheetScrollView, useSheet } from '@/ui/sheet';
import { useTheme } from '@/ui/theme';
import { fonts, isWeb, type GroupTone } from '@/ui/tokens';
import { nameOf, useHousehold } from '@/features/hooks';
import { simulate, spokenName, standingLine, type Line } from '@/features/add/draft';
import {
  AfterRow, amountSize, ChipRow, DateRow, GroupAvatar, keyHeight, NoteLine, PersonDot, Receipt, ReceiptHead, SheetTop, useWebKeys,
} from '@/features/add/parts';
import type { SheetProps } from './host';
import { useContract } from '@/sync/contract';

type Spec = Extract<OpenSheet, { type: 'repay' }>;

/** What the paying group owes the other one in the current plan, or 0. */
function owedBetween(h: Household, from: ID, to: ID): number {
  const plan = planSettlement(ledgerOf(h).balances);
  if (plan.status !== 'exact') return 0;
  return plan.transfers.find((t) => t.fromGroupId === from && t.toGroupId === to)?.amount ?? 0;
}

function initialGroups(h: Household, spec: Spec): { from: ID; to: ID } {
  const mine = yourGroup(h);
  const has = (id?: ID) => !!id && h.groups.some((g) => g.id === id);
  if (has(spec.fromGroupId) && has(spec.toGroupId) && spec.fromGroupId !== spec.toGroupId) return { from: spec.fromGroupId!, to: spec.toGroupId! };
  const plan = planSettlement(ledgerOf(h).balances);
  const mineT = plan.status === 'exact' ? plan.transfers.find((t) => t.fromGroupId === mine.id || t.toGroupId === mine.id) : undefined;
  if (mineT) return { from: mineT.fromGroupId, to: mineT.toGroupId };
  const other = h.groups.find((g) => g.id !== mine.id) ?? mine;
  return { from: has(spec.fromGroupId) ? spec.fromGroupId! : mine.id, to: other.id };
}

export function RepaySheet({ spec, onClosed }: SheetProps<'repay'>) {
  const { h } = useHousehold();
  const ok = !!h && h.groups.length > 1;
  useEffect(() => { if (!ok) onClosed(); }, [ok, onClosed]);
  if (!h || !ok) return null;
  return <RepayFor h={h} spec={spec} onClosed={onClosed} />;
}

function RepayFor({ h, spec, onClosed }: { h: Household } & SheetProps<'repay'>) {
  const { tone } = useTheme();
  const [groups, setGroups] = useState(() => initialGroups(h, spec));
  const from = h.groups.find((g) => g.id === groups.from) ?? h.groups[0];
  const t = tone(from);
  return (
    <Sheet origin={spec.origin} onClosed={onClosed} background={t.band} washTo={t.band} label="Record a repayment">
      <RepayBody h={h} spec={spec} groups={groups} setGroups={setGroups} t={t} />
    </Sheet>
  );
}

const METHODS: { id: PaymentMethod; label: string; eurOnly?: boolean }[] = [
  { id: 'bizum', label: 'Bizum', eurOnly: true },
  { id: 'bank', label: 'Bank transfer' },
  { id: 'cash', label: 'Cash' },
];

function RepayBody({ h, spec, groups, setGroups, t }: {
  h: Household; spec: Spec; groups: { from: ID; to: ID }; setGroups: (g: { from: ID; to: ID }) => void; t: GroupTone;
}) {
  const { c, tone, height: screenH, width: screenW } = useTheme();
  const { close } = useSheet();
  const isTop = useUI((u) => u.sheets[u.sheets.length - 1]?.key === spec.key);
  const cur = h.currency;
  // How it was paid reaches other people only once every member can read it (sync/contract.ts).
  const contract = useContract();
  const details = !h.sync || contract.extendedText;
  const money = (v: number) => formatMoney(v, cur);
  const from = h.groups.find((g) => g.id === groups.from)!;
  const to = h.groups.find((g) => g.id === groups.to)!;
  const owed = useMemo(() => owedBetween(h, from.id, to.id), [h, from.id, to.id]);
  const half = Math.floor(owed / 2);

  const [input, setInput] = useState(() => {
    const start = spec.amount && spec.fromGroupId === groups.from && spec.toGroupId === groups.to ? spec.amount : owed;
    return start > 0 ? inputFromCents(start, cur) : '';
  });
  const [other, setOther] = useState(false);
  const [method, setMethod] = useState<PaymentMethod | null>(null);
  const [note, setNote] = useState('');
  const [date, setDate] = useState(todayISO());
  const [panel, setPanel] = useState<'from' | 'to' | 'date' | null>(null);
  const [noteEditing, setNoteEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [midH, setMidH] = useState(0);
  const noteRef = useRef<TextInput>(null);
  const saving = saveGuard(spec.key);

  const amount = parseInput(input, cur) ?? 0;
  const content: SettlementContent = {
    fromGroupId: from.id, toGroupId: to.id, amount, date,
    ...(method ? { method } : {}),
    ...(note.trim() ? { note: note.trim() } : {}),
  };
  const key = JSON.stringify(content);
  const sim = useMemo(() => (amount > 0
    ? simulate(h, { id: 'draft-event', at: Date.now(), by: h.youId, kind: 'settlementRecorded', recordId: 'draft-record', content })
    : null
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [h, key]);
  const canSave = amount > 0 && !!sim?.ledger;

  const onKey = (k: Key) => {
    if (panel) setPanel(null);
    setOther(true);
    setInput((v) => applyKey(v, k, cur));
  };

  const pickGroup = (side: 'from' | 'to', id: ID) => {
    haptic.tick();
    const next = side === 'from'
      ? { from: id, to: id === groups.to ? groups.from : groups.to }
      : { to: id, from: id === groups.from ? groups.to : groups.from };
    setGroups(next);
    const nextOwed = owedBetween(h, next.from, next.to);
    setInput(nextOwed > 0 ? inputFromCents(nextOwed, cur) : '');
    setOther(false);
    setPanel(null);
  };

  const save = async () => {
    if (saving.current) return;
    if (!canSave) { haptic.warn(); return; }
    saving.current = true;
    try {
      await recordSettlement(h, content, `Repayment recorded · ${money(amount)}`);
    } catch (e) {
      saving.current = false;
      haptic.warn();
      setError(e instanceof SaveError ? 'save' : e instanceof Error ? e.message : 'save');
      return;
    }
    haptic.medium();
    const now = getState();
    const fresh = activeHousehold(now);
    const square = !!fresh && Object.values(ledgerOf(fresh).balances).every((v) => v === 0);
    close();
    if (square) celebrate();
    else showToast(`Recorded. ${line.lead} ${line.strong}`.trim());
  };

  const focusNote = () => { setPanel(null); setNoteEditing(true); setTimeout(() => noteRef.current?.focus(), 0); };
  useWebKeys(isTop, { onKey, onEnter: save, onTab: details ? focusNote : undefined });

  // ---------- wording ----------

  let headText = 'Numa Shared only records it.';
  if (owed > 0 && amount > 0 && amount < owed) headText = `Part of ${money(owed)}. Numa Shared only records it.`;
  else if (owed > 0 && amount > owed) headText = `More than the ${money(owed)} owed. Numa Shared only records it.`;

  let line: Line = { lead: '', strong: '' };
  let afterLeft = 'After this';
  if (sim?.ledger) {
    const bal = sim.ledger.balances;
    const fb = bal[from.id] ?? 0;
    if (Object.values(bal).every((v) => v === 0)) line = { lead: '', strong: 'All square ✓' };
    else if (fb < 0) {
      const s = standingLine(h, from, fb);
      line = { lead: s.lead.replace(/ (owe|owes)$/, ' still $1'), strong: s.strong };
    } else if (fb === 0) line = { lead: `${nameOf(h, from)} ${isPlural(from, h.people, h.youId) ? 'are' : 'is'} square`, strong: '✓' };
    else line = standingLine(h, from, fb);
  } else if (sim?.error) {
    afterLeft = 'Can’t save this yet';
    line = { lead: sim.error, strong: '' };
  } else {
    afterLeft = 'Right now';
    const fb = ledgerOf(h).balances[from.id] ?? 0;
    line = standingLine(h, from, fb);
  }

  // ---------- layout ----------

  const wordSize = screenH < 740 ? 26 : 30;
  const sentenceText: TextStyle = { fontFamily: fonts.display, fontSize: wordSize, lineHeight: wordSize * 1.18, letterSpacing: -wordSize * 0.02, color: t.ink };
  const lineStyle = { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: wordSize > 26 ? 52 : 46, flexWrap: 'wrap' } as const;
  const contentW = Math.min(screenW, isWeb ? 560 : screenW) - 44;
  const amtSize = amountSize(screenH < 740 ? 54 : 66, contentW, formatMoney(amount, cur, { symbol: false }));
  const allOn = !other && owed > 0 && amount === owed;
  const halfOn = !other && owed > 0 && amount === half;

  const groupRow = (side: 'from' | 'to') => (
    <ChipRow label={side === 'from' ? 'Who paid' : 'Who was paid'}>
      {h.groups.map((g) => {
        const on = g.id === (side === 'from' ? from.id : to.id);
        return (
          <TChip key={g.id} tone={t} on={on} label={nameOf(h, g)} accessibilityLabel={spokenName(h, g)}
            leading={<PersonDot fill={tone(g).band} ring={on ? t.band : t.ink} />} onPress={() => pickGroup(side, g.id)} />
        );
      })}
    </ChipRow>
  );

  let slot;
  if (panel === 'date') slot = <DateRow tone={t} date={date} onPick={(d, stayOpen) => { haptic.tick(); setDate(d); if (!stayOpen) setPanel(null); }} />;
  else if (panel === 'from' || panel === 'to') slot = groupRow(panel);
  else slot = owed > 0 ? (
    <ChipRow label="How much">
      <TChip tone={t} label="All of it" amount={money(owed)} on={allOn} onPress={() => { haptic.tick(); setOther(false); setInput(inputFromCents(owed, cur)); }} />
      {half > 0 ? <TChip tone={t} label="Half" amount={money(half)} on={halfOn} onPress={() => { haptic.tick(); setOther(false); setInput(inputFromCents(half, cur)); }} /> : null}
      <TChip tone={t} label="Other" on={!allOn && !halfOn} onPress={() => { haptic.tick(); setOther(true); setInput(''); }} />
    </ChipRow>
  ) : null;

  const Body = isWeb ? SheetScrollView : View;
  return (
    <Body style={{ flex: 1 }} {...(isWeb ? { contentContainerStyle: { flexGrow: 1 }, keyboardShouldPersistTaps: 'handled' as const } : {})}>
      <SheetTop title="Record a repayment" tone={t} onCancel={() => close()} date={date} dateOpen={panel === 'date'}
        onDate={() => { haptic.tick(); setPanel(panel === 'date' ? null : 'date'); }} />
      <View style={{ paddingHorizontal: 22, paddingTop: 6 }}>
        <View style={lineStyle}>
          <Word color={t.ink} size={wordSize} open={panel === 'from'} onPress={() => { haptic.tick(); setPanel(panel === 'from' ? null : 'from'); }}
            accessibilityLabel={`Paid by ${spokenName(h, from)}. ${panel === 'from' ? 'Close the list' : 'Change'}`}
            leading={<GroupAvatar h={h} group={from} tone={t} ink />}>
            {nameOf(h, from)}
          </Word>
          <T style={sentenceText}>paid</T>
        </View>
        <View style={lineStyle}>
          <Word color={t.ink} size={wordSize} chevron={false} open={panel === 'to'} onPress={() => { haptic.tick(); setPanel(panel === 'to' ? null : 'to'); }}
            accessibilityLabel={`To ${spokenName(h, to)}. ${panel === 'to' ? 'Close the list' : 'Change'}`}
            leading={<GroupAvatar h={h} group={to} tone={tone(to)} />}>
            {nameOf(h, to)}
          </Word>
        </View>
        <View accessible accessibilityLabel={`Amount ${money(amount)}`} style={{ marginTop: 2 }}>
          <BigAmount cents={amount} currency={cur} size={amtSize} color={t.ink} caret={!noteEditing} typed={input} />
        </View>
        {slot ? <View style={{ marginTop: 10 }}>{slot}</View> : null}
        {details ? <>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: 12, marginBottom: 6 }}>
          <T style={{ fontFamily: fonts.semibold, fontSize: 13, color: t.ink }}>How did you pay?</T>
          <T style={{ fontSize: 13, color: t.ink, opacity: 0.7 }}>optional</T>
        </View>
        <ChipRow label="How it was paid">
          {METHODS.filter((m) => !m.eurOnly || cur === 'EUR').map((m) => (
            <TChip key={m.id} tone={t} label={m.label} on={method === m.id} onPress={() => { haptic.tick(); setMethod(method === m.id ? null : m.id); }} />
          ))}
        </ChipRow>
        <NoteLine tone={t} value={note} onChange={setNote} editing={noteEditing} setEditing={setNoteEditing} inputRef={noteRef}
          style={{ marginTop: 10 }} onSubmit={isWeb ? save : undefined} />
        </> : null}
      </View>
      <View style={{ flex: isWeb ? undefined : 1, flexGrow: 1, minHeight: 0, overflow: 'hidden', justifyContent: 'flex-end', paddingHorizontal: 12, paddingTop: 6 }} onLayout={(e) => setMidH(e.nativeEvent.layout.height)}>
        <Keypad onKey={(k) => onKey(k as Key)} color={t.ink} height={keyHeight(screenH * 0.9, isWeb ? 0 : midH)} allowDot={currencyDigits(cur) > 0} />
      </View>
      <Receipt tone={t}>
        <ReceiptHead left={headText} />
        <AfterRow left={afterLeft} lead={line.lead} strong={line.strong} />
        {error ? (
          <Banner kind="bad" icon={<Warn size={20} color={c.bad} />}>
            {error === 'save'
              ? <BannerText kind="bad" strong="Couldn’t save just now." rest="Your repayment is still here, and nothing was recorded twice." />
              : <BannerText kind="bad" strong="This can’t be saved." rest={error} />}
          </Banner>
        ) : null}
        <CTA label={error === 'save' ? 'Try again' : amount > 0 ? `Record ${money(amount)} repaid` : 'Type an amount'} disabled={!canSave} onPress={save} />
      </Receipt>
    </Body>
  );
}

