// How the Add sheet fits its screen. Kept free of React Native so tests can check it.

/** Below this height (a phone in landscape is about 390 pt) the whole sheet scrolls. */
export const SHORT_SHEET_HEIGHT = 560;

/** Keypad key height when the sheet scrolls: the 44 pt minimum touch target. */
export const SHORT_KEY_HEIGHT = 44;

export const isShortSheet = (screenH: number) => screenH < SHORT_SHEET_HEIGHT;

/**
 * At an accessibility text size the amount and keypad stay pinned above the Add button, but only
 * when the screen is tall enough: a short screen keeps the sheet that scrolls as a whole.
 */
export const pinsKeypad = (largeText: boolean, screenH: number) => largeText && !isShortSheet(screenH);
