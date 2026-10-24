// Money-specific components: the big amount, the keypad, the split bar and the underlined word.
import { useRef, useState, type ReactNode } from 'react';
import { PanResponder, Pressable, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import { formatMoney, splitDisplay } from '@/core';
import type { Cents, ID } from '@/core/types';
import { Backspace, ChevDown, ChevUp } from './icons';
import { haptic, Press, T } from './primitives';
import { useTheme } from './theme';
import { alpha, fonts, orb, type GroupTone } from './tokens';
import { TEXT_CAP } from './textScale';

/** "€52.80" with ghosted decimals and an optional caret, as in the Add sheet. */
/** `scaled`: the size already includes the system text size, so the text doesn't grow again. */
export function BigAmount({ cents, currency, size = 84, color, caret, typed, accessibilityLabel, scaled }: {
  cents: Cents; currency: string; size?: number; color: string; caret?: boolean; typed?: string; accessibilityLabel?: string; scaled?: boolean;
}) {
  const cap = scaled ? 1 : undefined;
  const parts = splitDisplay(cents, currency);
  const label = accessibilityLabel ?? `Amount ${formatMoney(cents, currency)}`;
  const shownWhole = typed !== undefined ? typed.split('.')[0] || '0' : parts.whole;
  const typedDec = typed !== undefined && typed.includes('.') ? typed.split('.')[1] : undefined;
  return (
    <View accessible accessibilityLabel={label} style={{ flexDirection: 'row', alignItems: 'flex-end' }}>
      <T maxFontSizeMultiplier={cap} style={{ fontFamily: fonts.display, fontSize: size * 0.55, lineHeight: size * 0.95, color, marginRight: 4 }}>{parts.symbol}</T>
      <T maxFontSizeMultiplier={cap} style={{ fontFamily: fonts.display, fontSize: size, lineHeight: size * 1.06, letterSpacing: -size * 0.035, color, fontVariant: ['tabular-nums'] }}>
        {groupThousands(shownWhole)}
        {parts.decimals !== null ? (
          <T maxFontSizeMultiplier={cap} style={{ fontFamily: fonts.display, fontSize: size, color, opacity: typedDec !== undefined ? 1 : 0.38 }}>
            {'.'}{typedDec !== undefined ? typedDec.padEnd(parts.decimals.length, '0').slice(0, parts.decimals.length) : parts.decimals}
          </T>
        ) : null}
      </T>
      {caret ? <View style={{ width: 3, height: size * 0.78, backgroundColor: orb.stops[2], borderRadius: 2, marginLeft: 4, marginBottom: size * 0.14 }} /> : null}
    </View>
  );
}

function groupThousands(s: string) {
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function Keypad({ onKey, color, height = 56, allowDot = true }: {
  onKey: (k: string) => void; color: string; height?: number; allowDot?: boolean;
}) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', allowDot ? '.' : '', '0', 'back'];
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap' }} accessibilityLabel="Keypad">
      {keys.map((k, i) => (
        <View key={i} style={{ width: '33.333%' }}>
          {k ? (
            <Pressable onPress={() => { haptic.tap(); onKey(k); }} accessibilityRole="button" accessibilityLabel={k === 'back' ? 'Delete' : k === '.' ? 'Decimal point' : k}
              style={({ pressed }) => [{ height, alignItems: 'center', justifyContent: 'center', borderRadius: 14 }, pressed ? { backgroundColor: alpha(color, 0.1) } : null]}>
              {k === 'back' ? <Backspace size={26} color={color} /> : <T maxFontSizeMultiplier={TEXT_CAP.sentence} style={{ fontSize: 28, color, fontFamily: fonts.regular }}>{k}</T>}
            </Pressable>
          ) : <View style={{ height }} />}
        </View>
      ))}
    </View>
  );
}

/** A tappable word in the Add sentence: underlined, never boxed. */
export function Word({ children, onPress, color, open, chevron = true, leading, accessibilityLabel, size = 30, placeholder }: {
  children: ReactNode; onPress?: () => void; color: string; open?: boolean; chevron?: boolean; leading?: ReactNode;
  accessibilityLabel: string; size?: number; placeholder?: boolean;
}) {
  return (
    <Press onPress={onPress} accessibilityLabel={accessibilityLabel} accessibilityState={{ expanded: !!open }}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44 }}>
      {leading}
      <View style={{ borderBottomWidth: 3, borderBottomColor: alpha(color, 0.32), paddingBottom: 2 }}>
        <T maxFontSizeMultiplier={TEXT_CAP.sentence} style={{ fontFamily: fonts.display, fontSize: size, lineHeight: size * 1.18, letterSpacing: -size * 0.02, color: placeholder ? alpha(color, 0.55) : color }}>{children}</T>
      </View>
      {chevron ? (open ? <ChevUp size={18} color={alpha(color, 0.55)} /> : <ChevDown size={18} color={alpha(color, 0.55)} />) : null}
    </Press>
  );
}

export type SplitSegment = { groupId: ID; name: string; tone: GroupTone; share: Cents; out?: boolean };

/**
 * The split bar: one segment per group in its color. Drag a knob to move money between neighbours,
 * tap a segment to leave that group out (or back in), long-press a segment to type its share exactly.
 * Every drag result is exact cents and sums to the amount.
 */
