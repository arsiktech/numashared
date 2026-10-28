// Building blocks shared by the Add and Repay sheets: the header with its date chip, the inline
// date picker, tonal chip rows, the note line, the paper receipt and the physical keyboard bridge.
import { createElement, useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { ScrollView, TextInput, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Key } from '@/core';
import type { Group, Household } from '@/core/types';
import { todayISO } from '@/store/ids';
import { ChevDown, ChevUp, Close, Pencil } from '@/ui/icons';
import { IconButton, Press, T, TChip, TextButton } from '@/ui/primitives';
import { SheetHead, useSheet } from '@/ui/sheet';
import { forwardSheetInputKey } from '@/ui/sheet-focus';
import { useTheme } from '@/ui/theme';
import { alpha, fonts, isAndroid, isWeb, type GroupTone } from '@/ui/tokens';
import { dateLabel, dateSpoken, daysAgoISO, groupInitials, shiftISO } from './draft';
import { tabJumpsToNote } from './keys';

// ---------- header ----------

/** Cancel (iOS) or a close X (Android), the title, and the date chip. On a desk: title, Esc, date. */
export function SheetTop({ title, tone, onCancel, date, dateOpen, onDate, desk }: {
  title: string; tone: GroupTone; onCancel: () => void; date: string; dateOpen: boolean; onDate: () => void; desk?: boolean;
}) {
  const chip = <DateChip tone={tone} date={date} open={dateOpen} onPress={onDate} />;
  if (desk) {
    return (
      <View style={{ height: 56, flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 24, paddingRight: 20 }}>
        <T accessibilityRole="header" style={{ flex: 1, fontFamily: fonts.semibold, fontSize: 17, color: tone.ink }}>{title}</T>
        <Press accessibilityLabel="Close, Escape" onPress={onCancel} style={{ minHeight: 32, justifyContent: 'center' }}>
          <Kbd tone={tone} label="Esc" />
        </Press>
        {chip}
      </View>
    );
  }
  if (isAndroid) {
    return (
      <View style={{ height: 60, flexDirection: 'row', alignItems: 'center', gap: 4, paddingLeft: 8, paddingRight: 12 }}>
        <IconButton label="Close" onPress={onCancel}><Close size={24} color={tone.ink} /></IconButton>
        <T accessibilityRole="header" style={{ flex: 1, marginLeft: 4, fontFamily: fonts.semibold, fontSize: 20, color: tone.ink }}>{title}</T>
        {chip}
      </View>
    );
  }
  return (
    <SheetHead color={tone.ink} title={title}
      left={<TextButton label="Cancel" onPress={onCancel} color={tone.ink} />}
      right={chip} />
  );
}

function DateChip({ tone, date, open, onPress }: { tone: GroupTone; date: string; open: boolean; onPress: () => void }) {
  return (
    <Press onPress={onPress} accessibilityLabel={`Date: ${dateSpoken(date)}. Change`} accessibilityState={{ expanded: open }}
      hitSlop={6}
      style={{ minHeight: 32, paddingVertical: 2, paddingLeft: 12, paddingRight: 9, borderRadius: 16, flexDirection: 'row', alignItems: 'center', gap: 4,
        backgroundColor: open ? tone.ink : alpha(tone.ink, 0.09) }}>
      <T style={{ fontFamily: fonts.semibold, fontSize: 14, color: open ? tone.band : tone.ink }}>{dateLabel(date)}</T>
      {open ? <ChevUp size={14} color={tone.band} /> : <ChevDown size={14} color={tone.ink} />}
    </Press>
  );
}

export function Kbd({ tone, label, paper }: { tone?: GroupTone; label: string; paper?: boolean }) {
  const { c } = useTheme();
  return (
    <View style={{ minWidth: 22, height: 22, paddingHorizontal: 6, borderRadius: 6, alignItems: 'center', justifyContent: 'center',
      backgroundColor: paper ? '#FBFAF6' : alpha(tone?.ink ?? c.ink, 0.09) }}>
      <T style={{ fontFamily: fonts.semibold, fontSize: 12, color: paper ? '#1E2420' : tone?.ink ?? c.ink2 }}>{label}</T>
    </View>
  );
}

// ---------- rows ----------

/** A horizontal row of tonal chips that scrolls when it runs out of room. */
export function ChipRow({ children, label, style, wrap }: { children: ReactNode; label?: string; style?: StyleProp<ViewStyle>; wrap?: boolean }) {
  if (wrap) return <View accessibilityLabel={label} style={[{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, style]}>{children}</View>;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" accessibilityLabel={label}
      style={[{ flexGrow: 0, marginHorizontal: -22 }, style]} contentContainerStyle={{ gap: 8, paddingHorizontal: 22, alignItems: 'center' }}>
      {children}
    </ScrollView>
  );
}

/**
 * Today, Yesterday, 2 days ago, or one day further back each tap (the row stays open for that).
 * The web adds the browser's own calendar for anything older.
 */
export function DateRow({ tone, date, onPick }: { tone: GroupTone; date: string; onPick: (iso: string, stayOpen?: boolean) => void }) {
  const presets = [todayISO(), daysAgoISO(1), daysAgoISO(2)];
  const older = !presets.includes(date);
  const back = shiftISO(older ? date : presets[2], -1);
  return (
    <ChipRow label="When it happened" wrap={isWeb}>
      <TChip tone={tone} label="Today" on={date === presets[0]} onPress={() => onPick(presets[0])} />
      <TChip tone={tone} label="Yesterday" on={date === presets[1]} onPress={() => onPick(presets[1])} />
      <TChip tone={tone} label="2 days ago" on={date === presets[2]} onPress={() => onPick(presets[2])} />
      {older ? <TChip tone={tone} label={dateLabel(date)} on accessibilityLabel={dateSpoken(date)} /> : null}
      <TChip tone={tone} label="‹ 1 day earlier" accessibilityLabel={`One day earlier: ${dateSpoken(back)}`} onPress={() => onPick(back, true)} />
      {isWeb ? <WebDateInput tone={tone} value={date} max={presets[0]} onPick={onPick} /> : null}
    </ChipRow>
  );
}

function WebDateInput({ tone, value, max, onPick }: { tone: GroupTone; value: string; max: string; onPick: (iso: string) => void }) {
  return createElement('input', {
    type: 'date', value, max, 'aria-label': 'Pick a date',
    onChange: (e: { target: { value: string } }) => { const v = e.target.value; if (/^\d{4}-\d{2}-\d{2}$/.test(v) && v <= max) onPick(v); },
    style: { height: 36, borderRadius: 18, border: 'none', padding: '0 12px', font: `600 15px ${fonts.semibold}, system-ui`, color: tone.ink,
      background: alpha(tone.ink, 0.09), colorScheme: 'light', cursor: 'pointer' },
  });
}

/** The small colored dot next to a person or group in a chip. */
export function PersonDot({ fill, ring }: { fill: string; ring: string }) {
  return <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: fill, borderWidth: 2, borderColor: alpha(ring, 0.6) }} />;
}

