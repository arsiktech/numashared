// The whole story of one record: what it is, how it was split, and every change with its time.
// Used inside the phone detail sheet ('sheet') and as Home's right pane on a desk ('panel').
// Nothing here erases anything: Edit appends a revision, Void and Restore append events.
import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { categoryLabel, explain, shares } from '@/core';
import type { Household, ID, Ledger, LedgerRecord, TimelineEntry } from '@/core/types';
import { groupOfPerson, restoreRecord, SaveError } from '@/store/store';
import { openSheet, replaceSheet, showToast, type SheetSpec } from '@/store/ui';
import { CategoryIcon, Close, House, Pencil, Repay, VoidX, ArrowRight } from '@/ui/icons';
import { Badge, Banner, BannerText, Dot, Press, T, TextButton } from '@/ui/primitives';
import { useSheet } from '@/ui/sheet';
import { useTheme } from '@/ui/theme';
import { fonts, isAndroid, isWeb } from '@/ui/tokens';
import { clock, money, nameOf, personName, recordTitle, useHousehold } from '../hooks';
import { dayMonth, fullDay, isoDay, joinNames, METHOD_LABEL, splitLabel, weekday } from '../history/model';

type Variant = 'sheet' | 'panel';

export function RecordDetail({ recordId, variant, onClose }: { recordId: ID; variant: Variant; onClose?: () => void }) {
  const { h, ledger, hide } = useHousehold();
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const sheet = useSheet();
  const close = onClose ?? (() => sheet.close());
  const r = ledger?.byId[recordId];
  if (!h || !ledger || !r) {
    return (
      <View style={{ padding: 24, gap: 8 }}>
        <T style={{ fontFamily: fonts.bold, fontSize: 18 }}>This record isn’t here</T>
        <T style={{ color: c.ink2 }}>It may belong to another household.</T>
        <TextButton label="Close" bold onPress={close} />
      </View>
    );
  }
  const panel = variant === 'panel';
  // Edit and Void replace the detail sheet on a phone; on a desk the pane stays and a sheet opens.
  const go = (spec: SheetSpec) => (panel ? openSheet(spec) : replaceSheet(spec));
  const restore = async () => {
    try {
      await restoreRecord(h, r.id, `Restored “${recordTitle(r)}”`);
      showToast(`Restored “${recordTitle(r)}”`);
    } catch (e) {
      showToast(e instanceof SaveError ? e.message : 'Couldn’t restore it. Try again.');
    }
  };
  const actions: Actions = {
    edit: () => go({ type: 'add', editRecordId: r.id }),
    void: () => openSheet({ type: 'void', recordId: r.id }),
    flag: () => openSheet({ type: 'flag', recordId: r.id }),
    restore,
  };
  const kindName = r.kind === 'expense' ? 'Expense' : r.kind === 'settlement' ? 'Repayment' : 'Opening balance';
  const androidIcons = isAndroid && !panel && r.kind === 'expense' && !r.voided;

  const body = r.kind === 'expense' ? <ExpenseBody h={h} r={r} hide={hide} panel={panel} />
    : r.kind === 'settlement' ? <RepayBody h={h} r={r} ledger={ledger} hide={hide} panel={panel} />
      : <OpeningBody h={h} r={r} hide={hide} panel={panel} />;
  const partial = r.kind === 'settlement' && partialInfo(h, r, ledger).partial;
  const titleRow = <TitleRow h={h} r={r} panel={panel} partial={partial} onClose={close} />;
  const foot = <Footer r={r} panel={panel} actions={actions} hideButtons={androidIcons} />;

  if (panel) {
    return (
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 24, paddingTop: 20 }} accessibilityLabel={`${kindName}: ${recordTitle(r)}`}>
        {titleRow}
        {body}
        {foot}
      </ScrollView>
    );
  }
  return (
    <View style={{ flex: 1 }}>
      {isAndroid ? (
        <View style={{ height: 56, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, gap: 4 }}>
          <Press accessibilityLabel="Close" onPress={close} style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center' }}>
            <Close size={22} color={c.ink} />
          </Press>
          <T accessibilityRole="header" style={{ flex: 1, fontFamily: fonts.semibold, fontSize: 22, paddingLeft: 4 }}>{kindName}</T>
          {androidIcons ? (
            <>
              <Press accessibilityLabel="Edit" onPress={actions.edit} style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center' }}><Pencil size={20} color={c.ink} /></Press>
              <Press accessibilityLabel="Void" onPress={actions.void} style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center' }}><VoidX size={20} color={c.ink} /></Press>
            </>
          ) : null}
        </View>
      ) : (
        <View style={{ height: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', paddingHorizontal: 10 }}>
          <TextButton label="Done" bold onPress={close} />
        </View>
      )}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: isAndroid ? 20 : 22, paddingTop: 8, paddingBottom: 10 }}>
        {titleRow}
        {body}
      </ScrollView>
      <View style={{ paddingHorizontal: 22, paddingTop: 4, paddingBottom: Math.max(insets.bottom, 12) + 4 }}>{foot}</View>
    </View>
  );
}

