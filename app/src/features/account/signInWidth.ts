// How wide the web sign-in buttons are. Google draws its own "Continue with Google" button, between
// 200 and 400 px wide. The sign-in column is capped and centred at 400 px, so Apple's button and
// Google's are the same width at phone and desk widths.
import type { ViewStyle } from 'react-native';

export const GSI_MIN_WIDTH = 200;
export const GSI_MAX_WIDTH = 400;

/** The width to ask Google for, given the laid-out width of the box it draws into. */
export const gsiWidth = (hostWidth: number) => Math.max(GSI_MIN_WIDTH, Math.min(GSI_MAX_WIDTH, Math.floor(hostWidth)));

/**
 * The sign-in column on the web. A screen can put this on its other buttons too, so they line up
 * with the sign-in buttons.
 */
export const signInColumn: ViewStyle = { width: '100%', maxWidth: GSI_MAX_WIDTH, alignSelf: 'center' };
