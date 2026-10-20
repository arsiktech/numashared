// Screen chrome shared by the setup, join and settings screens: the back header (iOS text back
// with a large condensed title, Android arrow with a left-aligned title), a scrolling body with a
// pinned footer on phones, and the form pieces (label, text field, segmented control, select row).
import { useState, type ReactNode } from 'react';
import {
  KeyboardAvoidingView, ScrollView, TextInput, View, type StyleProp, type TextInputProps,
  type TextStyle, type ViewStyle,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowBack, Back, ChevDown, ChevUp } from '@/ui/icons';
import { IconButton, OrbView, Press, T } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { fonts, isAndroid, isIOS, isWeb, radius } from '@/ui/tokens';

/** Back control and screen title. `back` is the label of the place you return to. */
/** `back={null}` leaves the Back control out, for a step that can't be undone by going back. */
export function ScreenHeader({ title, back = 'Back', onBack, titleSize = 40 }: {
  title: string; back?: string | null; onBack?: () => void; titleSize?: number;
}) {
  const { c } = useTheme();
  const router = useRouter();
  const go = onBack ?? (() => (router.canGoBack() ? router.back() : router.replace('/')));
  const a11y = back === 'Back' ? 'Back' : `Back to ${back}`;
  if (back === null) {
    return title ? (
      <T accessibilityRole="header" maxFontSizeMultiplier={1.4}
        style={{ fontFamily: fonts.cond, fontSize: titleSize, lineHeight: titleSize * 1.05, marginTop: 8 }}>{title}</T>
    ) : null;
  }
  if (isAndroid) {
    return (
      <View style={{ minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: -12 }}>
        <IconButton label={a11y} onPress={go}><ArrowBack size={24} color={c.ink} /></IconButton>
        <T accessibilityRole="header" style={{ flex: 1, fontFamily: fonts.semibold, fontSize: 22, lineHeight: 28, paddingLeft: 8 }}>{title}</T>
      </View>
    );
  }
  return (
    <View>
      <Press onPress={go} accessibilityLabel={a11y} accessibilityRole="link"
        style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', marginLeft: -4, paddingRight: 10 }}>
        <Back size={22} color={c.ink} />
        <T style={{ fontSize: 17 }}>{back}</T>
      </Press>
      {title ? (
        <T accessibilityRole="header" maxFontSizeMultiplier={1.4}
          style={{ fontFamily: fonts.cond, fontSize: titleSize, lineHeight: titleSize * 1.05, marginTop: 8 }}>{title}</T>
      ) : null}
    </View>
  );
}

/**
 * A form screen. Phones scroll the body and pin the footer above the home indicator; tablet and desk
 * web centre a 560 pt column and let the footer follow the content.
 */
export function Screen({ header, children, footer, padX = 20 }: {
  header?: ReactNode; children: ReactNode; footer?: ReactNode; padX?: number;
}) {
  const { c, layout } = useTheme();
  const insets = useSafeAreaInsets();
  const phone = layout === 'phone';
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: c.bg }} behavior={isIOS ? 'padding' : undefined}>
      <ScrollView keyboardShouldPersistTaps="handled" style={{ flex: 1 }}
        contentContainerStyle={{
          paddingTop: phone ? Math.max(insets.top, 12) : 48, paddingHorizontal: padX,
          paddingBottom: phone && footer ? 20 : insets.bottom + 48,
          width: '100%', maxWidth: phone ? undefined : 560 + padX * 2, alignSelf: 'center',
        }}>
        {header}
        {children}
        {!phone && footer ? <View style={{ marginTop: 32 }}>{footer}</View> : null}
      </ScrollView>
      {phone && footer ? (
        <View style={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: Math.max(insets.bottom + 4, 16), backgroundColor: c.bg }}>{footer}</View>
      ) : null}
    </KeyboardAvoidingView>
  );
}

export function Label({ children, nativeID, style }: { children: string; nativeID?: string; style?: StyleProp<TextStyle> }) {
  const { c } = useTheme();
  return <T nativeID={nativeID} style={[{ fontFamily: fonts.semibold, fontSize: 13, color: c.ink2, marginTop: 18, marginBottom: 8, marginHorizontal: 4 }, style]}>{children}</T>;
}