type Actions = { edit: () => void; void: () => void; flag: () => void; restore: () => void };

// ---------- header ----------

function TitleRow({ h, r, panel, partial, onClose }: { h: Household; r: LedgerRecord; panel: boolean; partial: boolean; onClose: () => void }) {
  const { c, tone } = useTheme();
  let bg = c.chip, fg = c.ink, icon: ReactNode = <House size={20} color={c.ink} />;
  if (r.kind === 'expense') {
    const t = tone(groupOfPerson(h, r.expense!.payerId));
    bg = r.voided ? c.chip : t.band; fg = r.voided ? c.ink3 : t.ink;
    icon = <CategoryIcon category={r.expense!.category} size={20} color={fg} />;
  } else if (r.kind === 'settlement') {
    bg = c.ink; fg = c.bg; icon = <Repay size={20} color={c.bg} />;
  }
  const size = isAndroid && !panel ? 48 : 40;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>{icon}</View>
      <T accessibilityRole="header" style={{ flex: 1, minWidth: 0, fontFamily: fonts.bold, fontSize: isAndroid && !panel ? 22 : 20, letterSpacing: -0.2,
        textDecorationLine: r.voided ? 'line-through' : 'none', color: r.voided ? c.ink2 : c.ink }}>
        {r.kind === 'settlement' ? 'Repayment' : recordTitle(r)}
      </T>
      {partial && !panel ? <Badge label="Partial" /> : null}
      {panel ? (
        <Press accessibilityLabel="Close detail" onPress={onClose} style={{ width: 44, height: 44, marginRight: -10, alignItems: 'center', justifyContent: 'center' }}>
          <Close size={22} color={c.ink} />
        </Press>
      ) : null}
    </View>
  );
}

function Amount({ value, panel, badges }: { value: string; panel: boolean; badges: ReactNode }) {
  const size = panel ? 56 : 64;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 14, flexWrap: 'wrap' }}>
      <T numberOfLines={1} adjustsFontSizeToFit style={{ fontFamily: fonts.cond, fontSize: size, lineHeight: size * 1.05, letterSpacing: -1, fontVariant: ['tabular-nums'], flexShrink: 1 }}>{value}</T>
      {badges}
    </View>
  );
}

function Meta({ children }: { children: ReactNode }) {
  const { c } = useTheme();
  return <T style={{ fontSize: isAndroid ? 15 : 14, lineHeight: 19, color: c.ink2, marginTop: 6 }}>{children}</T>;
}

function Quote({ text, by }: { text: string; by: string }) {
  const { c } = useTheme();
  return (
    <View style={{ marginTop: 12, borderRadius: 16, backgroundColor: c.card, borderWidth: 1, borderColor: c.hair, paddingHorizontal: 14, paddingVertical: 12 }}>
      <T style={{ fontSize: 15.5, lineHeight: 22 }}>“{text}”</T>
      <T style={{ fontFamily: fonts.semibold, fontSize: 12.5, color: c.ink2, marginTop: 4 }}>Note from {by}</T>
    </View>
  );
}

// ---------- bodies ----------

