// Settings building blocks. iOS (and phone web): grouped cards with chevrons. Android: a Material
// list with leading icons and inset dividers. Tablet and desk web: the settings shell with the top
// bar, a section nav on the left and the content column on the right.
import { type ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevRight } from '@/ui/icons';
import { Press, T } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { fonts, isAndroid } from '@/ui/tokens';
import { ScreenHeader } from '@/features/onboarding/chrome';
import { WebTopBar } from '@/features/web/topbar';

export const useDesk = () => {
  const { layout } = useTheme();
  return layout !== 'phone';
};

/** A titled group of rows. */
export function SGroup({ title, children, first }: { title?: string; children: ReactNode; first?: boolean }) {
  const { c } = useTheme();
  const desk = useDesk();
  if (isAndroid && !desk) {
    return (
      <View style={{ paddingBottom: 8 }}>
        {title ? <T accessibilityRole="header" style={{ fontFamily: fonts.semibold, fontSize: 14, color: c.ink2, paddingTop: 16, paddingBottom: 8, paddingHorizontal: 16 }}>{title}</T> : null}
        {children}
      </View>
    );
  }
  return (
    <View>
      {title ? (
        <T accessibilityRole="header" style={{ fontFamily: fonts.semibold, fontSize: 13, color: c.ink2, paddingTop: first ? 8 : 20, paddingBottom: 6, paddingHorizontal: 4 }}>{title}</T>
      ) : null}
      <View style={{ backgroundColor: c.card, borderRadius: 18, overflow: 'hidden' }}>{children}</View>
    </View>
  );
}

/** One settings row. Pass `onPress` to make it a button; `right` replaces the chevron. */
export function SRow({ label, sub, value, icon, onPress, right, danger, last, first, a11y, chevron = true, children }: {
  label: string; sub?: string; value?: string; icon?: ReactNode; onPress?: () => void; right?: ReactNode; danger?: boolean;
  last?: boolean; first?: boolean; a11y?: string; chevron?: boolean; children?: ReactNode;
}) {
  const { c } = useTheme();
  const desk = useDesk();
  const material = isAndroid && !desk;
  const labelColor = danger ? c.bad : c.ink;
  const body = material ? (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 16, paddingVertical: 10, minHeight: sub ? 64 : 56 }}>
      {!first ? <View style={{ position: 'absolute', left: 56, right: 0, top: 0, height: 1, backgroundColor: c.hair }} /> : null}
      <View style={{ width: 24, alignItems: 'center' }}>{icon}</View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <T style={{ fontFamily: fonts.medium, fontSize: 16, lineHeight: 20, color: labelColor }}>{label}</T>
        {sub || value ? <T style={{ fontSize: 14, lineHeight: 18, color: c.ink2, marginTop: 2 }}>{[value, sub].filter(Boolean).join(' · ')}</T> : null}
        {children}
      </View>
      {right}
    </View>
  ) : (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, paddingVertical: 10, paddingHorizontal: 16,
      borderBottomWidth: last ? 0 : 1, borderBottomColor: c.hair }}>
      {desk && icon ? <View style={{ width: 22, alignItems: 'center' }}>{icon}</View> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <T style={{ fontSize: 16, lineHeight: 21, color: labelColor }}>{label}</T>
        {sub ? <T style={{ fontSize: 13, lineHeight: 17, color: c.ink2, marginTop: 2 }}>{sub}</T> : null}
        {children}
      </View>
      {value ? <T numberOfLines={1} style={{ fontSize: 15, color: c.ink2, flexShrink: 1, maxWidth: '50%', textAlign: 'right' }}>{value}</T> : null}
      {right ?? (onPress && chevron ? <ChevRight size={18} color={c.ink3} /> : null)}
    </View>
  );
  if (!onPress) return <View accessible={!children && !right} accessibilityLabel={a11y ?? [label, value, sub].filter(Boolean).join(', ')}>{body}</View>;
  return <Press noScale onPress={onPress} accessibilityLabel={a11y ?? [label, value, sub].filter(Boolean).join(', ')}>{body}</Press>;
}

/** A note inside a group, under the rows. */
export function SNote({ children }: { children: string }) {
  const { c } = useTheme();
  const material = isAndroid && !useDesk();
  return <T style={{ fontSize: 13.5, lineHeight: 19, color: c.ink2, paddingHorizontal: 16, paddingVertical: 14, paddingLeft: material ? 56 : 16 }}>{children}</T>;
}

