// Where "Add to Claude", "Add to ChatGPT" and "Add to Cursor" send the person (Settings, AI agents).

/** Cursor installs an MCP server from a deep link carrying its config as base64 JSON. */
export function cursorInstallLink(url: string): string {
  const config = btoa(JSON.stringify({ url }));
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=numa-shared&config=${encodeURIComponent(config)}`;
}

/** Claude and ChatGPT take a custom connector by address, so the address is copied before their settings open. */
export const AGENT_APPS = {
  claude: { label: 'Add to Claude', open: 'https://claude.ai/customize/connectors', paste: 'In Claude, choose Add custom connector and paste it.' },
  chatgpt: { label: 'Add to ChatGPT', open: 'https://chatgpt.com/#settings/Connectors', paste: 'In ChatGPT, create a connector and paste it.' },
} as const;

/** Plain words for a refused agent action; null when the general explanation fits. */
export function agentFailure(code: string): string | null {
  if (code === 'TOO_MANY_AGENTS') return 'You already have 5 agents connected. Disconnect one first.';
  return null;
}
