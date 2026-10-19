// One stroke icon set for every platform (react-native-svg). Icons inherit a color prop.
import { Platform } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

// Icons are decorative: the control around them carries the label.
const hidden = Platform.OS === 'web' ? ({ 'aria-hidden': true } as object) : { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const };
import type { Category } from '@/core/types';

type P = { size?: number; color: string; strokeWidth?: number };

const S = ({ size = 22, color, strokeWidth = 2, children }: P & { children: React.ReactNode }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth}
    strokeLinecap="round" strokeLinejoin="round" {...hidden}>
    {children}
  </Svg>
);

export const Plus = (p: P) => <S strokeWidth={2.6} {...p}><Path d="M12 5v14M5 12h14" /></S>;
export const ChevDown = (p: P) => <S strokeWidth={2.4} {...p}><Path d="m6 9 6 6 6-6" /></S>;
export const ChevUp = (p: P) => <S strokeWidth={2.4} {...p}><Path d="m6 15 6-6 6 6" /></S>;
export const ChevRight = (p: P) => <S strokeWidth={2.2} {...p}><Path d="m9 6 6 6-6 6" /></S>;
export const Back = (p: P) => <S strokeWidth={2.4} {...p}><Path d="m15 5-7 7 7 7" /></S>;
export const ArrowBack = (p: P) => <S {...p}><Path d="M19 12H5M11 18l-6-6 6-6" /></S>;
export const ArrowRight = (p: P) => <S strokeWidth={2.2} {...p}><Path d="M5 12h14M13 6l6 6-6 6" /></S>;
export const Close = (p: P) => <S strokeWidth={2.2} {...p}><Path d="M6 6l12 12M18 6 6 18" /></S>;
export const People = (p: P) => (
  <S {...p}><Circle cx="9" cy="8" r="3.5" /><Path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5" /><Circle cx="17" cy="9" r="2.6" /><Path d="M17.5 14.6c2.2.3 3.6 1.9 4 4.4" /></S>
);
export const ArrowDown = (p: P) => <S strokeWidth={2.4} {...p}><Path d="M12 5v14M6 13l6 6 6-6" /></S>;
export const ArrowUp = (p: P) => <S strokeWidth={2.4} {...p}><Path d="M12 19V5M6 11l6-6 6 6" /></S>;
export const Check = (p: P) => <S strokeWidth={2.6} {...p}><Path d="m5 12.5 4.5 4.5L19 7.5" /></S>;
export const Checks = (p: P) => <S strokeWidth={2.4} {...p}><Path d="m2 12.5 4.5 4.5L15 8.5M10 16l1 1 9-9.5" /></S>;
export const Clock = (p: P) => <S strokeWidth={2.2} {...p}><Circle cx="12" cy="12" r="9" /><Path d="M12 7v5l3 2" /></S>;
export const Search = (p: P) => <S strokeWidth={2.2} {...p}><Circle cx="11" cy="11" r="7" /><Path d="m20 20-4-4" /></S>;
export const Gear = (p: P) => (
  <S {...p}><Circle cx="12" cy="12" r="3" /><Path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></S>
);
export const Share = (p: P) => <S {...p}><Path d="M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" /></S>;
export const Copy = (p: P) => <S {...p}><Rect x="9" y="9" width="11" height="11" rx="2.5" /><Path d="M15 9V6.5A2.5 2.5 0 0 0 12.5 4h-6A2.5 2.5 0 0 0 4 6.5v6A2.5 2.5 0 0 0 6.5 15H9" /></S>;
export const Lock = (p: P) => <S {...p}><Rect x="5" y="11" width="14" height="10" rx="2.5" /><Path d="M8 11V8a4 4 0 0 1 8 0v3" /></S>;
export const CloudOff = (p: P) => <S {...p}><Path d="M3 3l18 18M8.5 6.3A6 6 0 0 1 17.7 10H18a4 4 0 0 1 2.3 7.3M17 19H7a5 5 0 0 1-2.4-9.4" /></S>;
export const Warn = (p: P) => <S {...p}><Path d="M12 3 2 20h20zM12 10v4" /><Circle cx="12" cy="17" r=".8" fill={p.color} /></S>;
export const Download = (p: P) => <S {...p}><Path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></S>;
export const Bell = (p: P) => <S {...p}><Path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9M10 20a2 2 0 0 0 4 0" /></S>;
export const Eye = (p: P) => <S {...p}><Path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><Circle cx="12" cy="12" r="3" /></S>;
export const Pencil = (p: P) => <S {...p}><Path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" /></S>;
export const VoidX = (p: P) => <S {...p}><Circle cx="12" cy="12" r="9" /><Path d="M5.6 5.6l12.8 12.8" /></S>;
export const Backspace = (p: P) => <S strokeWidth={1.8} {...p}><Path d="M21 5H9l-6 7 6 7h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1zM17 9l-5 6M12 9l5 6" /></S>;
export const Mail = (p: P) => <S {...p}><Rect x="3" y="5" width="18" height="14" rx="2.5" /><Path d="m4 7 8 6 8-6" /></S>;
export const Repay = (p: P) => <S {...p}><Path d="M4 8h13l-3-3M20 16H7l3 3" /></S>;
export const House = (p: P) => <S {...p}><Path d="M4 20h16M6 20V9l6-5 6 5v11M10 20v-6h4v6" /></S>;
export const Grip = (p: P) => <S {...p}><Path d="M5 8h14M5 12h14M5 16h14" /></S>;
export const Moon = (p: P) => <S {...p}><Path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" /></S>;
export const Dots = (p: P) => (
  <S {...p}><Circle cx="6" cy="12" r="1.3" fill={p.color} /><Circle cx="12" cy="12" r="1.3" fill={p.color} /><Circle cx="18" cy="12" r="1.3" fill={p.color} /></S>
);
export const Apple = ({ size = 18, color }: P) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill={color} {...hidden}>
    <Path d="M16.4 12.6c0-2.6 2.1-3.8 2.2-3.9-1.2-1.8-3.1-2-3.7-2-1.6-.2-3.1.9-3.9.9-.8 0-2-.9-3.4-.9-1.7 0-3.3 1-4.2 2.6-1.8 3.1-.5 7.7 1.3 10.2.9 1.2 1.9 2.6 3.2 2.6 1.3-.1 1.8-.8 3.3-.8 1.6 0 2 .8 3.4.8 1.4 0 2.3-1.3 3.1-2.5 1-1.4 1.4-2.8 1.4-2.9-.1 0-2.7-1-2.7-4.1zM13.9 5c.7-.9 1.2-2 1-3.2-1 0-2.3.7-3 1.6-.7.8-1.2 2-1.1 3.1 1.2.1 2.3-.6 3.1-1.5z" />
  </Svg>
);

