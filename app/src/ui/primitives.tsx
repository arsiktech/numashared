// Base components. Every interactive element is a Pressable with an accessible label,
// a 44 pt minimum target and a 0.96 press scale.
import { forwardRef, useId, type ReactNode } from 'react';
import {
  Pressable, StyleSheet, Text, View, type PressableProps, type StyleProp, type TextProps,
  type TextStyle, type ViewStyle,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import Svg, { Defs, LinearGradient, RadialGradient, Rect, Stop, Circle as SvgCircle, Ellipse } from 'react-native-svg';
import { fonts, orb, radius, type, alpha, isWeb } from './tokens';
import { TEXT_CAP } from './textScale';
import { useTheme } from './theme';
import { Plus } from './icons';
import type { GroupTone } from './tokens';

export const haptic = {
  tap: () => { if (!isWeb) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {}); },
  medium: () => { if (!isWeb) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {}); },
  tick: () => { if (!isWeb) Haptics.selectionAsync().catch(() => {}); },
  success: () => { if (!isWeb) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {}); },
  warn: () => { if (!isWeb) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {}); },
};

// ---------- text ----------

export function T({ style, ...p }: TextProps & { style?: StyleProp<TextStyle> }) {
  const { c } = useTheme();
  return <Text {...p} style={[{ color: c.ink, fontFamily: fonts.regular, fontSize: 16 }, style]} />;
}

// ---------- pressables ----------

type PressProps = Omit<PressableProps, 'style'> & { style?: StyleProp<ViewStyle>; children?: ReactNode; noScale?: boolean };

export const Press = forwardRef<View, PressProps>(function Press({ style, noScale, children, ...p }, ref) {
  return (
    <Pressable
      ref={ref}
      accessibilityRole={p.accessibilityRole ?? 'button'}
      {...p}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
        style,
        pressed && !noScale ? { transform: [{ scale: 0.96 }] } : null,
        hovered && isWeb ? { opacity: 0.88 } : null,
      ]}
    >
      {children}
    </Pressable>
  );
});

export function Pill({ label, onPress, light, icon, style, textStyle, accessibilityLabel, small }: {
  label: string; onPress?: () => void; light?: boolean; icon?: ReactNode; style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>; accessibilityLabel?: string; small?: boolean;
}) {
  const { c } = useTheme();
  return (
    <Press onPress={onPress} accessibilityLabel={accessibilityLabel ?? label}
      style={[s.pill, { minHeight: small ? 40 : 44, backgroundColor: light ? c.chip : c.ink }, style]}>
      {icon}
      <T style={[{ fontFamily: fonts.semibold, fontSize: 16, color: light ? c.ink : c.bg }, textStyle]}>{label}</T>
    </Press>
  );
}

export function CTA({ label, onPress, variant = 'primary', disabled, icon, accessibilityLabel, right, style }: {
  label: string; onPress?: () => void; variant?: 'primary' | 'add' | 'second' | 'danger' | 'apple' | 'google';
  disabled?: boolean; icon?: ReactNode; accessibilityLabel?: string; right?: ReactNode; style?: StyleProp<ViewStyle>;
}) {
  const { c } = useTheme();
  const bg = disabled ? c.chip : {
    primary: c.ink, add: orb.ctaBottom, second: c.chip, danger: c.bad, apple: '#000000', google: '#FFFFFF',
  }[variant];
  const fg = disabled ? c.ink3 : {
    primary: c.bg, add: orb.ctaInk, second: c.ink, danger: '#FFFFFF', apple: '#FFFFFF', google: '#1F1F1F',
  }[variant];
  return (
    <Press onPress={disabled ? undefined : onPress} disabled={disabled}
      accessibilityState={{ disabled: !!disabled }} accessibilityLabel={accessibilityLabel ?? label}
      style={[s.cta, { backgroundColor: bg }, variant === 'google' && !disabled ? { borderWidth: 1, borderColor: '#747775' } : null,
        variant === 'add' && !disabled ? s.ctaAddShadow : null, style]}>
      {variant === 'add' && !disabled ? (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          <Svg width="100%" height="100%" preserveAspectRatio="none">
            <Defs>
              <LinearGradient id="addg" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={orb.ctaTop} /><Stop offset="1" stopColor={orb.ctaBottom} />
              </LinearGradient>
            </Defs>
            <Rect x="0" y="0" width="100%" height="100%" rx={radius.cta} fill="url(#addg)" />
          </Svg>
        </View>
      ) : null}
      {icon}
      <T maxFontSizeMultiplier={TEXT_CAP.label} style={{ fontFamily: variant === 'add' ? fonts.bold : fonts.semibold, fontSize: variant === 'add' ? 19 : 17, color: fg, textAlign: 'center', flexShrink: 1 }}>{label}</T>
      {right}
    </Press>
  );
}

export function IconButton({ onPress, label, children, style }: { onPress?: () => void; label: string; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <Press onPress={onPress} accessibilityLabel={label} style={[s.iconBtn, style]}>{children}</Press>
  );
}

