import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { AccessibilityInfo, useColorScheme, useWindowDimensions } from 'react-native';
import { useEffect, useState } from 'react';
import { useStore } from '@/store/store';
import type { Group, GroupColor } from '@/core/types';
import { dark, groupTone, light, type GroupTone, type Palette } from './tokens';
import { isLargeText } from './textScale';

type Theme = {
  c: Palette;
  isDark: boolean;
  tone: (g: Group | GroupColor) => GroupTone;
  reduceMotion: boolean;
  /** Layout class from the window width: phone < 760 <= tablet < 1180 <= desk. */
  layout: 'phone' | 'tablet' | 'desk';
  width: number;
  height: number;
  /** The system text size: 1 by default, about 3.1 at the largest accessibility size. */
  fontScale: number;
  /** An accessibility text size (AX1 and up): Home and Add use layouts that grow with the text. */
  largeText: boolean;
};

const ThemeContext = createContext<Theme | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const scheme = useColorScheme();
  const appearance = useStore((s) => s.prefs.appearance);
  const { width, height, fontScale } = useWindowDimensions();
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion).catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => sub.remove();
  }, []);
  const isDark = appearance === 'system' ? scheme === 'dark' : appearance === 'dark';
  const value = useMemo<Theme>(() => ({
    c: isDark ? dark : light,
    isDark,
    tone: (g) => groupTone(typeof g === 'string' ? g : g.color, isDark),
    reduceMotion,
    layout: width >= 1180 ? 'desk' : width >= 760 ? 'tablet' : 'phone',
    width,
    height,
    fontScale,
    largeText: isLargeText(fontScale),
  }), [isDark, reduceMotion, width, height, fontScale]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  const t = useContext(ThemeContext);
  if (!t) throw new Error('useTheme outside ThemeProvider');
  return t;
}
