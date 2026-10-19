import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { AccessibilityInfo, useColorScheme, useWindowDimensions } from 'react-native';
import { useEffect, useState } from 'react';
import { useStore } from '@/store/store';
import type { Group, GroupColor } from '@/core/types';
import { dark, groupTone, light, type GroupTone, type Palette } from './tokens';

type Theme = {
  c: Palette;
  isDark: boolean;
  tone: (g: Group | GroupColor) => GroupTone;
  reduceMotion: boolean;
  /** Layout class from the window width: phone < 760 <= tablet < 1180 <= desk. */
  layout: 'phone' | 'tablet' | 'desk';
  width: number;
  height: number;
};

const ThemeContext = createContext<Theme | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const scheme = useColorScheme();
  const appearance = useStore((s) => s.prefs.appearance);
  const { width, height } = useWindowDimensions();
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
  }), [isDark, reduceMotion, width, height]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  const t = useContext(ThemeContext);
  if (!t) throw new Error('useTheme outside ThemeProvider');
  return t;
}
