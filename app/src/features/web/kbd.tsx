// A keyboard key hint ("N", "/", "Esc") for web shortcuts.
import { View } from 'react-native';
import { T } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { fonts } from '@/ui/tokens';

export function Kbd({ k, onInk }: { k: string; onInk?: boolean }) {
  const { c } = useTheme();
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      style={{ minWidth: 22, height: 22, paddingHorizontal: 6, borderRadius: 6, alignItems: 'center', justifyContent: 'center',
        backgroundColor: onInk ? c.bg : c.card, borderWidth: onInk ? 0 : 1, borderColor: c.hair }}>
      <T style={{ fontFamily: fonts.semibold, fontSize: 12, lineHeight: 16, color: onInk ? c.ink : c.ink2 }}>{k}</T>
    </View>
  );
}
