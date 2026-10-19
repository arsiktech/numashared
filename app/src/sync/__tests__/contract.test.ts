import { afterEach, describe, expect, test } from 'vitest';
import {
  contractFor, EXTENDED_CONTRACT, getContract, LEGACY_CONTRACT, refreshContract, setContract,
} from '../contract';

const answer = (body: unknown, ok = true) => (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

afterEach(() => setContract(LEGACY_CONTRACT));

describe('client contract (Swift build 11 fence)', () => {
  test('stays on the old contract until production requires build 12', () => {
    expect(contractFor(null)).toBe(LEGACY_CONTRACT);
    expect(contractFor(11)).toBe(LEGACY_CONTRACT);
    expect(contractFor(12)).toBe(EXTENDED_CONTRACT);
    expect(LEGACY_CONTRACT.maxGroupSize).toBe(2);
    expect(getContract()).toBe(LEGACY_CONTRACT);
  });

  test('follows /app-config, and keeps what it knows when the answer is missing or odd', async () => {
    await refreshContract('https://x', answer({ minimumSupportedBuild: 12 }));
    expect(getContract()).toBe(EXTENDED_CONTRACT);
    await refreshContract('https://x', answer({}, false));
    expect(getContract()).toBe(EXTENDED_CONTRACT);
    await refreshContract('https://x', (async () => { throw new Error('offline'); }) as unknown as typeof fetch);
    expect(getContract()).toBe(EXTENDED_CONTRACT);
    await refreshContract('https://x', answer({ minimumSupportedBuild: null }));
    expect(getContract()).toBe(LEGACY_CONTRACT);
  });
});