export function TextButton({ label, onPress, bold, color, icon, style }: {
  label: string; onPress?: () => void; bold?: boolean; color?: string; icon?: ReactNode; style?: StyleProp<ViewStyle>;
}) {
  const { c } = useTheme();
  return (
    <Press onPress={onPress} accessibilityLabel={label} style={[s.textBtn, style]}>
      {icon}
      <T style={{ fontSize: 17, fontFamily: bold ? fonts.semibold : fonts.regular, color: color ?? c.ink }}>{label}</T>
    </Press>
  );
}

// ---------- orb ----------

export function OrbView({ size = 92, plus = 32, pressed }: { size?: number; plus?: number; pressed?: boolean }) {
  // Each orb needs its own gradient id: on the web, SVG ids are global and a hidden screen's orb
  // would otherwise own the gradient and leave this one unfilled.
  const gid = `orbg${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, transform: [{ scale: pressed ? 0.94 : 1 }],
      shadowColor: '#A0320F', shadowOpacity: 0.3, shadowRadius: size / 8, shadowOffset: { width: 0, height: size / 9 }, elevation: 8 }}>
      <Svg width={size} height={size} viewBox="0 0 100 100" style={StyleSheet.absoluteFill}>
        <Defs>
          <RadialGradient id={gid} cx="34%" cy="30%" r="75%" fx="34%" fy="30%">
            <Stop offset="0" stopColor={orb.stops[0]} />
            <Stop offset="0.3" stopColor={orb.stops[1]} />
            <Stop offset="0.58" stopColor={orb.stops[2]} />
            <Stop offset="1" stopColor={orb.stops[3]} />
          </RadialGradient>
        </Defs>
        <SvgCircle cx="50" cy="50" r="50" fill={`url(#${gid})`} />
        <Ellipse cx="36" cy="22" rx="16" ry="9.5" fill="rgba(255,255,255,0.55)" transform="rotate(-24 36 22)" />
      </Svg>
      <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
        <Plus size={plus} color={orb.ink} />
      </View>
    </View>
  );
}

// ---------- chips, words, avatars ----------

/** Tonal chip used on a color band: the band's ink at 9%. */
export function TChip({ label, amount, on, onPress, tone, small, leading, accessibilityLabel }: {
  label: string; amount?: string; on?: boolean; onPress?: () => void; tone: GroupTone; small?: boolean;
  leading?: ReactNode; accessibilityLabel?: string;
}) {
  return (
    <Press onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: !!on }}
      accessibilityLabel={accessibilityLabel ?? (amount ? `${label}, ${amount}` : label)} style={s.target}>
      <View style={[s.tchip, { minHeight: small ? 32 : 36, paddingHorizontal: small ? 12 : 14, backgroundColor: on ? tone.ink : alpha(tone.ink, 0.09) }]}>
        {leading}
        <T style={{ fontFamily: fonts.semibold, fontSize: small ? 14 : 14.5, color: on ? tone.band : tone.ink }}>{label}</T>
        {amount ? <T style={{ fontFamily: fonts.medium, fontSize: 14.5, color: on ? tone.band : tone.ink, opacity: 0.72 }}>{amount}</T> : null}
      </View>
    </Press>
  );
}

/** Neutral chip on paper. */
export function Chip({ label, on, onPress, leading, square }: { label: string; on?: boolean; onPress?: () => void; leading?: ReactNode; square?: boolean }) {
  const { c } = useTheme();
  return (
    <Press onPress={onPress} accessibilityState={{ selected: !!on }} accessibilityLabel={label} style={s.target}>
      <View style={[s.chip, { borderRadius: square ? 8 : 18, backgroundColor: on ? c.ink : c.chip }]}>
        {leading}
        <T style={{ fontFamily: fonts.semibold, fontSize: 14.5, color: on ? c.bg : c.ink }}>{label}</T>
      </View>
    </Press>
  );
}

export function Avatar({ initials, tone, size = 26, ink }: { initials: string; tone: GroupTone; size?: number; ink?: boolean }) {
  const { c } = useTheme();
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center',
      backgroundColor: ink ? tone.ink : tone.band, borderWidth: ink ? 0 : 2, borderColor: c.bg }}>
      {/* Initials are drawn to fit their fixed circle, so they don't grow with the text size. */}
      <T maxFontSizeMultiplier={1} style={{ fontFamily: fonts.bold, fontSize: size * 0.44, color: ink ? tone.band : tone.ink }}>{initials}</T>
    </View>
  );
}

