// A day heading drawn as a small ink stamp ("YESTERDAY", "THU 12 NOV"), tilted a little.
// Used by the phone's Latest list and the desk history.
import { View } from 'react-native';
import { T } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { space, text } from '@/ui/scale';

export function DayStamp({ label, first }: { label: string; first?: boolean }) {
  const { ui } = useTheme();
  return (
    <View style={{ paddingTop: first ? space[2] : space[5], paddingBottom: space[2], alignItems: 'flex-start' }}>
      <View style={{ backgroundColor: ui.ink, borderRadius: space[1] + 2, paddingHorizontal: space[2] + 2, paddingTop: space[1] + 1, paddingBottom: space[1], transform: [{ rotate: '-2deg' }] }}>
        <T accessibilityRole="header" style={[text.label, { color: ui.canvas }]}>{label}</T>
      </View>
    </View>
  );
}