export type DeskSection = 'household' | 'people' | 'you' | 'data' | 'account';

const NAV: { key: DeskSection; label: string; href: '/settings' | '/settings/people' | '/settings/export' | '/settings?section=you' | '/settings?section=account' }[] = [
  { key: 'household', label: 'Household', href: '/settings' },
  { key: 'people', label: 'People and groups', href: '/settings/people' },
  { key: 'you', label: 'You', href: '/settings?section=you' },
  { key: 'data', label: 'Data and export', href: '/settings/export' },
  { key: 'account', label: 'Account', href: '/settings?section=account' },
];

/**
 * Page frame for the settings screens. Phones get the back header and a scrolling list; tablet and
 * desk get the top bar, the section nav and a 720 pt content column.
 */
export function SettingsShell({ title, back, active, children, footer, onSection }: {
  title: string; back: string; active: DeskSection; children: ReactNode; footer?: ReactNode;
  onSection?: (s: DeskSection) => boolean;
}) {
  const { c, layout } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  if (layout === 'phone') {
    return (
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingTop: Math.max(insets.top, 12), paddingHorizontal: isAndroid ? 0 : 16, paddingBottom: footer ? 20 : insets.bottom + 32 }}>
          <View style={{ paddingHorizontal: isAndroid ? 16 : 4 }}><ScreenHeader title={title} back={back} /></View>
          {children}
        </ScrollView>
        {footer ? <View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: Math.max(insets.bottom + 4, 16), backgroundColor: c.bg }}>{footer}</View> : null}
      </View>
    );
  }
  const desk = layout === 'desk';
  return (
    <View style={{ flex: 1, backgroundColor: c.dark ? c.bg : '#F1EFE8' }}>
      <WebTopBar />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingVertical: 40, paddingHorizontal: 24 }}>
        <View style={{ width: '100%', maxWidth: 1100, alignSelf: 'center', flexDirection: desk ? 'row' : 'column', gap: desk ? 48 : 20, alignItems: 'flex-start' }}>
          <View accessibilityRole="tablist" accessibilityLabel="Settings sections"
            style={desk ? { width: 220, gap: 4 } : { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {NAV.map((n) => {
              const on = n.key === active;
              return (
                <Press key={n.key} noScale accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={n.label}
                  onPress={() => { if (!onSection?.(n.key)) router.navigate(n.href); }}
                  style={desk
                    ? { minHeight: 44, borderRadius: 12, justifyContent: 'center', paddingHorizontal: 14, backgroundColor: on ? c.chip2 : 'transparent' }
                    : { minHeight: 44, borderRadius: 22, justifyContent: 'center', paddingHorizontal: 16, backgroundColor: on ? c.ink : 'transparent', borderWidth: on ? 0 : 1.5, borderColor: c.hair }}>
                  <T style={{ fontFamily: on ? fonts.semibold : fonts.medium, fontSize: 15.5, color: on ? (desk ? c.ink : c.bg) : c.ink2 }}>{n.label}</T>
                </Press>
              );
            })}
          </View>
          <View style={{ flex: desk ? 1 : undefined, width: desk ? undefined : '100%', minWidth: 0, maxWidth: 720 }}>
            <T accessibilityRole="header" style={{ fontFamily: fonts.cond, fontSize: 40, lineHeight: 42, marginBottom: 14 }}>{title}</T>
            {children}
            {footer ? <View style={{ marginTop: 24, maxWidth: 360 }}>{footer}</View> : null}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

/** Quiet information panel; on the desk frame it sits on a card so it stays visible. */
export function SInfo({ icon, children }: { icon?: ReactNode; children: string }) {
  const { c } = useTheme();
  const desk = useDesk();
  return (
    <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start', borderRadius: 16, padding: 14, backgroundColor: desk && !c.dark ? c.card : c.chip }}>
      {icon}
      <T style={{ flex: 1, fontSize: 14.5, lineHeight: 20 }}>{children}</T>
    </View>
  );
}

/** Background for secondary pills: chip on paper, card on the desk frame. */
export const usePillBg = () => {
  const { c } = useTheme();
  return useDesk() && !c.dark ? c.card : c.chip;
};
