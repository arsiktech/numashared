import { describe, expect, test } from 'vitest';
import { AGENT_APPS, agentFailure } from '@/features/agents/links';

describe('Add to an agent', () => {
  test('Claude and ChatGPT open their own connector settings over https', () => {
    for (const app of Object.values(AGENT_APPS)) expect(new URL(app.open).protocol).toBe('https:');
  });

  test('explains the agent limit and leaves other failures to the general wording', () => {
    expect(agentFailure('TOO_MANY_AGENTS')).toMatch(/5 agents/);
    expect(agentFailure('NETWORK_UNAVAILABLE')).toBeNull();
  });
});
