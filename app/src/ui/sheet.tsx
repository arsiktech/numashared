// Sheets. On phones a sheet grows as a circle from the control that opened it (the orb) and folds
// back into it on close; dragging the grabber down slides it away. On a desk the Add sheet becomes a
// popover that grows from the same orb. Reduce Motion replaces both with a short fade.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { BackHandler, PanResponder, Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming, interpolate } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import type { Origin } from '@/store/ui';
import { useTheme } from './theme';
import { haptic } from './primitives';
import { alpha, isWeb } from './tokens';

type SheetCtx = { close: (how?: 'down' | 'done') => void };
const Ctx = createContext<SheetCtx>({ close: () => {} });
export const useSheet = () => useContext(Ctx);

export function Sheet({ origin, onClosed, children, background, height = 'full', popover, washTo, label }: {
  origin?: Origin; onClosed: () => void; children: ReactNode; background?: string;
  /** 'full' covers the screen below the status area; 'auto' hugs its content at the bottom. */
  height?: 'full' | 'auto';
  /** Desk layout: render as a 420 pt popover anchored under the origin. */
  popover?: boolean;
  /** Color the orange wash fades into (the payer's band). */
  washTo?: string;
  label: string;
}) {
  const { c, width: W, height: H, reduceMotion } = useTheme();
  const insets = useSafeAreaInsets();
  const p = useSharedValue(0);
  const drag = useSharedValue(0);
  const [phase, setPhase] = useState<'opening' | 'open' | 'closing'>('opening');
  const closing = useRef(false);
  const bloom = !!origin && !reduceMotion;

  const R = origin ? Math.hypot(Math.max(origin.x, W - origin.x), Math.max(origin.y, H - origin.y)) + 8 : 0;

  useEffect(() => {
    haptic.tap();
    p.value = withTiming(1, { duration: bloom ? 560 : 200, easing: Easing.bezier(0.3, 0.9, 0.25, 1) }, (done) => {
      if (done) runOnJS(setPhase)('open');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finish = useCallback(() => { onClosed(); }, [onClosed]);

  const close = useCallback((how?: 'down' | 'done') => {
    if (closing.current) return;
    closing.current = true;
    setPhase('closing');
    if (how === 'down' || !bloom) {
      drag.value = withTiming(H, { duration: 240, easing: Easing.in(Easing.quad) }, (d) => { if (d) runOnJS(finish)(); });
      p.value = withTiming(0, { duration: 240 });
      return;
    }
    p.value = withTiming(0, { duration: 360, easing: Easing.bezier(0.55, 0, 0.75, 0.1) }, (d) => {
      if (d) { runOnJS(haptic.tap)(); runOnJS(finish)(); }
    });
  }, [bloom, finish, H, drag, p]);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { close('down'); return true; });
    return () => sub.remove();
  }, [close]);

  useEffect(() => {
    if (!isWeb) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  const pan = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_e, g) => g.dy > 6 && Math.abs(g.dy) > Math.abs(g.dx),
    onPanResponderMove: (_e, g) => { drag.value = Math.max(0, g.dy); },
    onPanResponderRelease: (_e, g) => {
      if (g.dy > 110 || g.vy > 1.2) closeRef.current('down');
      else drag.value = withTiming(0, { duration: 200 });
    },
  })).current;
  const closeRef = useRef(close); closeRef.current = close;

  const scrimStyle = useAnimatedStyle(() => ({ opacity: p.value }));
  const panelDrag = useAnimatedStyle(() => ({ transform: [{ translateY: drag.value }] }));
  const fadeIn = useAnimatedStyle(() => (bloom ? {} : { opacity: p.value, transform: [{ translateY: (1 - p.value) * 24 }] }));

  const r0 = origin?.r ?? 0;
  const circle = useAnimatedStyle(() => {
    if (!origin) return {};
    const r = r0 + (R - r0) * p.value;
    return { left: origin.x - r, top: origin.y - r, width: r * 2, height: r * 2, borderRadius: r };
  });
  const inner = useAnimatedStyle(() => {
    if (!origin) return {};
    const r = r0 + (R - r0) * p.value;
    return { left: -(origin.x - r), top: -(origin.y - r) };
  });
  const wash = useAnimatedStyle(() => ({ opacity: phase === 'closing' ? interpolate(p.value, [0, 1], [1, 0]) : interpolate(p.value, [0, 0.3, 1], [1, 1, 0]) }));
  const content = useAnimatedStyle(() => ({ opacity: bloom ? interpolate(p.value, [0, 0.25, 1], [0.2, 0.3, 1]) : 1 }));

  const top = height === 'full' ? Math.max(insets.top - 22, 10) + (isWeb ? 12 : 0) : undefined;

  const panelStyle: StyleProp<ViewStyle> = popover && origin
    ? { position: 'absolute', width: 420, maxWidth: W - 24, left: Math.min(Math.max(12, origin.x - 60), W - 432), top: Math.min(origin.y + origin.r + 8, H - 640), borderRadius: 28, overflow: 'hidden',
      backgroundColor: background ?? c.bg, shadowColor: '#141814', shadowOpacity: 0.28, shadowRadius: 40, shadowOffset: { width: 0, height: 30 } }
    : { position: 'absolute', left: 0, right: 0, bottom: 0, top, borderTopLeftRadius: 30, borderTopRightRadius: 30, overflow: 'hidden', backgroundColor: background ?? c.bg,
      maxWidth: isWeb ? 560 : undefined, alignSelf: 'center', marginHorizontal: 'auto' as never };

  const panel = (
    <Animated.View style={[panelStyle, panelDrag, fadeIn]} accessibilityViewIsModal accessibilityLabel={label}>
      <Animated.View style={[{ flex: height === 'full' ? 1 : undefined }, content]}>
        <Ctx.Provider value={{ close }}>
          <View {...pan.panHandlers}>
            <View style={{ height: 14, alignItems: 'center', justifyContent: 'center' }}>
              <View style={{ width: 38, height: 5, borderRadius: 3, backgroundColor: alpha(background && background !== c.bg ? '#000000' : c.ink, 0.22) }} />
            </View>
          </View>
          {children}
        </Ctx.Provider>
      </Animated.View>
    </Animated.View>
  );

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: popover ? 'rgba(18,20,16,0.18)' : c.scrim }, scrimStyle]}>
        <View style={StyleSheet.absoluteFill} onTouchEnd={() => close()} accessibilityLabel="Close" accessibilityRole="button" />
      </Animated.View>
      {bloom && phase !== 'open' ? (
        <Animated.View style={[{ position: 'absolute', overflow: 'hidden' }, circle]} pointerEvents="box-none">
          <Animated.View style={[{ position: 'absolute', width: W, height: H }, inner]} pointerEvents="box-none">
            {panel}
            <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, wash]}>
              <Svg width={W} height={H}>
                <Defs>
                  <RadialGradient id="wash" cx={origin!.x} cy={origin!.y} r={Math.max(R, 1)} gradientUnits="userSpaceOnUse">
                    <Stop offset="0" stopColor="#FFB59C" stopOpacity={0.95} />
                    <Stop offset="0.12" stopColor="#F66B42" stopOpacity={0.92} />
                    <Stop offset="0.45" stopColor="#E9522D" stopOpacity={0.7} />
                    <Stop offset="1" stopColor={washTo ?? '#E9522D'} stopOpacity={0.2} />
                  </RadialGradient>
                </Defs>
                <Rect x="0" y="0" width={W} height={H} fill="url(#wash)" />
              </Svg>
            </Animated.View>
          </Animated.View>
        </Animated.View>
      ) : panel}
    </View>
  );
}

/** Sheet header row: optional left and right controls with a centered title. */
export function SheetHead({ left, title, right, color }: { left?: ReactNode; title?: string; right?: ReactNode; color?: string }) {
  const { c } = useTheme();
  return (
    <View style={{ height: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 10 }}>
      <View style={{ minWidth: 76, alignItems: 'flex-start' }}>{left}</View>
      {title ? (
        <Animated.Text accessibilityRole="header" style={{ fontFamily: 'Instrument-600', fontSize: 17, color: color ?? c.ink }}>{title}</Animated.Text>
      ) : <View />}
      <View style={{ minWidth: 76, alignItems: 'flex-end' }}>{right}</View>
    </View>
  );
}