export function Dot({ color, size = 8 }: { color: string; size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
}

export function Badge({ label, kind = 'plain' }: { label: string; kind?: 'plain' | 'void' | 'pending' }) {
  const { c } = useTheme();
  const bg = kind === 'void' ? c.badBg : kind === 'pending' ? c.warnBg : c.chip;
  const fg = kind === 'void' ? c.bad : kind === 'pending' ? c.warn : c.ink2;
  return (
    <View style={{ minHeight: 20, paddingHorizontal: 7, borderRadius: radius.badge, backgroundColor: bg, justifyContent: 'center' }}>
      <T style={{ fontFamily: fonts.semibold, fontSize: 11.5, color: fg }}>{label}</T>
    </View>
  );
}

export function Banner({ kind = 'info', icon, children }: { kind?: 'info' | 'warn' | 'bad'; icon?: ReactNode; children: ReactNode }) {
  const { c } = useTheme();
  const bg = kind === 'warn' ? c.warnBg : kind === 'bad' ? c.badBg : c.chip;
  return (
    <View accessibilityRole={kind === 'bad' ? 'alert' : undefined}
      style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start', borderRadius: 16, padding: 14, backgroundColor: bg }}>
      {icon}
      <View style={{ flex: 1 }}>{children}</View>
    </View>
  );
}

export function BannerText({ strong, rest, kind = 'info' }: { strong?: string; rest?: string; kind?: 'info' | 'warn' | 'bad' }) {
  const { c } = useTheme();
  const col = kind === 'warn' ? c.warnInk : kind === 'bad' ? c.badInk : c.ink;
  return (
    <T style={{ fontSize: 14.5, lineHeight: 20, color: col }}>
      {strong ? <T style={{ fontFamily: fonts.semibold, fontSize: 14.5, color: col }}>{strong} </T> : null}
      {rest}
    </T>
  );
}

// ---------- switch ----------

export function Toggle({ value, onChange, label, android }: { value: boolean; onChange: (v: boolean) => void; label: string; android?: boolean }) {
  const { c } = useTheme();
  if (android) {
    return (
      <Press noScale accessibilityRole="switch" accessibilityState={{ checked: value }} accessibilityLabel={label} onPress={() => onChange(!value)} style={s.target}>
        <View style={{ width: 52, height: 32, borderRadius: 16, backgroundColor: value ? c.ink : c.chip2, borderWidth: value ? 0 : 2, borderColor: c.ink3, justifyContent: 'center' }}>
          <View style={{ position: 'absolute', left: value ? 24 : 6, width: value ? 24 : 16, height: value ? 24 : 16, borderRadius: 12, backgroundColor: value ? c.bg : c.ink3 }} />
        </View>
      </Press>
    );
  }
  return (
    <Press noScale accessibilityRole="switch" accessibilityState={{ checked: value }} accessibilityLabel={label} onPress={() => { haptic.tick(); onChange(!value); }} style={s.target}>
      <View style={{ width: 51, height: 31, borderRadius: 16, backgroundColor: value ? c.good : c.chip2, justifyContent: 'center' }}>
        <View style={{ position: 'absolute', left: value ? 22 : 2, width: 27, height: 27, borderRadius: 14, backgroundColor: '#FFFFFF',
          shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 2, shadowOffset: { width: 0, height: 2 }, elevation: 2 }} />
      </View>
    </Press>
  );
}

// ---------- lists ----------

export function SectionTitle({ children }: { children: string }) {
  const { c } = useTheme();
  return <T accessibilityRole="header" style={{ fontFamily: fonts.semibold, fontSize: 13, color: c.ink2, paddingTop: 22, paddingBottom: 8, paddingHorizontal: 4 }}>{children}</T>;
}

export function ListCard({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const { c } = useTheme();
  return <View style={[{ backgroundColor: c.card, borderRadius: radius.card, overflow: 'hidden' }, style]}>{children}</View>;
}

export function ListItem({ label, sub, value, onPress, right, danger, last, leading, accessibilityLabel }: {
  label: string; sub?: string; value?: string; onPress?: () => void; right?: ReactNode; danger?: boolean; last?: boolean;
  leading?: ReactNode; accessibilityLabel?: string;
}) {
  const { c } = useTheme();
  const body = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingVertical: 10, paddingHorizontal: 16,
      borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth * 2, borderBottomColor: c.hair }}>
      {leading}
      <View style={{ flex: 1 }}>
        <T style={{ fontSize: 16, color: danger ? c.bad : c.ink }}>{label}</T>
        {sub ? <T style={{ fontSize: 13, color: c.ink2, marginTop: 2 }}>{sub}</T> : null}
      </View>
      {value ? <T style={{ fontSize: 15, color: c.ink2 }}>{value}</T> : null}
      {right}
    </View>
  );
  return onPress ? <Press noScale onPress={onPress} accessibilityLabel={accessibilityLabel ?? [label, sub, value].filter(Boolean).join(', ')}>{body}</Press> : body;
}

export const s = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 18, paddingVertical: 4, borderRadius: radius.pill, alignSelf: 'flex-start' },
  cta: { minHeight: 56, paddingVertical: 8, paddingHorizontal: 20, borderRadius: radius.cta, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, overflow: 'hidden' },
  ctaAddShadow: { shadowColor: '#C8401F', shadowOpacity: 0.26, shadowRadius: 9, shadowOffset: { width: 0, height: 8 }, elevation: 4 },
  iconBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  textBtn: { minHeight: 44, minWidth: 44, paddingHorizontal: 6, flexDirection: 'row', alignItems: 'center', gap: 4 },
  // A 44 x 44 pt touch target around a smaller visual control.
  target: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'center' },
  tchip: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 18, paddingVertical: 4 },
  chip: { minHeight: 36, paddingVertical: 4, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 6 },
});

export { type };