export function SplitBar({ segments, amount, currency, onShares, onToggle, onExact, focusId, height = 54, showKnobs = true, style }: {
  segments: SplitSegment[]; amount: Cents; currency: string; onShares?: (shares: Record<ID, Cents>) => void;
  onToggle?: (groupId: ID) => void; onExact?: (groupId: ID) => void; focusId?: ID | null; height?: number; showKnobs?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { c } = useTheme();
  const [width, setWidth] = useState(0);
  const active = segments.filter((sg) => !sg.out);
  // Every segment keeps a readable minimum width; active ones share the rest by amount.
  // (A fixed relative weight for left-out segments would be compared with cents and vanish.)
  const gap = 3;
  const usable = Math.max(0, width - gap * (segments.length - 1));
  const minFor = (sg: SplitSegment) => Math.min(sg.out ? 52 : 74, usable / Math.max(segments.length, 1));
  const mins = segments.map(minFor);
  const spare = Math.max(0, usable - mins.reduce((a, m) => a + m, 0));
  const total = active.reduce((a, sg) => a + Math.max(sg.share, 0), 0);
  const widths = segments.map((sg, i) => mins[i] + (sg.out ? 0 : total > 0 ? (spare * Math.max(sg.share, 0)) / total : spare / Math.max(active.length, 1)));
  const pxPerCentFor = (a: number, b: number) => (total > 0 ? spare / total : 0) || ((widths[a] + widths[b]) / Math.max(1, segments[a].share + segments[b].share));

  // Knob positions between consecutive active segments.
  const knobs: { left: number; a: SplitSegment; b: SplitSegment }[] = [];
  let x = 0;
  segments.forEach((sg, i) => {
    x += widths[i];
    const next = segments[i + 1];
    if (next && !sg.out && !next.out) knobs.push({ left: x + gap / 2 + gap * i, a: sg, b: next });
  });

  return (
    <View style={[{ height, flexDirection: 'row', gap }, style]} onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
      accessibilityLabel={`Split: ${active.map((sg) => `${sg.name} ${formatMoney(sg.share, currency)}`).join(', ')}`}>
      {segments.map((sg, i) => (
        <Press key={sg.groupId} noScale onPress={() => onToggle?.(sg.groupId)} onLongPress={() => onExact?.(sg.groupId)}
          accessibilityLabel={sg.out ? `${sg.name}, left out. Tap to add back` : `${sg.name}, ${formatMoney(sg.share, currency)}. Tap to leave out, hold to type exactly`}
          style={{ width: widths[i] || undefined, flexGrow: width ? 0 : 1, height, borderRadius: 10, backgroundColor: sg.tone.band, opacity: sg.out ? 0.4 : 1,
            paddingHorizontal: 10, justifyContent: 'center', overflow: 'hidden',
            borderWidth: focusId === sg.groupId ? 3 : 0, borderColor: c.ink }}>
          <T numberOfLines={1} maxFontSizeMultiplier={TEXT_CAP.label} style={{ fontFamily: fonts.semibold, fontSize: 13, color: sg.tone.ink }}>{sg.name}</T>
          <T numberOfLines={1} maxFontSizeMultiplier={TEXT_CAP.label} style={{ fontFamily: fonts.bold, fontSize: 16, color: sg.tone.ink, fontVariant: ['tabular-nums'] }}>
            {sg.out ? 'out' : formatMoney(sg.share, currency)}
          </T>
        </Press>
      ))}
      {showKnobs && onShares && width > 0
        ? knobs.map((k) => (
          <Knob key={`${k.a.groupId}-${k.b.groupId}`} left={k.left} height={height} pxPerCent={pxPerCentFor(segments.indexOf(k.a), segments.indexOf(k.b))}
            pair={[k.a.share, k.b.share]} onMove={(aShare) => {
              const sum = k.a.share + k.b.share;
              const nextA = Math.max(0, Math.min(sum, aShare));
              const shares: Record<ID, Cents> = {};
              for (const sg of active) shares[sg.groupId] = sg.share;
              shares[k.a.groupId] = nextA;
              shares[k.b.groupId] = sum - nextA;
              onShares(shares);
            }} />
        ))
        : null}
    </View>
  );
}

function Knob({ left, height, pxPerCent, pair, onMove }: { left: number; height: number; pxPerCent: number; pair: [Cents, Cents]; onMove: (aShare: Cents) => void }) {
  const { c } = useTheme();
  const start = useRef(pair[0]);
  const lastTick = useRef(false);
  const responder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => { start.current = pairRef.current[0]; haptic.tick(); },
    onPanResponderMove: (_e, g) => {
      const sum = pairRef.current[0] + pairRef.current[1];
      let a = Math.round(start.current + g.dx / Math.max(pxRef.current, 0.0001));
      const half = Math.floor(sum / 2);
      const nearHalf = Math.abs(a - half) < sum * 0.025;
      if (nearHalf) a = half;
      if (nearHalf && !lastTick.current) haptic.tick();
      lastTick.current = nearHalf;
      onMoveRef.current(a);
    },
  })).current;
  const pairRef = useRef(pair); pairRef.current = pair;
  const pxRef = useRef(pxPerCent); pxRef.current = pxPerCent;
  const onMoveRef = useRef(onMove); onMoveRef.current = onMove;
  return (
    <View {...responder.panHandlers} accessibilityRole="adjustable" accessibilityLabel="Split handle"
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => onMove(pair[0] + (e.nativeEvent.actionName === 'increment' ? 100 : -100))}
      style={{ position: 'absolute', left: left - 15, top: -6, width: 30, height: height + 12, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ width: 6, height: height - 10, borderRadius: 3, backgroundColor: c.ink, borderWidth: 0, shadowColor: c.bg, shadowOpacity: 1, shadowRadius: 0, shadowOffset: { width: 0, height: 0 } }} />
    </View>
  );
}
