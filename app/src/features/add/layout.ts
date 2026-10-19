// How the Add sheet fits its screen. Kept free of React Native so tests can check it.

/** Below this height (a phone in landscape is about 390 pt) the whole sheet scrolls. */
export const SHORT_SHEET_HEIGHT = 560;

/** Keypad key height when the sheet scrolls: the 44 pt minimum touch target. */
export const SHORT_KEY_HEIGHT = 44;

export const isShortSheet = (screenH: number) => screenH < SHORT_SHEET_HEIGHT;
