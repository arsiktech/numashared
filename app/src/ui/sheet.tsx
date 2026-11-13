// Sheets. On phones a sheet grows as a circle from the control that opened it (the orb) and folds
// back into it on close; dragging it down anywhere (or pulling down a list inside it that is already
// at its top) slides it away. On a desk the Add sheet becomes a
// popover that grows from the same orb. Reduce Motion replaces both with a short fade.
import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BackHandler, Platform, ScrollView, StyleSheet, View, type ScrollViewProps, type StyleProp, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector, type NativeGesture } from 'react-native-gesture-handler';
import Animated, { Easing, makeMutable, runOnJS, useAnimatedReaction, useAnimatedStyle, useSharedValue, withSpring, withTiming, interpolate, type SharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import type { Origin } from '@/store/ui';
import { useTheme } from './theme';
import { haptic } from './primitives';
import { alpha, isWeb } from './tokens';
import { escapeSheet, ownsSheetFocus, takeSheetFocus } from './sheet-focus';

/**
 * How far a phone sheet covers the screen, 0 to 1. The app shell shrinks the screen behind by it,
 * as iOS does, so the sheet reads as a card on top rather than the screen going dark.
 */
export const sheetBackdrop = makeMutable(0);

type SheetCtx = { close: (how?: 'down' | 'done') => void; escape: () => void; scroll?: { native: NativeGesture; y: SharedValue<number> } };
const Ctx = createContext<SheetCtx>({ close: () => {}, escape: () => {} });
export const useSheet = () => useContext(Ctx);

/**
 * A vertical list inside a sheet. Scrolled to its top, pulling it further down drags the whole sheet
 * instead, as in iOS sheets. Outside a sheet it is a plain ScrollView.
 */
export function SheetScrollView(props: ScrollViewProps) {
  const { scroll } = useSheet();
  if (!scroll) return <ScrollView {...props} />;
  return (
    <GestureDetector gesture={scroll.native}>
      <ScrollView {...props} bounces={false} scrollEventThrottle={16}
        onScroll={(e) => { scroll.y.value = e.nativeEvent.contentOffset.y; props.onScroll?.(e); }} />
    </GestureDetector>
  );
}

export { saveGuard } from './saveGuard';

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
  const focusRoot = useRef<View>(null);
  const [focusReturn] = useState(() => isWeb && typeof document !== 'undefined' ? document.activeElement as HTMLElement | null : null);
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
    const root = focusRoot.current as unknown as HTMLElement | null;
    if (root) return takeSheetFocus(root, focusReturn);
  }, [focusReturn]);

  const escape = useCallback(() => {
    const root = focusRoot.current as unknown as HTMLElement | null;
    if (root && ownsSheetFocus(root)) close();
  }, [close]);

  useEffect(() => {
    if (!isWeb) return;
    const onKey = (e: KeyboardEvent) => {
      const root = focusRoot.current as unknown as HTMLElement | null;
      if (!root || !ownsSheetFocus(root)) return;
      escapeSheet(e, close);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  // Drag down anywhere on the sheet. Taps and sideways swipes (chips, the split bar) stay with the
  // content: the drag only starts after 10 pt downward. A list inside hands over once at its top.
  const closeDown = useCallback(() => close('down'), [close]);
  const scrollY = useSharedValue(0);
  const fromTop = useSharedValue(0);
  const native = useMemo(() => Gesture.Native(), []);
  const pan = useMemo(() => Gesture.Pan()
    .enabled(!popover)
    .activeOffsetY(10)
    .failOffsetY(-10)
    .failOffsetX([-14, 14])
    .simultaneousWithExternalGesture(native)
    .onBegin(() => { fromTop.value = -1; })
    .onUpdate((e) => {
      if (scrollY.value > 0.5) { fromTop.value = -1; return; }
      if (fromTop.value < 0) fromTop.value = e.translationY;
      drag.value = Math.max(0, e.translationY - fromTop.value);
    })
    .onEnd((e) => {
      if (drag.value > 110 || (drag.value > 20 && e.velocityY > 900)) runOnJS(closeDown)();
      else drag.value = withSpring(0, { damping: 22, stiffness: 260 });
    }), [popover, native, closeDown, drag, scrollY, fromTop]);

  const stacked = !isWeb && !popover && height === 'full';
  useAnimatedReaction(() => (stacked ? p.value * (1 - Math.min(1, drag.value / Math.max(H, 1))) : -1), (v) => {
    if (v >= 0) sheetBackdrop.value = v;
  });
  useEffect(() => () => { if (stacked) sheetBackdrop.value = withTiming(0, { duration: 180 }); }, [stacked]);
  const scrimStyle = useAnimatedStyle(() => ({ opacity: p.value * (1 - Math.min(1, drag.value / Math.max(H, 1))) }));
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

  // Below the status bar and Dynamic Island, leaving a strip of the shrunken screen visible.
  const top = height === 'full' ? (isWeb ? Math.max(insets.top - 22, 10) + 12 : insets.top + 10) : undefined;

  const panelStyle: StyleProp<ViewStyle> = popover && origin
    ? { position: 'absolute', width: 420, maxWidth: W - 24, maxHeight: isWeb ? H - 32 : undefined, left: Math.min(Math.max(16, origin.x - 300), W - 436), top: Math.max(16, Math.min(origin.y + origin.r + 12, H - 660)), borderRadius: 28, overflow: 'hidden',
      backgroundColor: background ?? c.bg, shadowColor: '#141814', shadowOpacity: 0.28, shadowRadius: 40, shadowOffset: { width: 0, height: 30 } }
    : { position: 'absolute', left: 0, right: 0, bottom: 0, top, borderTopLeftRadius: 30, borderTopRightRadius: 30, overflow: 'hidden', backgroundColor: background ?? c.bg,
      // No alignSelf here: browsers apply align-self to absolute boxes and would shrink the sheet to
      // its content. Equal insets plus auto margins already center it under the max width.
      maxWidth: isWeb ? 560 : undefined, marginHorizontal: 'auto' as never };

  const ctx = useMemo<SheetCtx>(() => ({ close, escape, scroll: popover ? undefined : { native, y: scrollY } }), [close, escape, popover, native, scrollY]);
  const panel = (
    // While it closes the sheet takes no more input, so a second tap can't act twice.
    <GestureDetector gesture={pan}>
      <Animated.View style={[panelStyle, panelDrag, fadeIn, isWeb && popover ? ({ overflowY: 'auto' } as object) : null]} accessibilityViewIsModal accessibilityLabel={isWeb ? undefined : label}
        pointerEvents={phase === 'closing' ? 'none' : 'auto'}>
        <Animated.View style={[{ flex: height === 'full' ? 1 : undefined }, content]}>
          <Ctx.Provider value={ctx}>
            <View style={{ height: popover ? 6 : 14, alignItems: 'center', justifyContent: 'center', opacity: popover ? 0 : 1 }}>
              <View style={{ width: 38, height: 5, borderRadius: 3, backgroundColor: alpha(background && background !== c.bg ? '#000000' : c.ink, 0.22) }} />
            </View>
            {children}
          </Ctx.Provider>
        </Animated.View>
      </Animated.View>
    </GestureDetector>
  );

  return (
    <View ref={focusRoot} style={StyleSheet.absoluteFill} pointerEvents="box-none"
      role={isWeb ? 'dialog' : undefined} aria-modal={isWeb ? true : undefined}
      accessibilityLabel={isWeb ? label : undefined} tabIndex={isWeb ? -1 : undefined}>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: popover ? 'rgba(18,20,16,0.18)' : stacked ? 'rgba(0,0,0,0.22)' : c.scrim }, scrimStyle]}>
        <View style={StyleSheet.absoluteFill} onTouchEnd={() => close()} accessibilityLabel="Close" accessibilityRole="button" />
      </Animated.View>
      {bloom && phase !== 'open' ? (
        // Keyed so React never reuses the circle's node for the flat panel: Reanimated sets the
        // circle's geometry imperatively, and a reused node would keep it after the bloom ends.
        <Animated.View key="bloom" style={[{ position: 'absolute', overflow: 'hidden' }, circle]} pointerEvents="box-none">
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
      ) : <Fragment key="flat">{panel}</Fragment>}
    </View>
  );
}

/** Sheet header row: optional left and right controls with a centered title. */
export function SheetHead({ left, title, right, color }: { left?: ReactNode; title?: string; right?: ReactNode; color?: string }) {
  const { c } = useTheme();
  return (
    <View style={{ minHeight: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 10 }}>
      <View style={{ minWidth: 76, alignItems: 'flex-start' }}>{left}</View>
      {title ? (
        <Animated.Text accessibilityRole="header" style={{ fontFamily: 'Instrument-600', fontSize: 17, color: color ?? c.ink }}>{title}</Animated.Text>
      ) : <View />}
      <View style={{ minWidth: 76, alignItems: 'flex-end' }}>{right}</View>
    </View>
  );
}
