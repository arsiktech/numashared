// Shared record row (Home on the phone, the desk history) and the orb button that measures its origin.
import { useRef } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import type { Household, LedgerRecord } from '@/core/types';
import { groupOfPerson } from '@/store/store';
import { openSheet, type Origin, type SheetSpec } from '@/store/ui';
import { CategoryIcon, House, Repay } from '@/ui/icons';
import { OrbView, Press, T } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { corner, figures, space, text } from '@/ui/scale';
import { isWeb } from '@/ui/tokens';
import { sameDay } from './history/model';
import { addedByLine, clock, effectText, money, personName, recordTitle, relativeDay, settlementTitle } from './hooks';

/** `day`: the day of the heading above the row. A record from that day shows its time, any other its day. */
export function RecordRow({ h, r, hide, fresh, selected, day, onPress }: {
  h: Household; r: LedgerRecord; hide?: boolean; fresh?: boolean; selected?: boolean; day?: number; onPress?: () => void;
}) {
  const { ui, largeText } = useTheme();
  const title = r.kind === 'settlement' ? settlementTitle(h, r) : recordTitle(r);
  const when = day !== undefined && sameDay(r.createdAt, day) ? clock(r.createdAt) : relativeDay(r.createdAt);
  let tile: { bg: string; fg: string };
  let icon: React.ReactNode;
  let parts: string[];
  let amount = 0;
  if (r.kind === 'expense') {
    const e = r.expense!;
    tile = r.voided ? { bg: ui.wash, fg: ui.muted } : { bg: ui.group(groupOfPerson(h, e.payerId)), fg: ui.onFill };
    icon = <CategoryIcon category={e.category} size={20} color={tile.fg} />;
    amount = e.amount;
    parts = r.voided
      ? [`Voided by ${personName(h, lastBy(r, 'voided') ?? r.createdBy)}`, (r.voidReason ?? '').toLowerCase()]
      : [`${personName(h, e.payerId)} paid${addedByLine(h, r, e.payerId)}`, e.note ? `“${e.note}”` : '', when];
  } else if (r.kind === 'settlement') {
    const st = r.settlement!;
    tile = { bg: ui.ink, fg: ui.canvas };
    icon = <Repay size={20} color={tile.fg} />;
    amount = st.amount;
    parts = [st.note ? `“${st.note}”` : '', when];
  } else {
    tile = { bg: ui.wash, fg: ui.ink };
    icon = <House size={20} color={tile.fg} />;
    amount = r.opening!.entries.reduce((a, x) => a + x.amount, 0);
    parts = [when];
  }
  const edited = r.revisions.length > 1 && !r.voided;
  const sub = [...parts, edited ? 'edited' : '', r.flagged ? 'flagged' : ''].filter(Boolean).join(' · ');
  const strike = r.voided ? ({ textDecorationLine: 'line-through', color: ui.muted } as const) : null;
  const effect = effectText(h, r, hide);
  const amountBlock = (
    <View style={{ alignItems: largeText ? 'flex-start' : 'flex-end' }}>
      <T style={[text.strong, figures, strike]}>{money(h, amount, hide)}</T>
      <T style={[text.meta, { color: ui.muted }]}>{effect}</T>
    </View>
  );
  return (
    <Press noScale onPress={onPress} accessibilityState={selected ? { selected } : undefined}
      accessibilityLabel={`${title}, ${money(h, amount, hide)}, ${sub}, ${effect}`}
      style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: 64, paddingVertical: space[2],
        marginHorizontal: -space[3], paddingHorizontal: space[3], borderRadius: corner, backgroundColor: selected || fresh ? ui.wash : 'transparent' }}>
      <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: tile.bg, alignItems: 'center', justifyContent: 'center' }}>{icon}</View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <T numberOfLines={largeText ? 3 : 1} style={[text.strong, strike]}>{title}</T>
        <T numberOfLines={largeText ? 3 : 1} style={[text.meta, { color: ui.muted }]}>{sub}</T>
        {/* At the accessibility text sizes the amount moves under the title, so neither is cut short. */}
        {largeText ? amountBlock : null}
      </View>
      {largeText ? null : amountBlock}
    </Press>
  );
}

function lastBy(r: LedgerRecord, type: 'voided') {
  const e = [...r.timeline].reverse().find((t) => t.type === type);
  return e && 'by' in e ? e.by : undefined;
}

/** The orb: measures where it sits so the sheet can grow out of it. */
export function OrbButton({ size = 92, plus = 32, spec = { type: 'add' } as SheetSpec, style, label = 'Add expense' }: {
  size?: number; plus?: number; spec?: SheetSpec; style?: StyleProp<ViewStyle>; label?: string;
}) {
  const ref = useRef<View>(null);
  return (
    <Press ref={ref} accessibilityLabel={label} accessibilityHint={isWeb ? 'Shortcut: N' : undefined} style={style}
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