function ExpenseBody({ h, r, hide, panel }: { h: Household; r: LedgerRecord; hide: boolean; panel: boolean }) {
  const { tone } = useTheme();
  const e = r.expense!;
  const edited = r.revisions.length > 1;
  let split: { id: ID; share: number }[] = [];
  try {
    const s = shares(e, h.groups, h.people);
    split = h.groups.filter((g) => (s[g.id] ?? 0) > 0).map((g) => ({ id: g.id, share: s[g.id] }));
  } catch { split = []; }
  const noteBy = personName(h, firstRevisionWithNote(r) ?? r.createdBy);
  return (
    <View>
      <Amount value={money(h, e.amount, hide)} panel={panel}
        badges={<>{edited ? <Badge label="Edited" /> : null}{r.voided ? <Badge label="Voided" kind="void" /> : null}</>} />
      <Meta>{[categoryLabel(e.category), `${personName(h, e.payerId)} paid`, splitLabel(r), longDate(e.date)].join(' · ')}</Meta>
      {e.note ? <Quote text={e.note} by={noteBy} /> : null}
      {split.length ? (
        <View style={{ flexDirection: 'row', gap: 3, height: 44, marginTop: 16, opacity: r.voided ? 0.5 : 1 }}
          accessibilityLabel={`Split: ${split.map((s) => `${nameOf(h, s.id)} ${money(h, s.share, hide)}`).join(', ')}`}>
          {split.map((s) => {
            const t = tone(h.groups.find((g) => g.id === s.id)!);
            const row = isAndroid && !panel;
            return (
              <View key={s.id} style={{ flexGrow: s.share, flexBasis: 0, minWidth: 72, borderRadius: 10, backgroundColor: t.band, paddingHorizontal: 12,
                justifyContent: row ? 'space-between' : 'center', alignItems: row ? 'center' : undefined, flexDirection: row ? 'row' : 'column', overflow: 'hidden' }}>
                <T numberOfLines={1} style={{ fontFamily: fonts.semibold, fontSize: 13, color: t.ink }}>{nameOf(h, s.id)}</T>
                <T numberOfLines={1} style={{ fontFamily: fonts.bold, fontSize: 16, color: t.ink, fontVariant: ['tabular-nums'] }}>{money(h, s.share, hide)}</T>
              </View>
            );
          })}
        </View>
      ) : null}
      <Timeline h={h} r={r} hide={hide} panel={panel} />
    </View>
  );
}

/** Whether a repayment covered less than its payer owed just before it, from the explain lines. */
function partialInfo(h: Household, r: LedgerRecord, ledger: Ledger) {
  const s = r.settlement!;
  const line = explain(ledger, h, s.fromGroupId).find((l) => l.recordId === r.id);
  const before = line ? line.running - line.change : 0;
  const owed = Math.max(0, -before);
  return { owed, partial: owed > s.amount, left: Math.max(0, owed - s.amount) };
}

function RepayBody({ h, r, ledger, hide, panel }: { h: Household; r: LedgerRecord; ledger: Ledger; hide: boolean; panel: boolean }) {
  const { c, tone } = useTheme();
  const s = r.settlement!;
  const from = h.groups.find((g) => g.id === s.fromGroupId)!;
  const to = h.groups.find((g) => g.id === s.toGroupId)!;
  const p = partialInfo(h, r, ledger);
  const pct = p.owed ? Math.min(100, Math.round((s.amount / p.owed) * 100)) : 100;
  const flag = [...r.timeline].reverse().find((t) => t.type === 'flagged');
  return (
    <View>
      <Amount value={money(h, s.amount, hide)} panel={panel}
        badges={<>{p.partial && panel ? <Badge label="Partial" /> : null}{r.flagged ? <Badge label="Flagged" kind="pending" /> : null}{r.voided ? <Badge label="Voided" kind="void" /> : null}</>} />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' }}
        accessibilityLabel={`${nameOf(h, from)} paid ${nameOf(h, to)}`}>
        <Dot color={tone(from).deep} />
        <T style={{ fontFamily: fonts.semibold, fontSize: 15 }}>{nameOf(h, from)}</T>
        <ArrowRight size={16} color={c.ink} />
        <Dot color={tone(to).deep} />
        <T style={{ fontFamily: fonts.semibold, fontSize: 15 }}>{nameOf(h, to)}</T>
      </View>
      <Meta>{[s.method ? METHOD_LABEL[s.method] : null, `${longDate(s.date)}, ${clock(r.createdAt)}`].filter(Boolean).join(' · ')}</Meta>
      {s.note ? <Quote text={s.note} by={personName(h, r.createdBy)} /> : null}
      {p.partial && !hide ? (
        <View style={{ marginTop: 18 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
            <T style={{ fontSize: 14, color: c.ink2 }}>{money(h, s.amount)} of {money(h, p.owed)} repaid</T>
            <T style={{ fontSize: 14, fontFamily: fonts.bold }}>{money(h, p.left)} still owed</T>
          </View>
          <View style={{ height: 10, borderRadius: 5, backgroundColor: c.chip2, overflow: 'hidden' }}
            accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: pct }}>
            <View style={{ width: `${pct}%`, height: '100%', borderRadius: 5, backgroundColor: tone(from).band }} />
          </View>
        </View>
      ) : null}
      {r.flagged && flag && flag.type === 'flagged' ? (
        <View style={{ marginTop: 16 }}>
          <Banner kind="warn">
            <BannerText kind="warn" strong={`Flagged by ${personName(h, flag.by)}.`}
              rest={`${flag.reason ? `“${flag.reason}” ` : ''}A linked correction fixes it, and both stay in history.`} />
          </Banner>
        </View>
      ) : null}
      {s.reversalOf ? <Meta>Corrects an earlier repayment that was flagged.</Meta> : null}
      <Timeline h={h} r={r} hide={hide} panel={panel} />
    </View>
  );
}

