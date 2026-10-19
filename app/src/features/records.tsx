// Shared record row (Home "Latest", web lists) and the orb button that measures its origin.
import { useRef } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import type { Household, LedgerRecord } from '@/core/types';
import { groupOfPerson } from '@/store/store';
import { openSheet, type Origin, type SheetSpec } from '@/store/ui';
import { CategoryIcon, Repay, House } from '@/ui/icons';
import { Badge, OrbView, Press, T } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { fonts } from '@/ui/tokens';
import { effectText, money, personName, recordTitle, relativeDay } from './hooks';

export function RecordRow({ h, r, hide, fresh, last, onPress }: {
  h: Household; r: LedgerRecord; hide?: boolean; fresh?: boolean; last?: boolean; onPress?: () => void;
}) {
  const { c, tone } = useTheme();
  const title = recordTitle(r);
  let tile: { bg: string; fg: string; icon: React.ReactNode };
  let sub = '';
  let amount = 0;
  if (r.kind === 'expense') {
    const e = r.expense!;
    const t = tone(groupOfPerson(h, e.payerId));
    tile = { bg: r.voided ? c.chip : t.band, fg: r.voided ? c.ink3 : t.ink, icon: null };
    tile.icon = <CategoryIcon category={e.category} size={20} color={tile.fg} />;
    amount = e.amount;
    sub = r.voided
      ? `Voided by ${personName(h, lastBy(r, 'voided') ?? r.createdBy)} · ${(r.voidReason ?? '').toLowerCase()}`
      : `${personName(h, e.payerId)} paid · ${relativeDay(r.createdAt)}`;
  } else if (r.kind === 'settlement') {
    const st = r.settlement!;
    tile = { bg: c.ink, fg: c.bg, icon: <Repay size={20} color={c.bg} /> };
    amount = st.amount;
    sub = st.note ? `“${st.note}”` : `${relativeDay(r.createdAt)}`;
  } else {
    tile = { bg: c.chip, fg: c.ink, icon: <House size={20} color={c.ink} /> };
    amount = r.opening!.entries.reduce((a, x) => a + x.amount, 0);
    sub = relativeDay(r.createdAt);
  }
  const edited = r.revisions.length > 1;
  const note = r.kind === 'expense' && r.expense!.note && !r.voided ? r.expense!.note : null;
  return (
    <Press noScale onPress={onPress} accessibilityLabel={`${r.kind === 'settlement' ? settlementTitle(h, r) : title}, ${money(h, amount, hide)}, ${note ? `“${note}”, ` : ''}${sub}, ${effectText(h, r, hide)}${edited ? ', edited' : ''}${r.flagged ? ', flagged' : ''}`}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64, paddingVertical: 8,
        borderBottomWidth: last ? 0 : 1, borderBottomColor: c.hair, backgroundColor: fresh ? c.flash : 'transparent',
        marginHorizontal: fresh ? -22 : 0, paddingHorizontal: fresh ? 22 : 0 }}>
      <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: tile.bg, alignItems: 'center', justifyContent: 'center' }}>{tile.icon}</View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <T numberOfLines={1} style={{ fontFamily: fonts.semibold, fontSize: 16, flexShrink: 1, color: r.voided ? c.ink3 : c.ink, textDecorationLine: r.voided ? 'line-through' : 'none' }}>
            {r.kind === 'settlement' ? settlementTitle(h, r) : title}
          </T>
          {edited && !r.voided ? <Badge label="Edited" /> : null}
          {r.flagged ? <Badge label="Flagged" kind="pending" /> : null}
        </View>
        <T numberOfLines={1} style={{ fontSize: 13.5, color: c.ink2, marginTop: 2 }}>{note ? `“${note}” · ${sub}` : sub}</T>
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <T style={{ fontFamily: fonts.semibold, fontSize: 16, fontVariant: ['tabular-nums'], color: r.voided ? c.ink3 : c.ink, textDecorationLine: r.voided ? 'line-through' : 'none' }}>{money(h, amount, hide)}</T>
        <T style={{ fontSize: 13, color: c.ink2, marginTop: 2 }}>{effectText(h, r, hide)}</T>
      </View>
    </Press>
  );
}

function lastBy(r: LedgerRecord, type: 'voided') {
  const e = [...r.timeline].reverse().find((t) => t.type === type);
  return e && 'by' in e ? e.by : undefined;
}

export function settlementTitle(h: Household, r: LedgerRecord) {
  const s = r.settlement!;
  const from = h.groups.find((g) => g.id === s.fromGroupId)!;
  const to = h.groups.find((g) => g.id === s.toGroupId)!;
  const name = (g: typeof from) => (g.memberIds.includes(h.youId) ? (g.memberIds.length > 1 ? 'You + ' + h.people.find((p) => p.id === g.memberIds.find((m) => m !== h.youId))!.name : 'You') : g.memberIds.map((m) => h.people.find((p) => p.id === m)!.name).join(' + '));
  return `${name(from)} paid ${name(to)}`;
}

/** The orb: measures where it sits so the sheet can grow out of it. */
export function OrbButton({ size = 92, plus = 32, spec = { type: 'add' } as SheetSpec, style, label = 'Add expense' }: {
  size?: number; plus?: number; spec?: SheetSpec; style?: StyleProp<ViewStyle>; label?: string;
}) {
  const ref = useRef<View>(null);
  return (
    <Press ref={ref} accessibilityLabel={label} style={style}
      onPress={() => {
        ref.current?.measureInWindow((x, y, w, hh) => {
          const origin: Origin = { x: x + w / 2, y: y + hh / 2, r: Math.min(w, hh) / 2 };
          openSheet(spec, Number.isFinite(origin.x) ? origin : undefined);
        });
      }}>
      <OrbView size={size} plus={plus} />
    </Press>
  );
}
