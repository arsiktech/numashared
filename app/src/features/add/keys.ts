// Keyboard rules for the Add and Repay sheets on the web. Kept free of React Native so tests can check it.

/**
 * Tab jumps to the note only as the first key press, while nothing has focus and Shift isn't held.
 * After that Tab and Shift+Tab move through the controls as usual.
 */
export function tabJumpsToNote(nothingFocused: boolean, shift: boolean) {
  return nothingFocused && !shift;
}