function OpeningBody({ h, r, hide, panel }: { h: Household; r: LedgerRecord; hide: boolean; panel: boolean }) {
  const { tone } = useTheme();
  const o = r.opening!;
  const total = o.entries.reduce((a, e) => a + e.amount, 0);
  return (
    <View>
      <Amount value={money(h, total, hide)} panel={panel} badges={r.voided ? <Badge label="Voided" kind="void" /> : null} />
      <Meta>{`What people already owed when ${h.name} started · ${longDate(o.date)}`}</Meta>
      <View style={{ marginTop: 12, gap: 8 }}>
        {o.entries.map((e, i) => (
          <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <Dot color={tone(h.groups.find((g) => g.id === e.fromGroupId)!).deep} />
            <T style={{ fontFamily: fonts.semibold, fontSize: 15 }}>{nameOf(h, e.fromGroupId)} owed</T>
            <Dot color={tone(h.groups.find((g) => g.id === e.toGroupId)!).deep} />
            <T style={{ fontFamily: fonts.semibold, fontSize: 15 }}>{nameOf(h, e.toGroupId)} {money(h, e.amount, hide)}</T>
          </View>
        ))}
      </View>
      {o.note ? <Quote text={o.note} by={personName(h, r.createdBy)} /> : null}
      <Timeline h={h} r={r} hide={hide} panel={panel} />
    </View>
  );
}

function firstRevisionWithNote(r: LedgerRecord): ID | undefined {
  const note = r.expense?.note;
  return r.revisions.find((v) => 'note' in v.content && v.content.note === note)?.by;
}

// ---------- timeline ----------

type Row = { key: string; kind: 'added' | 'seen' | 'edited' | 'voided' | 'restored' | 'flagged'; head: string; meta: ReactNode[]; spoken?: string[] };

function Timeline({ h, r, hide, panel }: { h: Household; r: LedgerRecord; hide: boolean; panel: boolean }) {
  const { c } = useTheme();
  const rows = timelineRows(h, r, hide, panel, c.ink2);
  const ring = { added: c.ink, restored: c.ink, edited: c.warn, flagged: c.warn, voided: c.bad, seen: '' };
  return (
    <View>
      <T accessibilityRole="header" style={{ fontFamily: fonts.semibold, fontSize: 13, color: c.ink2, paddingTop: 22, paddingBottom: 10 }}>What happened</T>
      <View style={{ paddingLeft: 26 }}>
        <View style={{ position: 'absolute', left: 7, top: 8, bottom: 8, width: 2, backgroundColor: c.hair }} />
        {rows.map((row, i) => (
          <View key={row.key} style={{ paddingBottom: i === rows.length - 1 ? 4 : 18 }} accessible
            accessibilityLabel={speak([row.head, ...(row.spoken ?? row.meta.filter((m): m is string => typeof m === 'string'))])}>
            <View style={{ position: 'absolute', left: -24, top: 4, width: 12, height: 12, borderRadius: 6,
              backgroundColor: row.kind === 'seen' ? c.hair : c.bg, borderWidth: row.kind === 'seen' ? 0 : 2.5, borderColor: ring[row.kind] }} />
            <T style={{ fontFamily: fonts.semibold, fontSize: 15 }}>{row.head}</T>
            {row.meta.map((m, j) => (
              <T key={j} style={{ fontSize: 13.5, color: c.ink2, marginTop: j ? 0 : 2 }}>{m}</T>
            ))}
          </View>
        ))}
      </View>
    </View>
  );
}

