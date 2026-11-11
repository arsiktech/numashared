import { afterEach, expect, test, vi } from 'vitest';
import { feedbackCaptureAllowed, feedbackCloneSkips, fetchFeedbackConfig, sendFeedback } from './feedback-client';
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
  class Element {
    parentElement: Element | null = null;
    hidden = false;
    display = 'block';
    self = false;
    ownerDocument!: { defaultView: { Element: typeof Element; getComputedStyle: (node: Element) => { display: string } } };
    constructor(readonly tagName: string) {}
    hasAttribute(name: string) { return name === 'hidden' && this.hidden; }
    matches(selector: string) {
      return selector.split(',').some((part) => {
        const token = part.trim();
        if (token === this.tagName.toLowerCase()) return true;
        if (token === '[data-fb-self]') return this.self;
        return false;
      });
    }
  }
  const view = { Element, getComputedStyle: (node: Element) => ({ display: node.display }) };
  const ownerDocument = { defaultView: view };
  const make = (tag: string) => {
    const node = new Element(tag);
    node.ownerDocument = ownerDocument;
    return node;
  };
  const inside = make('span');
  inside.parentElement = make('noscript');
  expect(feedbackCloneSkips(make('noscript') as never)).toBe(true);
  expect(feedbackCloneSkips(make('script') as never)).toBe(true);
  expect(feedbackCloneSkips(make('template') as never)).toBe(true);
  expect(feedbackCloneSkips(inside as never)).toBe(true);
  const hidden = make('div');
  hidden.hidden = true;
  expect(feedbackCloneSkips(hidden as never)).toBe(true);
  expect(feedbackCloneSkips(make('video') as never)).toBe(false);
  const self = make('div');
  self.self = true;
  expect(feedbackCloneSkips(self as never)).toBe(true);
  const folded = make('div');
  folded.display = 'none';
  expect(feedbackCloneSkips(folded as never)).toBe(true);
  expect(feedbackCloneSkips(make('div') as never)).toBe(false);
  expect(feedbackCloneSkips({ ownerDocument: undefined } as never)).toBe(false);
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
