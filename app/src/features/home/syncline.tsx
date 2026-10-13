import { View } from 'react-native';
import { useStore } from '@/store/store';
import { Checks, Clock } from '@/ui/icons';
import { T } from '@/ui/primitives';
import { useTheme } from '@/ui/theme';
import { fonts } from '@/ui/tokens';
import { useHousehold } from '../hooks';

/** One quiet line under "Latest" that says where the data is. */
export function SyncLine() {
  const { c } = useTheme();
  const { h } = useHousehold();
  const recent = useStore((s) => s.recent);
  if (!h) return null;
  const sending = recent.some((r) => r.householdId === h.id && Date.now() - r.at < 8000);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 22 }} accessibilityLiveRegion="polite">
      {sending ? <Clock size={15} color={c.ink2} /> : <Checks size={15} color={c.ink2} />}
      <T style={{ fontSize: 13, color: c.ink2, fontFamily: fonts.medium }}>
        {sending ? 'Saved · Undo is open for a few seconds' : 'Saved on this device'}
      </T>
    </View>
  );
}

