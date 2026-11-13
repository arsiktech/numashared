// The undo lane: after a save, a dark pill offers Undo for 8 seconds with an emptying ring.
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle } from 'react-native-svg';
import { getState, undo, useStore } from '@/store/store';
import { quietOpens, showToast } from '@/store/ui';
import { haptic, Press, T } from './primitives';
import { useTheme } from './theme';
import { alpha, fonts } from './tokens';
import { TEXT_CAP } from './textScale';

const WINDOW = 8000;

export function UndoLane() {
  const { c, layout } = useTheme();
  const insets = useSafeAreaInsets();
  const last = useStore((s) => s.recent[s.recent.length - 1] ?? null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!last) return;
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [last]);
  if (!last) return null;
  const left = WINDOW - (now - last.at);
  if (left <= 0) return null;
  const frac = Math.max(0, left / WINDOW);
  const C = 2 * Math.PI * 9;
  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, bottom: insets.bottom + (layout === 'phone' ? 12 : 24), alignItems: 'center' }}>
      <View accessibilityLiveRegion="polite" style={{ width: layout === 'phone' ? '92%' : 420, minHeight: 56, paddingVertical: 6, borderRadius: 28, backgroundColor: c.lane, flexDirection: 'row', alignItems: 'center', paddingLeft: 18, paddingRight: 6, gap: 10,
        shadowColor: '#000', shadowOpacity: 0.22, shadowRadius: 14, shadowOffset: { width: 0, height: 12 }, elevation: 10 }}>
        <T numberOfLines={2} maxFontSizeMultiplier={TEXT_CAP.label} style={{ flex: 1, color: c.laneInk, fontFamily: fonts.semibold, fontSize: 15 }}>{last.label}</T>
        <Press accessibilityLabel={`Undo ${last.label}`} onPress={() => {
          quietOpens(500);
          const ok = undo(last.eventId);
          haptic.medium();
          showToast(ok ? 'Undone. Nothing was shared.' : 'Already shared. Void it from history.');
          void getState;
        }} style={{ minHeight: 44, paddingLeft: 10, paddingRight: 16, borderRadius: 22, backgroundColor: alpha(c.laneInk, 0.14), flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Svg width={22} height={22} viewBox="0 0 24 24">
            <Circle cx="12" cy="12" r="9" fill="none" stroke={c.laneInk} strokeOpacity={0.25} strokeWidth={2.6} />
            <Circle cx="12" cy="12" r="9" fill="none" stroke={c.laneInk} strokeWidth={2.6} strokeLinecap="round"
              strokeDasharray={`${C}`} strokeDashoffset={C * (1 - frac)} transform="rotate(-90 12 12)" />
          </Svg>
          <T maxFontSizeMultiplier={TEXT_CAP.label} style={{ color: c.laneInk, fontFamily: fonts.bold, fontSize: 16 }}>Undo</T>
        </Press>
      </View>
    </View>
  );
}
