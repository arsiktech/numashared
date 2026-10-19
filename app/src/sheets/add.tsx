// The Add sheet: one sentence ("You paid €52.80 for Groceries") on the payer's color, a keypad,
// and a paper receipt with the split, what it changes, and the orange Add button. The same sheet
// edits an expense (dark "Save changes") and, on a desk, becomes a popover without a keypad.
import { useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { TextInput, View, type TextStyle } from 'react-native';
import { applyKey, categoryLabel, currencyDigits, formatMoney, inputFromCents, parseInput, type Key } from '@/core';
import type { Category, ExpenseContent, Household, ID, LedgerEvent } from '@/core/types';
import { addExpense, groupOfPerson, ledgerOf, reviseExpense, SaveError, yourGroup } from '@/store/store';
import { useUI, type OpenSheet } from '@/store/ui';
import { todayISO } from '@/store/ids';
import { CategoryIcon, Plus, Warn } from '@/ui/icons';
import { BigAmount, Keypad, SplitBar, Word, type SplitSegment } from '@/ui/money-ui';
import { Avatar, Banner, BannerText, CTA, haptic, Press, T, TChip } from '@/ui/primitives';
import { saveGuard, Sheet, SheetScrollView, useSheet } from '@/ui/sheet';
import { isShortSheet, SHORT_KEY_HEIGHT } from '@/features/add/layout';
import { useTheme } from '@/ui/theme';
import { alpha, fonts, isWeb, type GroupTone } from '@/ui/tokens';
import { initials, nameOf, personName, useHousehold } from '@/features/hooks';
import {
  activeGroups, CATEGORIES, changeLine, draftFromSplit, draftShares, equalDraft, isCustom, percentLabel, simulate,
  sizesDiffer, splitFor, standingLine, suggestionsFor, withExactShare, type Line, type SplitDraft, type Suggestion,
} from '@/features/add/draft';
import {
  AfterRow, amountSize, ChipRow, DateRow, Kbd, keyHeight, NoteLine, PersonDot, Receipt, ReceiptHead, SheetTop, useWebKeys,
} from '@/features/add/parts';
import type { SheetProps } from './host';
import { useContract } from '@/sync/contract';

type Draft = {
  payerId: ID;
  input: string;
  category: Category;
  /** False while the category is only a guess from history; it shows muted. */
  catChosen: boolean;
  title: string;
  note: string;
  date: string;
  split: SplitDraft;
  /** The suggestion that filled the draft, until the amount is typed over. */
  sugKey: string | null;
  reason: string | null;
};

type Panel = 'date' | 'payer' | 'category' | 'newcat' | null;

const REASONS = ['Forgot the tip', 'Typo', 'Price changed', 'Other'];

function initialDraft(h: Household, spec: Extract<OpenSheet, { type: 'add' }>): Draft {
  const ledger = ledgerOf(h);
  const e = spec.editRecordId ? ledger.byId[spec.editRecordId]?.expense : undefined;
  if (e) {
    return {
      payerId: e.payerId, input: inputFromCents(e.amount, h.currency), category: e.category, catChosen: true,
      title: e.title ?? '', note: e.note ?? '', date: e.date, split: draftFromSplit(h, e.split, e.amount), sugKey: null, reason: null,
    };
  }
  const preset = spec.preset;
  let category: Category = suggestionsFor(ledger).find((s) => !s.title)?.category ?? 'groceries';
  let title = '';
  let catChosen = false;
  if (preset?.category) {
    if ((CATEGORIES as readonly string[]).includes(preset.category)) category = preset.category as Category;
    else title = preset.category;
    catChosen = true;
  }
  const payerId = preset?.payerId && h.people.some((p) => p.id === preset.payerId) ? preset.payerId : h.youId;
  return { payerId, input: '', category, catChosen, title, note: '', date: todayISO(), split: equalDraft(), sugKey: null, reason: null };
}


export function AddSheet({ spec, onClosed }: SheetProps<'add'>) {
  const { h } = useHousehold();
  useEffect(() => { if (!h) onClosed(); }, [h, onClosed]);
  if (!h) return null;
  return <AddSheetFor h={h} spec={spec} onClosed={onClosed} />;
}

function AddSheetFor({ h, spec, onClosed }: { h: Household } & SheetProps<'add'>) {
  const { tone, layout } = useTheme();
  const [draft, setDraft] = useState(() => initialDraft(h, spec));
  const edit = !!(spec.editRecordId && ledgerOf(h).byId[spec.editRecordId]?.expense);
  const payer = h.people.some((p) => p.id === draft.payerId) ? draft.payerId : h.youId;
  const t = tone(groupOfPerson(h, payer));
  const pop = layout === 'desk' && !!spec.origin;
  return (
    <Sheet origin={spec.origin} onClosed={onClosed} background={t.band} washTo={t.band} popover={pop} height={pop ? 'auto' : 'full'}
      label={edit ? 'Edit expense' : 'New expense'}>
      <AddBody h={h} spec={spec} draft={{ ...draft, payerId: payer }} set={setDraft} t={t} pop={pop} />
    </Sheet>
  );
}

function AddBody({ h, spec, draft, set, t, pop }: {
  h: Household; spec: Extract<OpenSheet, { type: 'add' }>; draft: Draft; set: Dispatch<SetStateAction<Draft>>; t: GroupTone; pop: boolean;
}) {
  const { c, tone, height: screenH, width: screenW } = useTheme();
  const { close } = useSheet();
  const isTop = useUI((u) => u.sheets[u.sheets.length - 1]?.key === spec.key);
  const ledger = ledgerOf(h);
  const original = spec.editRecordId ? ledger.byId[spec.editRecordId]?.expense : undefined;
  const edit = !!original;
  const cur = h.currency;
  // Notes and edit reasons reach other people only once every member can read them (sync/contract.ts).
  const contract = useContract();
  const details = !h.sync || contract.extendedText;
  const amount = parseInput(draft.input, cur) ?? 0;
  const money = (v: number) => formatMoney(v, cur);

  const [panel, setPanel] = useState<Panel>(null);
  const [noteEditing, setNoteEditing] = useState(false);
  const [exact, setExact] = useState<{ id: ID; input: string } | null>(null);
  const [error, setError] = useState<'save' | string | null>(null);
  const [newCat, setNewCat] = useState('');
  const [midH, setMidH] = useState(0);
  const noteRef = useRef<TextInput>(null);
  const saving = saveGuard(spec.key);

  const suggestions = useMemo(() => suggestionsFor(ledger), [ledger]);
  const mine = yourGroup(h);
  const active = activeGroups(h, draft.split);
  const shares = draftShares(h, draft.split, amount);
  const custom = isCustom(h, draft.split, amount);
  const what = draft.title.trim() || categoryLabel(draft.category);

  const content: ExpenseContent = {
    payerId: draft.payerId, amount, date: draft.date, category: draft.category,
    ...(draft.title.trim() ? { title: draft.title.trim() } : {}),
    ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
    split: splitFor(h, draft.split, amount),
  };
  const contentKey = JSON.stringify(content);
  const sim = useMemo(() => {
    if (amount <= 0) return null;
    const base = { id: 'draft-event', at: Date.now(), by: h.youId };
    const event: LedgerEvent = original && spec.editRecordId
      ? { ...base, kind: 'expenseRevised', recordId: spec.editRecordId, content }
      : { ...base, kind: 'expenseAdded', recordId: 'draft-record', content };
    return simulate(h, event);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [h, contentKey]);

  const changed = useMemo(() => {
    if (!original) return true;
    const was: ExpenseContent = {
      payerId: original.payerId, amount: original.amount, date: original.date, category: original.category,
      ...(original.title?.trim() ? { title: original.title.trim() } : {}),
      ...(original.note?.trim() ? { note: original.note.trim() } : {}),
      split: splitFor(h, draftFromSplit(h, original.split, original.amount), original.amount),
    };
    return JSON.stringify(was) !== contentKey;
  }, [h, original, contentKey]);

  const canSave = amount > 0 && !!sim?.ledger && changed;

  // ---------- actions ----------

  const onKey = (k: Key) => {
    if (error && error !== 'save') setError(null);
    if (exact) {
      const next = applyKey(exact.input, k, cur);
      const v = parseInput(next, cur) ?? 0;
      if (v > amount) { haptic.warn(); return; }
      setExact({ id: exact.id, input: next });
      if (next !== '') set((d) => ({ ...d, split: withExactShare(h, d.split, amount, exact.id, v) }));
      return;
    }
    if (panel === 'payer' || panel === 'date') setPanel(null);
    set((d) => ({ ...d, input: applyKey(d.sugKey && k !== 'back' ? '' : d.input, k, cur), sugKey: null }));
  };

  const save = async () => {
    if (saving.current) return;
    if (!canSave) { haptic.warn(); return; }
    saving.current = true;
    try {
      if (original && spec.editRecordId) await reviseExpense(h, spec.editRecordId, content, draft.reason ?? undefined, `${what} edited · ${money(amount)}`);
      else await addExpense(h, content, `${what} added · ${money(amount)}`);
    } catch (e) {
      saving.current = false;
      haptic.warn();
      setError(e instanceof SaveError ? 'save' : e instanceof Error ? e.message : 'save');
      return;
    }
    haptic.medium();
    close();
  };

  const focusNote = () => {
    setPanel((p) => (p === 'payer' || p === 'date' ? null : p));
    setNoteEditing(true);
    setTimeout(() => noteRef.current?.focus(), 0);
  };

  useWebKeys(isTop && panel !== 'newcat', { onKey, onEnter: save, onTab: focusNote });

  const pickSuggestion = (s: Suggestion) => {
    haptic.tick();
    setExact(null);
    if (draft.sugKey === s.key) { set((d) => ({ ...d, sugKey: null, input: '' })); return; }
    set((d) => ({ ...d, category: s.category, title: s.title ?? '', catChosen: true, input: inputFromCents(s.amount, cur), sugKey: s.key }));
  };

  const pickCategory = (cat: Category) => {
    haptic.tick();
    set((d) => ({ ...d, category: cat, title: '', catChosen: true }));
    setPanel(null);
  };

  const commitNewCategory = () => {
    const title = newCat.trim();
    if (title) set((d) => ({ ...d, title, catChosen: true, category: d.catChosen ? d.category : 'other' }));
    setPanel(null);
  };

  const toggleGroup = (id: ID) => {
    if (exact) { setExact(null); return; }
    const out = draft.split.out.includes(id) ? draft.split.out.filter((x) => x !== id) : [...draft.split.out, id];
    if (out.length >= h.groups.length) { haptic.warn(); return; }
    haptic.tick();
    set((d) => ({ ...d, split: { ...d.split, out, custom: null } }));
  };

  const startExact = (id: ID) => {
    if (amount <= 0 || draft.split.out.includes(id) || active.length < 2) { haptic.warn(); return; }
    haptic.tick();
    setPanel(null);
    setExact({ id, input: '' });
  };

  const resetEqual = () => { setExact(null); set((d) => ({ ...d, split: { ...d.split, custom: null } })); };

  // ---------- receipt wording ----------

  const outGroups = h.groups.filter((g) => draft.split.out.includes(g.id));
  let rhead: { left: string; right?: string; onRight?: () => void };
  if (exact || custom) {
    const pct = percentLabel(shares, active.map((g) => g.id), amount);
    rhead = { left: pct ? `Custom split · ${pct}` : 'Custom split', right: 'Reset to equal', onRight: resetEqual };
  } else if (outGroups.length) {
    rhead = {
      left: `Split equally · ${active.length} of ${h.groups.length}`,
      right: outGroups.length === 1 ? `Add ${nameOf(h, outGroups[0])} back` : 'Add everyone back',
      onRight: () => { haptic.tick(); set((d) => ({ ...d, split: { ...d.split, out: [], custom: null } })); },
    };
  } else if (sizesDiffer(h, active)) {
    const byGroup = draft.split.weighting === 'group';
    rhead = {
      left: byGroup ? 'Split equally between groups' : 'Split equally per person',
      right: byGroup ? 'Per person instead' : 'Per group instead',
      onRight: () => { haptic.tick(); set((d) => ({ ...d, split: { ...d.split, weighting: byGroup ? 'person' : 'group', custom: null } })); },
    };
  } else {
    rhead = { left: 'Split equally', right: h.groups.length > 1 && amount > 0 ? 'Drag to change' : undefined };
  }

  const before = ledger.balances[mine.id] ?? 0;
  let afterLeft = 'After this';
  let line: Line;
  if (!sim) { afterLeft = 'Right now'; line = standingLine(h, mine, before); }
  else if (!sim.ledger) { afterLeft = 'Can’t save this yet'; line = { lead: sim.error ?? '', strong: '' }; }
  else {
    const after = sim.ledger.balances[mine.id] ?? 0;
    const ch = edit ? changeLine(h, mine, before, after) : null;
    if (ch) { afterLeft = 'Change'; line = ch; } else line = standingLine(h, mine, after);
  }
  if (!edit && sim?.ledger) {
    if (exact) afterLeft = `Typing ${nameOf(h, exact.id)}’s share`;
    else if (custom) afterLeft = 'Hold a share to type it';
    else if (outGroups.length || h.groups.length > 2) afterLeft = 'Tap a name to leave them out';
  }

  const segments: SplitSegment[] = h.groups.map((g) => ({
    groupId: g.id,
    name: exact?.id === g.id ? `${nameOf(h, g)} · typing` : nameOf(h, g),
    tone: tone(g),
    share: shares[g.id] ?? 0,
    out: draft.split.out.includes(g.id),
  }));

  const ctaLabel = error === 'save' ? 'Try again' : amount <= 0 ? 'Type an amount' : edit ? 'Save changes' : `Add ${money(amount)}`;

  const receipt = (
    <Receipt tone={t} desk={pop}>
      <ReceiptHead left={rhead.left} right={rhead.right} onRight={rhead.onRight} />
      <SplitBar segments={segments} amount={amount} currency={cur} focusId={exact?.id ?? null} height={pop || screenH < 740 ? 50 : 54}
        showKnobs={amount > 0 && !exact} onToggle={toggleGroup} onExact={startExact}
        onShares={(s) => { setExact(null); set((d) => ({ ...d, split: { ...d.split, custom: s, customFor: amount } })); }} />
      <AfterRow left={afterLeft} lead={line.lead} strong={line.strong} />
      {error ? (
        <Banner kind="bad" icon={<Warn size={20} color={c.bad} />}>
          {error === 'save'
            ? <BannerText kind="bad" strong="Couldn’t save just now." rest={`Your ${edit ? 'change' : 'expense'} is still here, and nothing was ${edit ? 'saved' : 'added'} twice.`} />
            : <BannerText kind="bad" strong="This can’t be saved." rest={error} />}
        </Banner>
      ) : null}
      <CTA variant={edit ? 'primary' : 'add'} label={ctaLabel} disabled={!canSave} onPress={save}
        accessibilityLabel={amount > 0 ? (edit ? `Save changes, ${money(amount)}` : `Add ${money(amount)}`) : 'Type an amount first'}
        right={pop && canSave && !edit ? <Kbd paper label="↵" /> : undefined} />
      {pop ? <T style={{ textAlign: 'center', fontSize: 12.5, fontFamily: fonts.medium, color: c.ink2 }}>Type the amount, Tab to the note, Enter to {edit ? 'save' : 'add'}.</T> : null}
    </Receipt>
  );

  // ---------- sentence ----------

  const wordSize = pop ? 24 : screenH < 740 ? 26 : 30;
  const lineStyle = { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: pop ? 44 : wordSize > 26 ? 52 : 46, flexWrap: 'wrap' } as const;
  const sentenceText: TextStyle = { fontFamily: fonts.display, fontSize: wordSize, lineHeight: wordSize * 1.18, letterSpacing: -wordSize * 0.02, color: t.ink };
  const contentW = (pop ? 420 : Math.min(screenW, isWeb ? 560 : screenW)) - 44;
  const amtBase = pop ? 56 : screenH < 740 ? 66 : 84;
  const amtSize = amountSize(amtBase, contentW, formatMoney(amount, cur, { symbol: false }));
  const payerName = personName(h, draft.payerId);
  const payerOpen = panel === 'payer';
  const catOpen = panel === 'category' || panel === 'newcat';

  const sentence = (
    <View>
      <View style={lineStyle}>
        <Word color={t.ink} size={wordSize} open={payerOpen} onPress={() => { haptic.tick(); setPanel(payerOpen ? null : 'payer'); }}
          accessibilityLabel={`Paid by ${payerName}. ${payerOpen ? 'Close the list' : 'Change'}`}
          leading={<Avatar initials={initials(h, draft.payerId)} tone={t} ink size={pop ? 32 : 38} />}>
          {payerName}
        </Word>
        <T style={sentenceText}>paid</T>
      </View>
      <Press noScale onPress={() => { setExact(null); if (catOpen) setPanel(null); }} style={{ alignSelf: 'flex-start', marginTop: pop ? 2 : 4, marginBottom: 2 }}
        accessibilityLabel={`Amount ${money(amount)}${edit && original && amount !== original.amount ? `, was ${money(original.amount)}` : ''}. Type to change`}>
        <BigAmount cents={amount} currency={cur} size={amtSize} color={t.ink} caret={!exact && !noteEditing && panel !== 'newcat'} typed={draft.input} />
      </Press>
      {edit && original && amount !== original.amount ? (
        <T style={{ fontFamily: fonts.semibold, fontSize: 15, color: t.ink, opacity: 0.75, marginTop: -2 }}>
          was <T style={{ fontFamily: fonts.semibold, fontSize: 15, color: t.ink, textDecorationLine: 'line-through' }}>{money(original.amount)}</T>
        </T>
      ) : null}
      <View style={lineStyle}>
        <T style={sentenceText}>for</T>
        <Word color={t.ink} size={wordSize} open={catOpen} placeholder={!draft.catChosen}
          onPress={() => { haptic.tick(); setExact(null); setPanel(catOpen ? null : 'category'); }}
          accessibilityLabel={`Category: ${what}. ${catOpen ? 'Close the list' : 'Change'}`}
          leading={draft.title.trim() ? undefined : <CategoryIcon category={draft.category} size={pop ? 22 : 26} color={draft.catChosen ? t.ink : alpha(t.ink, 0.55)} />}>
          {what}
        </Word>
      </View>
    </View>
  );

  // ---------- rows ----------

  const noteLine = (
    <NoteLine tone={t} value={draft.note} onChange={(note) => set((d) => ({ ...d, note }))} editing={noteEditing} setEditing={setNoteEditing}
      inputRef={noteRef} hint={pop ? 'Tab' : undefined} onSubmit={isWeb ? save : undefined} />
  );

  const people = [...h.people.filter((p) => p.id === h.youId), ...h.people.filter((p) => p.id !== h.youId)];
  const peopleRow = (
    <ChipRow label="Who paid">
      {people.map((p) => {
        const on = p.id === draft.payerId;
        const pt = tone(groupOfPerson(h, p.id));
        return (
          <TChip key={p.id} tone={t} on={on} label={personName(h, p.id)} accessibilityLabel={`${personName(h, p.id)} paid`}
            leading={<PersonDot fill={pt.band} ring={on ? t.band : t.ink} />}
            onPress={() => { haptic.tick(); set((d) => ({ ...d, payerId: p.id })); }} />
        );
      })}
    </ChipRow>
  );

  const reasonRow = (
    <ChipRow label="Why the change">
      {REASONS.map((r) => (
        <TChip key={r} tone={t} label={r} on={draft.reason === r} accessibilityLabel={`Reason: ${r}`}
          onPress={() => { haptic.tick(); set((d) => ({ ...d, reason: d.reason === r ? null : r })); }} />
      ))}
    </ChipRow>
  );

  const suggestionRow = (
    <ChipRow label="Recent expenses">
      {suggestions.map((s) => (
        <TChip key={s.key} tone={t} on={draft.sugKey === s.key} label={s.label} amount={formatMoney(s.amount, cur, { fraction: 'auto' })}
          accessibilityLabel={`${s.label}, ${money(s.amount)}`} onPress={() => pickSuggestion(s)} />
      ))}
    </ChipRow>
  );

  const showSuggestions = suggestions.length > 0 && (draft.input === '' || draft.sugKey !== null);
  const dateRow = <DateRow tone={t} date={draft.date} onPick={(date) => { haptic.tick(); set((d) => ({ ...d, date })); setPanel(null); }} />;

  const grid = <CategoryGrid tone={t} value={draft.title.trim() ? null : draft.category} custom={!!draft.title.trim()} compact={pop}
    onPick={pickCategory} onNew={() => { setNewCat(draft.title); setPanel('newcat'); }} />;
  const newField = <NewCategory tone={t} value={newCat} onChange={setNewCat} onDone={commitNewCategory} onBack={() => setPanel('category')} />;

  const head = (
    <SheetTop title={edit ? 'Edit expense' : 'New expense'} tone={t} onCancel={() => close()} date={draft.date}
      dateOpen={panel === 'date'} onDate={() => { haptic.tick(); setPanel(panel === 'date' ? null : 'date'); }} desk={pop} />
  );

  if (pop) {
    let row: ReactNode = null;
    if (panel === 'date') row = dateRow;
    else if (panel === 'payer') row = peopleRow;
    else if (panel === 'category') row = grid;
    else if (panel === 'newcat') row = newField;
    else if (edit && details) row = reasonRow;
    else if (suggestions.length) row = suggestionRow;
    return (
      <View>
        {head}
        <View style={{ paddingHorizontal: 24, paddingTop: 6 }}>
          {sentence}
          {details ? <View style={{ marginTop: 10 }}>{noteLine}</View> : null}
          {row ? <View style={{ marginTop: 12 }}>{row}</View> : null}
        </View>
        {receipt}
      </View>
    );
  }

  let slot: ReactNode;
  if (panel === 'date') slot = dateRow;
  else if (panel === 'payer') slot = peopleRow;
  else if (details && (catOpen || noteEditing)) slot = noteLine;
  else if (edit && details) slot = reasonRow;
  else if (showSuggestions) slot = suggestionRow;
  else slot = details ? noteLine : null;

  const keypadArea = panel === 'category' ? <View style={{ paddingHorizontal: 10, paddingTop: 6 }}>{grid}</View>
    : panel === 'newcat' ? <View style={{ paddingHorizontal: 10, paddingTop: 6 }}>{newField}</View>
    : null;

  // Short screens (a phone in landscape): everything scrolls, with a keypad of fixed height, so
  // the keypad and Save are never cut off.
  if (isShortSheet(screenH)) {
    return (
      <View style={{ flex: 1 }}>
        {head}
        <SheetScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 12 }} keyboardShouldPersistTaps="handled">
          <View style={{ paddingHorizontal: 22, paddingTop: 6 }}>
            {sentence}
            <View style={{ marginTop: 12 }}>{slot}</View>
          </View>
          <View style={{ paddingHorizontal: 12, paddingTop: 8 }}>
            {keypadArea ?? <Keypad onKey={(k) => onKey(k as Key)} color={t.ink} height={SHORT_KEY_HEIGHT} allowDot={currencyDigits(cur) > 0} />}
          </View>
          {receipt}
        </SheetScrollView>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      {head}
      <View style={{ paddingHorizontal: 22, paddingTop: 6 }}>
        {sentence}
        <View style={{ marginTop: 12 }}>{slot}</View>
      </View>
      <View style={{ flex: 1, minHeight: 0, overflow: 'hidden', justifyContent: panel === 'category' || panel === 'newcat' ? 'flex-start' : 'flex-end', paddingHorizontal: 12, paddingTop: 8 }} onLayout={(e) => setMidH(e.nativeEvent.layout.height)}>
        {panel === 'category' ? <View style={{ paddingHorizontal: 10, paddingTop: 6 }}>{grid}</View>
          : panel === 'newcat' ? <View style={{ paddingHorizontal: 10, paddingTop: 6 }}>{newField}</View>
          : <Keypad onKey={(k) => onKey(k as Key)} color={t.ink} height={keyHeight(screenH, midH)} allowDot={currencyDigits(cur) > 0} />}
      </View>
      {receipt}
    </View>
  );
}

// ---------- category picker ----------

function CategoryGrid({ tone: t, value, custom, onPick, onNew, compact }: {
  tone: GroupTone; value: Category | null; custom: boolean; onPick: (c: Category) => void; onNew: () => void; compact?: boolean;
}) {
  const h = compact ? 56 : 66;
  const cell = { flexBasis: '30%', flexGrow: 1, height: h, borderRadius: 16, alignItems: 'center', justifyContent: 'center', gap: 5 } as const;
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel="Category" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {CATEGORIES.map((cat) => {
        const on = value === cat;
        return (
          <Press key={cat} accessibilityRole="radio" accessibilityState={{ checked: on }} accessibilityLabel={categoryLabel(cat)} onPress={() => onPick(cat)}
            style={[cell, { backgroundColor: on ? t.ink : alpha(t.ink, 0.09) }]}>
            <CategoryIcon category={cat} size={22} color={on ? t.band : t.ink} />
            <T style={{ fontFamily: fonts.semibold, fontSize: 13.5, color: on ? t.band : t.ink }}>{categoryLabel(cat)}</T>
          </Press>
        );
      })}
      <Press accessibilityRole="radio" accessibilityState={{ checked: custom }} accessibilityLabel="New category: type your own name" onPress={onNew}
        style={[cell, custom ? { backgroundColor: t.ink } : { borderWidth: 1.5, borderColor: alpha(t.ink, 0.35) }]}>
        <Plus size={22} color={custom ? t.band : t.ink} />
        <T style={{ fontFamily: fonts.semibold, fontSize: 13.5, color: custom ? t.band : t.ink }}>New category</T>
      </Press>
    </View>
  );
}

function NewCategory({ tone: t, value, onChange, onDone, onBack }: {
  tone: GroupTone; value: string; onChange: (v: string) => void; onDone: () => void; onBack: () => void;
}) {
  return (
    <View style={{ gap: 10 }}>
      <T style={{ fontFamily: fonts.semibold, fontSize: 14, color: t.ink }}>Name it</T>
      <View style={{ minHeight: 48, borderRadius: 14, paddingHorizontal: 14, justifyContent: 'center', backgroundColor: alpha(t.ink, 0.09) }}>
        <TextInput value={value} onChangeText={onChange} autoFocus placeholder="Pizza night" placeholderTextColor={alpha(t.ink, 0.55)} maxLength={40}
          accessibilityLabel="Category name" returnKeyType="done" onSubmitEditing={onDone}
          style={[{ minHeight: 48, fontFamily: fonts.semibold, fontSize: 18, color: t.ink, paddingVertical: 0 }, isWeb ? ({ outlineStyle: 'none' } as object) : null]} />
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <TChip tone={t} on label="Done" onPress={onDone} />
        <TChip tone={t} label="Back to categories" onPress={onBack} />
      </View>
    </View>
  );
}
