// The Home system: one spacing scale, one type scale and five colour roles. Home (phone and desk),
// its top bar, record rows and the desk history use only these. Other screens still use tokens.ts.
//
// Colour roles:
//   canvas  the page behind the history, and every pane on the desk.
//   ink     primary text, icons, the selected filter, repayment tiles.
//   muted   secondary text: labels, times, effects.
//   accent  adding an expense, and nothing else: the orb's colour.
//   group   each group's own hue: the only colour that says who. Groups fill full-bleed bands.
// Lines and quiet fills are ink at two fixed strengths, not more colours. Text on a filled colour
// (accent or group) is whichever of ink and canvas is darker. No gradients and no blurred shadows,
// with one exception the owner chose on 13 Nov 2026: the orb keeps its glossy sphere, because it
// is the signature add button. The balance ticket's depth is a solid ink layer, not a shadow.
import type { TextStyle } from 'react-native';
import type { Group, GroupColor } from '@/core/types';
import { alpha, dark, fonts, groupTone, light, orb } from './tokens';

/** Spacing steps, in points. Use the step number: space[4] is 16. */
export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 24, 6: 32, 7: 48 } as const;

/** Panels and rows share one corner. Round controls use half their height. */
export const corner = space[4];

const tab: TextStyle = { fontVariant: ['tabular-nums'] };

/**
 * The "Sticker" scale, chosen by the owner on 13 Nov 2026 from clickable mockups.
 * Sizes: 13, 14, 15, 18, 48, 72, 80. `strong` is body at a heavier weight, not another size.
 * Instrument Sans carries reading text; the condensed face carries labels, headings, names and
 * the balance. The balance sits on a tilted ticket, so it is read first although the names are
 * a step larger.
 */
export const text = {
  meta: { fontFamily: fonts.medium, fontSize: 13, lineHeight: 18 },
  label: { fontFamily: fonts.cond, fontSize: 14, lineHeight: 16, letterSpacing: 1.4, textTransform: 'uppercase' },
  body: { fontFamily: fonts.regular, fontSize: 15, lineHeight: 22 },
  strong: { fontFamily: fonts.semibold, fontSize: 15, lineHeight: 22 },
  title: { fontFamily: fonts.bold, fontSize: 18, lineHeight: 24 },
  heading: { fontFamily: fonts.cond, fontSize: 48, lineHeight: 50, letterSpacing: -0.5 },
  hero: { fontFamily: fonts.cond, fontSize: 72, lineHeight: 74, letterSpacing: -1.4, ...tab },
  name: { fontFamily: fonts.cond, fontSize: 80, lineHeight: 76, letterSpacing: -1.6 },
} satisfies Record<string, TextStyle>;

/** Amounts in rows and stats line up in columns. */
export const figures = tab;

/** The orb's base orange. The orb draws it as a glossy sphere; nothing else on Home is orange. */
export const ACCENT = orb.stops[1];

export type Roles = {
  canvas: string;
  ink: string;
  muted: string;
  accent: string;
  group: (g: Group | GroupColor) => string;
  /** Ink at 12%: dividers and outlines. */
  line: string;
  /** Ink at 6%: quiet fills (chips, selected rows, icon tiles). */
  wash: string;
  /** Text and icons on accent or group fills. */
  onFill: string;
};

export function roles(isDark: boolean): Roles {
  const p = isDark ? dark : light;
  return {
    canvas: p.bg,
    ink: p.ink,
    muted: p.ink2,
    accent: ACCENT,
    group: (g) => groupTone(typeof g === 'string' ? g : g.color, isDark).band,
    line: alpha(p.ink, 0.12),
    wash: alpha(p.ink, 0.06),
    onFill: isDark ? p.bg : p.ink,
  };
}