function timelineRows(h: Household, r: LedgerRecord, hide: boolean, panel: boolean, ink2: string): Row[] {
  const rows: Row[] = [];
  // Authors always know their own change; only other people's "seen" is news.
  const author = new Map(r.timeline.filter((t) => t.type !== 'seen').map((t) => [t.eventId, 'by' in t ? t.by : '']));
  const entries = r.timeline.filter((t) => t.type !== 'seen' || author.get(t.eventId) !== t.personId);
  for (let i = 0; i < entries.length; i++) {
    const t = entries[i];
    const time = when(t.at);
    switch (t.type) {
      case 'added': {
        const first = r.revisions[0]?.content;
        const amount = first && 'amount' in first && r.kind === 'expense' && !hide ? ` · ${money(h, first.amount)}` : '';
        rows.push({ key: t.eventId, kind: 'added', head: `${r.kind === 'settlement' ? 'Recorded' : 'Added'} by ${personName(h, t.by)}`, meta: [`${time}${amount}`] });
        break;
      }
      case 'seen': {
        // People who saw changes at about the same time read as one line.
        const group: Extract<TimelineEntry, { type: 'seen' }>[] = [t];
        while (entries[i + 1]?.type === 'seen') {
          const n = entries[i + 1] as Extract<TimelineEntry, { type: 'seen' }>;
          if (n.at - t.at > 120000) break;
          group.push(n); i++;
        }
        const names = h.people.filter((p) => group.some((g) => g.personId === p.id)).map((p) => personName(h, p.id));
        rows.push({ key: `${t.eventId}:${t.personId}`, kind: 'seen', head: `Seen by ${joinNames(names)}`, meta: [time] });
        break;
      }
      case 'edited': {
        const parts: ReactNode[] = [];
        const said: string[] = [];
        for (const ch of t.changes) {
          if (ch.field === 'amount') {
            if (!hide) said[parts.length] = `Amount ${ch.from} → ${ch.to}`;
            parts.push(hide ? 'Amount changed' : (
              <T key="a" style={{ fontSize: 13.5, color: ink2 }}><T style={{ fontSize: 13.5, color: ink2, textDecorationLine: 'line-through' }}>{ch.from}</T> → {ch.to}</T>
            ));
          } else if (ch.field === 'note') parts.push('Note changed');
          else if (ch.field === 'split') parts.push('Split changed');
          else if (ch.field === 'date') parts.push(`Date ${shortIso(ch.from)} → ${shortIso(ch.to)}`);
          else if (ch.field === 'payer') parts.push(`Paid by ${ch.from} → ${ch.to}`);
          else if (ch.field === 'title') parts.push(`Name “${ch.from || 'none'}” → “${ch.to || 'none'}”`);
          else parts.push(`${ch.from} → ${ch.to}`);
        }
        parts.forEach((p, k) => { if (typeof p === 'string') said[k] = p; });
        if (t.reason) { parts.push(`“${t.reason}”`); said.push(`reason: “${t.reason}”`); }
        const line = joinNodes(parts);
        rows.push({ key: t.eventId, kind: 'edited', head: `Edited by ${personName(h, t.by)}`,
          meta: panel ? [line, time] : [joinNodes([line, time])], spoken: [...said, time] });
        break;
      }
      case 'voided':
        rows.push({ key: t.eventId, kind: 'voided', head: `Voided by ${personName(h, t.by)}`, meta: [`“${t.reason}” · ${time}`] });
        break;
      case 'restored':
        rows.push({ key: t.eventId, kind: 'restored', head: `Restored by ${personName(h, t.by)}`, meta: [time] });
        break;
      case 'flagged':
        rows.push({ key: t.eventId, kind: 'flagged', head: `Flagged by ${personName(h, t.by)}`, meta: [t.reason ? `“${t.reason}” · ${time}` : time] });
        break;
    }
  }
  return rows;
}