const CAT: Record<Category, (p: P) => React.ReactElement> = {
  groceries: (p) => <S {...p}><Path d="M3 4h2.5l2.2 11h10.6L20.5 8H7" /><Circle cx="9.5" cy="19.5" r="1.5" /><Circle cx="17" cy="19.5" r="1.5" /></S>,
  household: (p) => <House {...p} />,
  rent: (p) => <S {...p}><Circle cx="8" cy="15" r="4" /><Path d="M11 12l9-9M17 6l3 3M15 8l2 2" /></S>,
  bills: (p) => <S {...p}><Path d="M13 2 4 14h7l-1 8 9-12h-7z" /></S>,
  internet: (p) => <S {...p}><Path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.7 16a5 5 0 0 1 6.6 0" /><Circle cx="12" cy="19.3" r="1.2" fill={p.color} stroke="none" /></S>,
  'eating-out': (p) => <S {...p}><Path d="M6 3v7a2 2 0 0 0 4 0V3M8 10v11M17 3c-1.7 1.5-2.5 4-2.5 7h2.5v11" /></S>,
  cleaning: (p) => <S {...p}><Path d="M8 9h6l1 3v9H7v-9zM9 9V6h4v3M13 6h3l2-2M17 8h2M17 11l1.5 1" /></S>,
  other: (p) => <Dots {...p} />,
};

export const CategoryIcon = ({ category, ...p }: P & { category: Category }) => CAT[category](p);
