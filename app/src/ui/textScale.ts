// How layouts follow the system text size (Dynamic Type). Kept free of React Native so tests can check it.

/**
 * iOS text scales: Large 1, XXXL about 1.35, then the accessibility sizes AX1 about 1.64 up to AX5
 * about 3.1. From AX1 on, Home and Add switch to layouts that grow with the text.
 */
export const LARGE_TEXT_SCALE = 1.5;

export const isLargeText = (fontScale: number) => fontScale >= LARGE_TEXT_SCALE;

/**
 * Most text grows with the system size. These caps are for text that is already display-sized at
 * the default size, so growing it further only pushes everything else off the screen. Each cap sits
 * above XXXL, so it only bites at the accessibility sizes.
 */
export const TEXT_CAP = {
  /** Big names and amounts on the color bands, 38 to 84 pt (the way iOS's own Phone keypad and Calculator stay put). */
  display: 1.4,
  /** The Add sentence and the keypad digits, 28 to 30 pt. */
  sentence: 1.5,
  /** Small labels inside fixed-shape controls: split bar segments, the Home ticket. */
  label: 2,
} as const;

/** The largest a capped text gets: "size" at a scale of "fontScale", but no more than "cap" times. */
export const cappedSize = (size: number, fontScale: number, cap: number) => size * Math.min(Math.max(fontScale, 1), cap);