/** One spoken line for a timeline row: arrows read as "to", dots as pauses. */
function speak(parts: string[]) {
  return parts.join(', ').replace(/ → /g, ' to ').replace(/ · /g, ', ');
}

function joinNodes(parts: ReactNode[]): ReactNode {
  if (parts.every((p) => typeof p === 'string')) return parts.join(' · ');
  return <>{parts.map((p, i) => <T key={i} style={{ fontSize: 13.5 }}>{i ? ' · ' : ''}{p}</T>)}</>;
}

// ---------- footer ----------

function Footer({ r, panel, actions, hideButtons }: { r: LedgerRecord; panel: boolean; actions: Actions; hideButtons: boolean }) {
  const { c } = useTheme();
  const pill = (label: string, onPress: () => void, opts: { icon?: ReactNode; color?: string; kbd?: string } = {}) => (
    <Press key={label} accessibilityLabel={label} onPress={onPress}
      style={{ flex: panel ? undefined : 1, height: panel ? 44 : 48, borderRadius: 24, paddingHorizontal: 18, backgroundColor: c.chip,
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
      {opts.icon}
      <T style={{ fontFamily: fonts.semibold, fontSize: 16, color: opts.color ?? c.ink }}>{label}</T>
      {opts.kbd && isWeb ? (
        <View style={{ minWidth: 20, height: 20, borderRadius: 5, borderWidth: 1, borderColor: c.hair, backgroundColor: c.card, alignItems: 'center', justifyContent: 'center' }}>
          <T style={{ fontFamily: fonts.semibold, fontSize: 11, color: c.ink2 }}>{opts.kbd}</T>
        </View>
      ) : null}
    </Press>
  );
  let buttons: ReactNode[] = [];
  let note = 'Edits and voids never erase anything. Everyone sees the full story.';
  if (r.voided) {
    buttons = [pill('Restore', actions.restore)];
    note = 'Restoring brings it back into every balance. The void stays in the story.';
  } else if (r.kind === 'expense') {
    if (!hideButtons) {
      buttons = [
        pill('Edit', actions.edit, { icon: panel ? undefined : <Pencil size={20} color={c.ink} />, kbd: panel ? 'E' : undefined }),
        pill('Void', actions.void, { icon: panel ? undefined : <VoidX size={20} color={c.bad} />, color: c.bad }),
      ];
    }
  } else if (r.kind === 'settlement') {
    if (!r.flagged) buttons = [pill('Something’s wrong? Flag it', actions.flag)];
    note = 'Repayments can’t be edited. A flagged one is fixed by a linked correction, and both stay in history.';
  } else {
    buttons = [pill('Void', actions.void, { color: c.bad })];
  }
  return (
    <View style={{ marginTop: panel ? 8 : 0 }}>
      {buttons.length ? <View style={{ flexDirection: 'row', gap: panel ? 8 : 10 }}>{buttons}</View> : null}
      <T style={{ fontFamily: fonts.semibold, fontSize: 12.5, lineHeight: 17, color: c.ink2, textAlign: panel ? 'left' : 'center', marginTop: 12 }}>{note}</T>
    </View>
  );
}

// ---------- dates ----------

const startOfDay = (ts: number) => { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };

/** "Sat 20:00" within the last week, otherwise "3 Oct, 19:15". */
function when(ts: number, now = Date.now()) {
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / 86400000);
  const d = new Date(ts);
  if (days < 7) return `${weekday(d)} ${clock(ts)}`;
  return `${dayMonth(d)}, ${clock(ts)}`;
}

/** "Sat 11 Oct" from an ISO day. */
const longDate = (iso: string) => fullDay(isoDay(iso));

const shortIso = (iso: string) => dayMonth(isoDay(iso));
