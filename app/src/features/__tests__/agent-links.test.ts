import { describe, expect, test } from 'vitest';
import { AGENT_APPS, agentFailure, cursorInstallLink } from '@/features/agents/links';

describe('Add to an agent', () => {
  test('Cursor gets an install deep link carrying only the MCP address', () => {
    const link = cursorInstallLink('https://shared.numaworth.com/mcp');
    const url = new URL(link);
    expect(url.protocol).toBe('cursor:');
    expect(link.startsWith('cursor://anysphere.cursor-deeplink/mcp/install?')).toBe(true);
    expect(url.searchParams.get('name')).toBe('numa-shared');
    expect(JSON.parse(atob(url.searchParams.get('config')!))).toEqual({ url: 'https://shared.numaworth.com/mcp' });
  });

  test('Claude and ChatGPT open their own connector settings over https', () => {
    for (const app of Object.values(AGENT_APPS)) expect(new URL(app.open).protocol).toBe('https:');
  });

  test('explains the agent limit and leaves other failures to the general wording', () => {
    expect(agentFailure('TOO_MANY_AGENTS')).toMatch(/5 agents/);
    expect(agentFailure('NETWORK_UNAVAILABLE')).toBeNull();
  });
});
