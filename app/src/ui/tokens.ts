// Design tokens: the same values as the approved canvas (direction B "Color is who").
// Color always means a group of people, never debt direction. Orange means one thing: add an expense.
import { Platform, type TextStyle } from 'react-native';
import type { GroupColor } from '@/core/types';

export const fonts = {
  cond: 'BricolageCondensed',      // names, titles, big amounts on bands
  display: 'Bricolage',            // sentence, amounts
  regular: 'Instrument-400',
  medium: 'Instrument-500',
  semibold: 'Instrument-600',
  bold: 'Instrument-700',
} as const;

export const fontFiles = {
  [fonts.cond]: require('../../assets/fonts/BricolageCondensed-ExtraBold.ttf'),
  [fonts.display]: require('../../assets/fonts/Bricolage-ExtraBold.ttf'),
  [fonts.regular]: require('../../assets/fonts/InstrumentSans-Regular.ttf'),
  [fonts.medium]: require('../../assets/fonts/InstrumentSans-Medium.ttf'),
  [fonts.semibold]: require('../../assets/fonts/InstrumentSans-SemiBold.ttf'),
  [fonts.bold]: require('../../assets/fonts/InstrumentSans-Bold.ttf'),
};

export type Palette = {
  bg: string; card: string; ink: string; ink2: string; ink3: string; hair: string;
  chip: string; chip2: string; scrim: string; lane: string; laneInk: string;
  good: string; warn: string; warnBg: string; warnInk: string; bad: string; badBg: string; badInk: string;
  flash: string; dark: boolean;
};

export const light: Palette = {
  bg: '#FBFAF6', card: '#FFFFFF', ink: '#1E2420', ink2: '#595D56', ink3: '#686C63', hair: '#E2E0D7',
  chip: '#EFEDE6', chip2: '#E6E3DA', scrim: 'rgba(18,20,16,0.42)', lane: '#1E2420', laneInk: '#FBFAF6',
  good: '#2E7D3A', warn: '#8A5A00', warnBg: '#FFF1CC', warnInk: '#4A3200', bad: '#B3261E', badBg: '#FBE3E0', badInk: '#5C1410',
  flash: '#F3F9D2', dark: false,
};

export const dark: Palette = {
  bg: '#121512', card: '#1B1F1B', ink: '#EEF0E6', ink2: '#ADB1A6', ink3: '#8C9087', hair: '#2C312C',
  chip: '#232823', chip2: '#2C322C', scrim: 'rgba(0,0,0,0.55)', lane: '#EEF0E6', laneInk: '#121512',
  good: '#6BC17A', warn: '#F0C060', warnBg: '#3A2E10', warnInk: '#F6E2B0', bad: '#F2867C', badBg: '#3A1A17', badInk: '#F8D5D0',
  flash: '#2A3314', dark: true,
};

export type GroupTone = { band: string; ink: string; deep: string };

const groupLight: Record<GroupColor, GroupTone> = {
  citrus: { band: '#D4EE6A', ink: '#2E3A12', deep: '#93AE22' },
  lilac: { band: '#C3AEF0', ink: '#2E2242', deep: '#7F62C2' },
  sky: { band: '#A9D8F5', ink: '#12324A', deep: '#3B88BF' },
  mint: { band: '#9FE3C4', ink: '#0F3B2A', deep: '#2E9C6C' },
  butter: { band: '#F3D46B', ink: '#3D3108', deep: '#B8921C' },
  rose: { band: '#F4A8C4', ink: '#4A1530', deep: '#C2457A' },
};

const groupDark: Record<GroupColor, GroupTone> = {
  ...groupLight,
  citrus: { band: '#A8BF3F', ink: '#2E3A12', deep: '#C6E04E' },
  lilac: { band: '#9B84D9', ink: '#2E2242', deep: '#C3AEF0' },
  sky: { band: '#7FB6DA', ink: '#12324A', deep: '#A9D8F5' },
  mint: { band: '#78C6A3', ink: '#0F3B2A', deep: '#9FE3C4' },
  butter: { band: '#D3B24A', ink: '#3D3108', deep: '#F3D46B' },
  rose: { band: '#D7869F', ink: '#4A1530', deep: '#F4A8C4' },
};

export const groupTone = (c: GroupColor, isDark: boolean): GroupTone => (isDark ? groupDark : groupLight)[c];

export const orb = {
  stops: ['#FFC2A8', '#F66B42', '#E9522D', '#A8321A'] as const,
  ink: '#3A1A10',
  ctaTop: '#F87A52', ctaBottom: '#E9522D', ctaInk: '#2A0F06',
};

/** Mix a hex color with transparency, used for tonal controls on a color band. */
export const alpha = (hex: string, a: number) => {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

export const radius = { badge: 6, key: 14, field: 16, card: 18, pill: 22, cta: 28, sheet: 30, ticket: 39 } as const;
export const space = { xs: 4, s: 8, m: 12, l: 16, xl: 20, side: 22, xxl: 24, xxxl: 32 } as const;

const tab: TextStyle = { fontVariant: ['tabular-nums'] };

export const type = {
  name: { fontFamily: fonts.cond, fontSize: 74, lineHeight: 70, letterSpacing: -1.2 } as TextStyle,
  title: { fontFamily: fonts.cond, fontSize: 40, lineHeight: 42, letterSpacing: -0.4 } as TextStyle,
  h1: { fontFamily: fonts.cond, fontSize: 34, lineHeight: 36 } as TextStyle,
  sentence: { fontFamily: fonts.display, fontSize: 30, lineHeight: 36, letterSpacing: -0.6 } as TextStyle,
  amount: { fontFamily: fonts.display, fontSize: 84, lineHeight: 90, letterSpacing: -3, ...tab } as TextStyle,
  ticket: { fontFamily: fonts.display, fontSize: 40, lineHeight: 44, letterSpacing: -1.2, ...tab } as TextStyle,
  h2: { fontFamily: fonts.bold, fontSize: 20, lineHeight: 24, letterSpacing: -0.2 } as TextStyle,
  body: { fontFamily: fonts.regular, fontSize: 16, lineHeight: 22 } as TextStyle,
  bodyStrong: { fontFamily: fonts.semibold, fontSize: 16, lineHeight: 22 } as TextStyle,
  sub: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 19 } as TextStyle,
  cap: { fontFamily: fonts.semibold, fontSize: 12.5, lineHeight: 17 } as TextStyle,
  num: { fontFamily: fonts.semibold, fontSize: 16, lineHeight: 22, ...tab } as TextStyle,
  button: { fontFamily: fonts.semibold, fontSize: 17, lineHeight: 22 } as TextStyle,
};

export const isWeb = Platform.OS === 'web';
/** Where a household that isn't shared lives: "this browser" on the web, "this phone" in the app. */
export const thisDevice = isWeb ? 'this browser' : 'this phone';
export const isAndroid = Platform.OS === 'android';
export const isIOS = Platform.OS === 'ios';
