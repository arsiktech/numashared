// The web feedback control stays off until the address, app and key are all set.
// A screenshot is taken exactly when the service's capture list allows the current path.
// This app keeps no path list of its own.
import type { FeedbackCaptureConfig, FeedbackEndpoint } from './feedback-client';
import { feedbackCaptureAllowed } from './feedback-client';

export type FeedbackEnv = {
  EXPO_PUBLIC_FEEDBACK_URL?: string;
  EXPO_PUBLIC_FEEDBACK_APP?: string;
  EXPO_PUBLIC_FEEDBACK_KEY?: string;
};

/** Null when any value is missing, so the button cannot appear by accident. */
export function feedbackEndpointFrom(env: FeedbackEnv): FeedbackEndpoint | null {
  const url = env.EXPO_PUBLIC_FEEDBACK_URL?.trim() ?? '';
  const app = env.EXPO_PUBLIC_FEEDBACK_APP?.trim() ?? '';
  const key = env.EXPO_PUBLIC_FEEDBACK_KEY?.trim() ?? '';
  if (!url || !app || !key) return null;
  return { url: url.replace(/\/+$/, ''), app, key };
}

export function feedbackEndpoint(): FeedbackEndpoint | null {
  return feedbackEndpointFrom({
    EXPO_PUBLIC_FEEDBACK_URL: process.env.EXPO_PUBLIC_FEEDBACK_URL,
    EXPO_PUBLIC_FEEDBACK_APP: process.env.EXPO_PUBLIC_FEEDBACK_APP,
    EXPO_PUBLIC_FEEDBACK_KEY: process.env.EXPO_PUBLIC_FEEDBACK_KEY,
  });
}

/** Small non-personal facts only. Never an id, email or name. */
export function feedbackContext(theme: 'light' | 'dark'): Record<string, string> {
  return { theme };
}

/** True when the service allows a screenshot of this path. No extra path filter is applied here. */
export function shouldCaptureFeedback(config: FeedbackCaptureConfig, path: string): boolean {
  return config.screenshots === true && feedbackCaptureAllowed(config.capture, path);
}

/** A locale tag the service accepts, or nothing. */
export function feedbackLocale(language: string | undefined): string | undefined {
  if (!language) return undefined;
  if (/^[a-z]{2}(?:-[A-Z]{2})?$/.test(language)) return language;
  const lang = language.slice(0, 2).toLowerCase();
  return /^[a-z]{2}$/.test(lang) ? lang : undefined;
}