/** A group's initials in a circle: ink on its band color, or band on ink for the payer. */
export function GroupAvatar({ h, group, tone, size = 38, ink }: { h: Household; group: Group; tone: GroupTone; size?: number; ink?: boolean }) {
  const text = groupInitials(h, group);
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: ink ? tone.ink : tone.band }}>
      <T maxFontSizeMultiplier={1} style={{ fontFamily: fonts.bold, fontSize: size * (text.length > 1 ? 0.34 : 0.42), color: ink ? tone.band : tone.ink }}>{text}</T>
    </View>
  );
}

// ---------- note ----------

/** The tonal note field. Tapping it opens the OS keyboard. */
export function NoteLine({ tone, value, onChange, editing, setEditing, inputRef, onSubmit, hint, placeholder = 'Add a note', style }: {
  tone: GroupTone; value: string; onChange: (v: string) => void; editing: boolean; setEditing: (v: boolean) => void;
  inputRef?: RefObject<TextInput | null>; onSubmit?: () => void; hint?: string; placeholder?: string; style?: StyleProp<ViewStyle>;
}) {
  const { escape } = useSheet();
  const { largeText } = useTheme();
  const box: ViewStyle = { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingHorizontal: 14, borderRadius: 14, backgroundColor: alpha(tone.ink, 0.09) };
  // A persistent web input lets the browser finish Tab navigation after blur.
  if (isWeb || editing) {
    return (
      <View style={[box, style]}>
        <Pencil size={18} color={alpha(tone.ink, 0.7)} />
        <TextInput ref={inputRef} value={value} onChangeText={onChange} autoFocus={!isWeb && editing} placeholder={placeholder} maxLength={140}
          placeholderTextColor={alpha(tone.ink, 0.62)} accessibilityLabel={isWeb ? `${placeholder}, optional` : 'Note'} returnKeyType="done"
          onFocus={isWeb ? () => setEditing(true) : undefined}
          onBlur={() => setEditing(false)} onSubmitEditing={() => { setEditing(false); onSubmit?.(); }}
          onKeyPress={isWeb ? (e) => forwardSheetInputKey(e, escape) : undefined}
          style={[{ flex: 1, minHeight: 44, fontFamily: fonts.medium, fontSize: 16, color: tone.ink, paddingVertical: 0 }, isWeb ? ({ outlineStyle: 'auto' } as object) : null]} />
      </View>
    );
  }
  const empty = !value.trim();
  return (
    <Press noScale onPress={() => setEditing(true)} accessibilityLabel={empty ? 'Add a note, optional' : `Note: ${value}. Edit`} style={[box, style]}>
      <Pencil size={18} color={alpha(tone.ink, 0.7)} />
      <T numberOfLines={largeText ? 2 : 1} style={{ flex: 1, fontFamily: fonts.medium, fontSize: 16, color: empty ? alpha(tone.ink, 0.68) : tone.ink }}>
        {empty ? placeholder : value}
      </T>
      {/* At the accessibility sizes "optional" stays in the spoken label and gives its room to the note. */}
      {hint ? <Kbd tone={tone} label={hint} /> : empty && !largeText ? <T style={{ fontSize: 13, color: tone.ink, opacity: 0.7 }}>optional</T> : null}
    </Press>
  );
}

