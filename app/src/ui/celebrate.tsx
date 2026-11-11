// The "All square" moment after a repayment settles everyone, plus the small toast.
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut, ZoomIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { activeHousehold, useStore, yourGroup } from '@/store/store';
import { clearToast, endCelebrate, useUI } from '@/store/ui';
import { CTA, haptic, T } from './primitives';
import { useTheme } from './theme';
import { fonts } from './tokens';

const DOTS = [
  [300, 120, 14, 1], [340, 200, 9, 2], [250, 250, 11, 1], [190, 150, 8, 0], [318, 300, 12, 1], [230, 330, 7, 2],
  [40, 490, 12, 0], [120, 520, 8, 2], [300, 560, 14, 0], [350, 500, 9, 0], [210, 600, 10, 1], [80, 230, 10, 1],
];

export function Celebrate() {
  const key = useUI((u) => u.celebrate);
  const h = useStore(activeHousehold);
  const { c, tone, width, height, reduceMotion } = useTheme();
  const insets = useSafeAreaInsets();
  useEffect(() => { if (key) haptic.success(); }, [key]);
  if (!key || !h) return null;
  const mine = yourGroup(h);
  const other = h.groups.find((g) => g.id !== mine.id) ?? mine;
  const a = tone(mine), b = tone(other);
  const split = Math.round(height * 0.5);
  const big = Math.min(148, width * 0.38);
  return (
    <Animated.View entering={reduceMotion ? undefined : FadeIn.duration(200)} exiting={FadeOut.duration(200)}
      style={[StyleSheet.absoluteFill, { zIndex: 50 }]} accessibilityViewIsModal accessibilityLabel="All square. Nobody owes anybody.">
      <View style={{ height: split, backgroundColor: a.band, justifyContent: 'flex-end', paddingHorizontal: 22, paddingBottom: 34 }}>
        <Animated.Text entering={reduceMotion ? undefined : ZoomIn.springify()} style={{ fontFamily: fonts.cond, fontSize: big, lineHeight: big * 0.86, color: a.ink }}>All</Animated.Text>
      </View>
      <View style={{ flex: 1, backgroundColor: b.band, paddingHorizontal: 22, paddingTop: 30 }}>
        <Animated.Text entering={reduceMotion ? undefined : ZoomIn.delay(120).springify()} style={{ fontFamily: fonts.cond, fontSize: big, lineHeight: big * 0.86, color: b.ink }}>square</Animated.Text>
        <View style={{ marginTop: 'auto', paddingBottom: insets.bottom + 16, gap: 14, maxWidth: 520 }}>
          <T style={{ fontFamily: fonts.semibold, fontSize: 17, color: b.ink }}>Nobody owes anybody.</T>
          <CTA label="Done" onPress={endCelebrate} />
        </View>
      </View>
      {reduceMotion ? null : DOTS.map(([x, y, s, k], i) => (
        <Animated.View key={i} entering={ZoomIn.delay(80 + i * 30)} style={{ position: 'absolute', left: (x / 390) * width, top: (y / 844) * height, width: s, height: s, borderRadius: s / 2,
          backgroundColor: k === 0 ? a.deep : k === 1 ? b.deep : '#E9522D' }} />
      ))}
      <View style={{ position: 'absolute' }}><T style={{ color: c.ink, fontSize: 1 }}> </T></View>
    </Animated.View>
  );
}

export function Toast() {
  const toast = useUI((u) => u.toast);
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(clearToast, 2600);
    return () => clearTimeout(t);
  }, [toast]);
  if (!toast) return null;
  return (
    <Animated.View key={toast.key} entering={FadeIn} exiting={FadeOut} pointerEvents="none" accessibilityLiveRegion="polite"
      style={{ position: 'absolute', top: insets.top + 8, alignSelf: 'center', backgroundColor: c.lane, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, zIndex: 60 }}>
      <T style={{ color: c.laneInk, fontFamily: fonts.semibold, fontSize: 14.5 }}>{toast.text}</T>
    </Animated.View>
  );
}