export function Caption({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  const { c } = useTheme();
  return <T style={[{ fontFamily: fonts.semibold, fontSize: 12.5, lineHeight: 17, color: c.ink2, marginTop: 8, marginHorizontal: 4 }, style]}>{children}</T>;
}

/** Text field: a card with a hairline that turns into a 2 pt ink ring while focused. */
export function Field({ style, inputStyle, ...p }: TextInputProps & { style?: StyleProp<ViewStyle>; inputStyle?: StyleProp<TextStyle> }) {
  const { c } = useTheme();
  const [focus, setFocus] = useState(false);
  return (
    <View style={[{ minHeight: 56, borderRadius: radius.field, backgroundColor: c.card, borderWidth: focus ? 2 : 1,
      borderColor: focus ? c.ink : c.hair, paddingHorizontal: focus ? 15 : 16, justifyContent: 'center' }, style]}>
      <TextInput placeholderTextColor={c.ink3} selectionColor={c.ink} cursorColor={c.ink}
        {...p}
        onFocus={(e) => { setFocus(true); p.onFocus?.(e); }}
        onBlur={(e) => { setFocus(false); p.onBlur?.(e); }}
        style={[{ fontFamily: fonts.regular, fontSize: 17, color: c.ink, paddingVertical: 14 },
          isWeb ? ({ outlineStyle: 'none' } as unknown as TextStyle) : null, inputStyle]} />
    </View>
  );
}

/** iOS-style segmented control on a chip track. Each option is a radio. */
export function Segmented<V extends string>({ options, value, onChange, label, track }: {
  options: { value: V; label: string }[]; value: V; onChange: (v: V) => void; label: string; track?: string;
}) {
  const { c } = useTheme();
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label}
      style={{ flexDirection: 'row', backgroundColor: track ?? c.chip, borderRadius: 14, padding: 3, gap: 3 }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Press key={o.value} noScale accessibilityRole="radio" accessibilityState={{ checked: on, selected: on }} accessibilityLabel={o.label}
            onPress={() => onChange(o.value)}
            style={{ flex: 1, minHeight: 44, borderRadius: 11, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6,
              backgroundColor: on ? c.card : 'transparent',
              shadowColor: '#000', shadowOpacity: on ? 0.12 : 0, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: on ? 1 : 0 }}>
            <T style={{ fontFamily: fonts.semibold, fontSize: 15, color: on ? c.ink : c.ink2, textAlign: 'center' }}>{o.label}</T>
          </Press>
        );
      })}
    </View>
  );
}

/** A select row that opens an inline list of options under it. */
export function Select<V extends string>({ value, options, onChange, label, disabled, right }: {
  value: V; options: { value: V; label: string }[]; onChange: (v: V) => void; label: string; disabled?: boolean; right?: ReactNode;
}) {
  const { c } = useTheme();
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value)?.label ?? value;
  return (
    <View style={{ borderRadius: radius.field, backgroundColor: c.card, borderWidth: 1, borderColor: open ? c.ink : c.hair, overflow: 'hidden' }}>
      <Press noScale disabled={disabled} onPress={() => setOpen(!open)} accessibilityLabel={`${label}: ${current}`}
        accessibilityState={{ expanded: open, disabled: !!disabled }}
        style={{ minHeight: 54, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 15, gap: 10 }}>
        <T style={{ flex: 1, fontSize: 17, paddingVertical: 12 }}>{current}</T>
        {right ?? (disabled ? null : open ? <ChevUp size={18} color={c.ink2} /> : <ChevDown size={18} color={c.ink2} />)}
      </Press>
      {open ? (
        <View accessibilityRole="radiogroup" accessibilityLabel={label} style={{ borderTopWidth: 1, borderTopColor: c.hair }}>
          {options.map((o, i) => {
            const on = o.value === value;
            return (
              <Press key={o.value} noScale accessibilityRole="radio" accessibilityState={{ checked: on }} accessibilityLabel={o.label}
                onPress={() => { onChange(o.value); setOpen(false); }}
                style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 15, gap: 12,
                  backgroundColor: on ? c.chip : 'transparent', borderTopWidth: i ? 1 : 0, borderTopColor: c.hair }}>
                <View style={{ width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: on ? c.ink : c.ink3, alignItems: 'center', justifyContent: 'center' }}>
                  {on ? <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: c.ink }} /> : null}
                </View>
                <T style={{ flex: 1, fontSize: 16, paddingVertical: 10, fontFamily: on ? fonts.semibold : fonts.regular }}>{o.label}</T>
              </Press>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

/** Brand mark used on web pages: a small orb and the product name. */
export function Brand({ size = 30 }: { size?: number }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <MiniOrb size={size} />
      <T style={{ fontFamily: fonts.display, fontSize: 19, letterSpacing: -0.4 }}>Numa Shared</T>
    </View>
  );
}

/** The orb without the plus sign, as a decorative mark. */
export function MiniOrb({ size = 30 }: { size?: number }) {
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" {...(isWeb ? { 'aria-hidden': true } : {})}>
      <OrbView size={size} plus={0} />
    </View>
  );
}
