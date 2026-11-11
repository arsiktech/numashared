// "This month" is the local calendar month, the same calendar a record's day is written in.
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: async () => null, setItem: async () => {} } }));
const { localMonth } = await import('../model');

const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
const zone = env.TZ;
afterEach(() => {
  vi.useRealTimers();
  if (zone === undefined) delete env.TZ; else env.TZ = zone;
});

test.each([
  // 00:30 on 1 November in Madrid is still 31 October in UTC.
  ['Europe/Madrid', '2026-10-31T23:30:00Z', '2026-11'],
  // 22:30 on 31 October in New York is already 1 November in UTC.
  ['America/New_York', '2026-11-01T02:30:00Z', '2026-10'],
])('in %s at %s the month is %s', (tz, instant, month) => {
  env.TZ = tz;
  vi.useFakeTimers();
  vi.setSystemTime(new Date(instant));
  expect(localMonth()).toBe(month);
  expect(localMonth(new Date(instant))).toBe(month);
  expect(new Date().toISOString().slice(0, 7)).not.toBe(month);
});
