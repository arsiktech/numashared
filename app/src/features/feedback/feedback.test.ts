import { afterEach, expect, test, vi } from 'vitest';
import { feedbackCaptureAllowed, feedbackCloneSkipped, fetchFeedbackConfig, sendFeedback } from './feedback-client';
import { feedbackContext, feedbackEndpoint, feedbackEndpointFrom, feedbackLocale, shouldCaptureFeedback } from './config';

const KEYS = ['EXPO_PUBLIC_FEEDBACK_URL', 'EXPO_PUBLIC_FEEDBACK_APP', 'EXPO_PUBLIC_FEEDBACK_KEY'] as const;
const previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of KEYS) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  vi.unstubAllGlobals();
});

test('feedback stays off unless the address, app and key are all set', () => {
  expect(feedbackEndpointFrom({})).toBeNull();
  expect(feedbackEndpointFrom({ EXPO_PUBLIC_FEEDBACK_URL: 'https://feedback.invalid' })).toBeNull();
  expect(feedbackEndpointFrom({
    EXPO_PUBLIC_FEEDBACK_URL: 'https://feedback.invalid',
    EXPO_PUBLIC_FEEDBACK_APP: 'demo',
  })).toBeNull();
  expect(feedbackEndpointFrom({
    EXPO_PUBLIC_FEEDBACK_URL: '   ',
    EXPO_PUBLIC_FEEDBACK_APP: 'demo',
    EXPO_PUBLIC_FEEDBACK_KEY: 'k',
  })).toBeNull();

  for (const key of KEYS) delete process.env[key];
  expect(feedbackEndpoint()).toBeNull();
  process.env.EXPO_PUBLIC_FEEDBACK_URL = 'https://feedback.invalid/';
  process.env.EXPO_PUBLIC_FEEDBACK_APP = 'demo';
  expect(feedbackEndpoint()).toBeNull();
  process.env.EXPO_PUBLIC_FEEDBACK_KEY = 'k';
  expect(feedbackEndpoint()).toEqual({ url: 'https://feedback.invalid', app: 'demo', key: 'k' });
});

test('the screenshot clone skips noscript and other elements that are not shown', () => {
  const element = (tag: string, extra: { hidden?: boolean; self?: boolean; connected?: boolean; style?: { display: string; visibility: string; contentVisibility: string } } = {}) => ({
    nodeType: 1,
    isConnected: extra.connected ?? false,
    matches(selector: string) {
      return selector.split(',').some((part) => {
        const token = part.trim();
        if (token === tag) return true;
        if (token === '[hidden]') return extra.hidden === true;
        if (token === '[data-fb-self]') return extra.self === true;
        return false;
      });
    },
    ownerDocument: extra.style ? { defaultView: { getComputedStyle: () => extra.style } } : undefined,
  });
  const shown = { display: 'block', visibility: 'visible', contentVisibility: 'visible' };
  expect(feedbackCloneSkipped(element('noscript') as never)).toBe(true);
  expect(feedbackCloneSkipped(element('script') as never)).toBe(true);
  expect(feedbackCloneSkipped(element('template') as never)).toBe(true);
  expect(feedbackCloneSkipped(element('div', { hidden: true }) as never)).toBe(true);
  expect(feedbackCloneSkipped(element('video') as never)).toBe(true);
  expect(feedbackCloneSkipped(element('div', { self: true }) as never)).toBe(true);
  expect(feedbackCloneSkipped(element('div', { connected: true, style: { ...shown, display: 'none' } }) as never)).toBe(true);
  expect(feedbackCloneSkipped(element('div', { connected: true, style: { ...shown, visibility: 'hidden' } }) as never)).toBe(true);
  expect(feedbackCloneSkipped(element('div', { connected: true, style: shown }) as never)).toBe(false);
  expect(feedbackCloneSkipped({ nodeType: 3 } as never)).toBe(false);
});

test('a failed lookup keeps the button off', async () => {
  vi.stubGlobal('fetch', async () => { throw new Error('offline'); });
  await expect(fetchFeedbackConfig({ url: 'https://feedback.invalid', app: 'demo', key: 'k' }))
    .resolves.toEqual({ enabled: false, screenshots: false, capture: [] });
});

const WEB_SCREENS = [
  '/', '/welcome', '/home', '/history', '/settings', '/settings/people', '/settings/export',
  '/settings/agents', '/settings/card-sync', '/settings/delete-account', '/import', '/join',
  '/connect', '/setup/account', '/setup/new', '/setup/groups', '/setup/invite', '/setup/opening',
];

test('an empty capture list takes no screenshot, and /* takes one on every screen', () => {
  expect(feedbackCaptureAllowed([], '/home')).toBe(false);
  expect(shouldCaptureFeedback({ enabled: true, screenshots: true, capture: [] }, '/home')).toBe(false);
  expect(shouldCaptureFeedback({ enabled: true, screenshots: false, capture: ['/*'] }, '/home')).toBe(false);
  for (const path of WEB_SCREENS) {
    expect(feedbackCaptureAllowed(['/*'], path)).toBe(true);
    expect(shouldCaptureFeedback({ enabled: true, screenshots: true, capture: ['/*'] }, path)).toBe(true);
  }
  expect(shouldCaptureFeedback({ enabled: true, screenshots: true, capture: ['/home'] }, '/settings')).toBe(false);
});

test('a note sends the path, mood and theme, and no identity', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ id: 'n1' }), { status: 201, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('window', { innerWidth: 1280, innerHeight: 800 });

  const result = await sendFeedback(
    { url: 'https://feedback.invalid', app: 'demo', key: 'k' },
    {
      note: '  The balance looks off  ',
      path: '/home?code=secret#part',
      locale: feedbackLocale('en-US'),
      mood: 'unhappy',
      context: feedbackContext('dark'),
    },
  );

  expect(result).toEqual({ ok: true, imageDropped: false });
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe('https://feedback.invalid/v1/apps/demo/notes');
  expect(calls[0].init.method).toBe('POST');
  const headers = calls[0].init.headers as Record<string, string>;
  expect(headers['x-feedback-key']).toBe('k');
  const body = JSON.parse(String(calls[0].init.body));
  expect(body).toEqual({
    note: 'The balance looks off',
    path: '/home',
    locale: 'en-US',
    mood: 'unhappy',
    viewport: { width: 1280, height: 800 },
    context: { theme: 'dark' },
  });
  expect(body).not.toHaveProperty('screenshot');
  expect(JSON.stringify(body)).not.toMatch(/email|userId|name/i);

  calls.length = 0;
  const withShot = await sendFeedback(
    { url: 'https://feedback.invalid', app: 'demo', key: 'k' },
    { note: 'With a picture', path: '/settings', mood: 'happy', shot: { dataUrl: 'data:image/jpeg;base64,aa', viewport: { width: 800, height: 600 } }, context: feedbackContext('light') },
  );
  expect(withShot.ok).toBe(true);
  const pictured = JSON.parse(String(calls[0].init.body));
  expect(pictured.path).toBe('/settings');
  expect(pictured.mood).toBe('happy');
  expect(pictured.screenshot).toBe('data:image/jpeg;base64,aa');
  expect(pictured.context).toEqual({ theme: 'light' });
});

test('context is only the theme', () => {
  expect(feedbackContext('light')).toEqual({ theme: 'light' });
  expect(feedbackLocale('fr-FR')).toBe('fr-FR');
  expect(feedbackLocale('zh-Hans')).toBe('zh');
  expect(feedbackLocale('')).toBeUndefined();
});
