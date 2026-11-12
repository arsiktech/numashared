// A keyboard key hint ("N", "/", "Esc") for web shortcuts. `onFill` draws it on the accent button.
import { View } from 'react-native';
import { T } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { space, text } from '@/ui/scale';

export function Kbd({ k, onFill }: { k: string; onFill?: boolean }) {
  const { ui } = useTheme();
  const ink = onFill ? ui.onFill : ui.muted;
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      style={{ minWidth: space[5], height: space[5], paddingHorizontal: space[1], borderRadius: space[1], alignItems: 'center', justifyContent: 'center',
        borderWidth: 1, borderColor: onFill ? ui.onFill : ui.line }}>
      <T style={[text.meta, { lineHeight: space[4], color: ink }]}>{k}</T>
    </View>
  );
}
