import { describe, expect, test } from 'vitest';
import { proLinkText } from '@/features/agents/proLink';

describe('Pro app key', () => {
  test('names the household and says the key cannot change it', () => {
    const text = proLinkText('household-one-test', 'nspro_example');
    expect(text).toContain('Household: household-one-test');
    expect(text).toContain('Key: nspro_example');
    expect(text).toMatch(/cannot change/);
  });
});