// ---------- receipt ----------

/** The one paper card on the color: split, preview and the button. */
export function Receipt({ children, tone, desk }: { children: ReactNode; tone: GroupTone; desk?: boolean }) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  if (desk) {
    return <View style={{ margin: 16, padding: 16, borderRadius: 22, backgroundColor: c.bg, gap: 12 }}>{children}</View>;
  }
  return (
    <View style={{ backgroundColor: c.bg, borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingTop: 16, paddingHorizontal: 16,
      paddingBottom: Math.max(insets.bottom, 12) + 6, gap: 12,
      shadowColor: tone.ink, shadowOpacity: 0.14, shadowRadius: 16, shadowOffset: { width: 0, height: -12 }, elevation: 8 }}>
      {children}
    </View>
  );
}

export function ReceiptHead({ left, right, onRight, rightLabel }: { left: string; right?: string; onRight?: () => void; rightLabel?: string }) {
  const { c } = useTheme();
  return (
    <View style={{ minHeight: 20, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: 12, rowGap: 4, paddingHorizontal: 2 }}>
      <T style={{ fontFamily: fonts.semibold, fontSize: 13, color: c.ink2 }}>{left}</T>
      {right ? (
        onRight ? (
          <Press onPress={onRight} accessibilityLabel={rightLabel ?? right} hitSlop={12} style={{ minHeight: 20, justifyContent: 'center' }}>
            <T style={{ fontFamily: fonts.semibold, fontSize: 13, color: c.ink }}>{right}</T>
          </Press>
        ) : <T style={{ fontFamily: fonts.semibold, fontSize: 13, color: c.ink2 }}>{right}</T>
      ) : null}
    </View>
  );
}

/** "After this · You + Sam owe €75.70". */
export function AfterRow({ left, lead, strong }: { left: string; lead: string; strong: string }) {
  const { c } = useTheme();
  return (
    <View accessible accessibilityLabel={`${left}. ${lead} ${strong}`.trim()}
      style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, paddingHorizontal: 2 }}>
      <T style={{ fontSize: 14, color: c.ink2, flexShrink: 1 }}>{left}</T>
      <T style={{ fontSize: 14, color: c.ink2, textAlign: 'right', flexShrink: 1 }}>
        {lead}{lead && strong ? ' ' : ''}
        {strong ? <T style={{ fontFamily: fonts.bold, fontSize: 16, color: c.ink, fontVariant: ['tabular-nums'] }}>{strong}</T> : null}
      </T>
    </View>
  );
}

// ---------- sizing ----------

/** Key height that fits the space left for the keypad: about 56 on an 844 pt phone. */
export function keyHeight(screenH: number, space: number, rows = 4) {
  // The keypad sits on the receipt like a phone's own: comfortable keys, never a gap beneath.
  const cap = Math.max(50, Math.min(66, Math.round(screenH * 0.07)));
  if (!space) return cap;
  return Math.max(44, Math.min(cap, Math.floor((space - 8) / rows)));
}

/** Shrinks the big amount so long numbers stay on one line. */
export function amountSize(base: number, width: number, text: string) {
  const glyphs = text.replace(/[^0-9.,]/g, '').length || 1;
  return Math.max(40, Math.min(base, Math.floor(width / (glyphs * 0.62 + 0.9))));
}

// ---------- physical keyboard (web) ----------

type KeyHandlers = { onKey?: (k: Key) => void; onEnter?: () => void; onTab?: () => void };

/**
 * On the web, digits typed on a physical keyboard go into the amount, Backspace deletes, Enter
 * saves, and Tab with nothing focused yet moves to the note. Text fields keep their own keys.
 */
export function useWebKeys(enabled: boolean, handlers: KeyHandlers) {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    if (!isWeb || !enabled || typeof window === 'undefined') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      const editable = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      const h = ref.current;
      if (editable) return;
      // Only the first Tab, while nothing has focus yet, jumps to the note. After that Tab and
      // Shift+Tab move through the controls as usual.
      if (e.key === 'Tab' && h.onTab) {
        const nothingFocused = !t || t === document.body || t === document.documentElement || t.getAttribute('role') === 'dialog';
        if (tabJumpsToNote(nothingFocused, e.shiftKey)) { e.preventDefault(); h.onTab(); }
        return;
      }
      if (/^[0-9]$/.test(e.key) && h.onKey) { e.preventDefault(); h.onKey(e.key as Key); return; }
      if ((e.key === '.' || e.key === ',') && h.onKey) { e.preventDefault(); h.onKey('.'); return; }
      if (e.key === 'Backspace' && h.onKey) { e.preventDefault(); h.onKey('back'); return; }
      if (e.key === 'Enter' && h.onEnter) {
        // A focused button handles Enter itself.
        const onButton = !!t && t !== document.body && (t.getAttribute('role') === 'button' || t.tagName === 'BUTTON');
        if (onButton) return;
        e.preventDefault();
        h.onEnter();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}
