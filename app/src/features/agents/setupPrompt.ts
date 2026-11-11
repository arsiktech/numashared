// "Copy setup prompt" (Settings, AI agents): one tap makes a secret-link connection for all of the
// person's households and copies a prompt they paste into their agent. The agent reads the prompt
// and adds the link to its own MCP config.
//
// Command syntax, checked 2026-11-09:
// - Claude Code: `claude mcp add --transport http <name> <url>` (code.claude.com/docs/en/mcp).
// - Codex CLI: a `[mcp_servers.<name>]` table with `url` in `~/.codex/config.toml`
//   (learn.chatgpt.com/docs/extend/mcp). Not `codex mcp add --url`: Codex 0.167 sees that the
//   server also offers OAuth and starts a browser sign-in, which this link doesn't need.
// - Cursor: `~/.cursor/mcp.json`, `{"mcpServers": {"<name>": {"url": "<url>"}}}` (cursor.com/docs/context/mcp).
// - Hermes Agent: `mcp_servers.<name>` with `url` and `enabled`, then `/reload-mcp`
//   (hermes-agent.nousresearch.com/docs/user-guide/features/mcp). `hermes config set` parses a
//   JSON value into a mapping, and `mcp_servers` accepts any child key.

/** The server name every harness stores the link under. */
const SERVER_NAME = 'numa-shared';

/** The setup line for each harness, in the order the prompt lists them. */
export function setupCommands(url: string): Array<{ harness: string; line: string }> {
  return [
    { harness: 'Claude Code', line: `claude mcp add --transport http ${SERVER_NAME} ${url}` },
    { harness: 'Codex CLI', line: `in ~/.codex/config.toml, add a [mcp_servers.${SERVER_NAME}] table with url = "${url}"` },
    { harness: 'Cursor', line: `in ~/.cursor/mcp.json, under "mcpServers", add "${SERVER_NAME}": {"url": "${url}"}` },
    { harness: 'Hermes Agent', line: `hermes config set mcp_servers.${SERVER_NAME} '{"url":"${url}","enabled":true}' then run /reload-mcp` },
  ];
}

/** Plain text addressed to the agent. `url` is the secret link (https://<site>/mcp/nsag_...). */
export function setupPrompt(url: string): string {
  return [
    'Connect yourself to Numa Shared for me. You will act as me: you can read my households and, unless I switch it off, add, edit and manage them.',
    '',
    'Numa Shared is a shared-expenses app. It records who paid and who owes whom in my households. It never moves money: a repayment only notes money that moved elsewhere.',
    '',
    `Endpoint: ${url}`,
    'It is an MCP server over Streamable HTTP. The secret in the link is the only sign-in it needs.',
    '',
    'The link is a secret: anyone who has it can act as me in my households. Do not repeat it in your replies. Store it only in your MCP config.',
    '',
    'Add it with the line for your harness:',
    ...setupCommands(url).map(({ harness, line }) => `- ${harness}: ${line}`),
    `- Any MCP client that supports Streamable HTTP: add a server named ${SERVER_NAME} with the endpoint above as its URL.`,
    'If the tools do not appear, restart or reload your session.',
    '',
    'Tools (each household argument is an id from list_households):',
    '- Read, always allowed: list_households, list_members, get_balances (positive means owed money), list_records (newest first; page with before_sequence).',
    '- Add expenses and repayments: add_expense, add_repayment.',
    '- Edit and void records: edit_record (pass the revision from list_records), void_record (with a reason).',
    '- Manage the household: rename_household, add_person, update_groups, create_invite.',
    'Amounts are whole minor units in the household currency: 12.50 EUR is amount_minor_units 1250 with currency EUR.',
    'Every change takes a request_id you choose. Reuse it only to retry the same call.',
    'Your changes show in the history as mine, via you. I can switch any group of tools off in Numa Shared, Settings, AI agents; a refused call names the switch.',
    'Change or void only what I ask for.',
    '',
    'After connecting, call list_households to confirm, and tell me which households you can see.',
  ].join('\n');
}

/** "Agent, 9 Nov 2026": the name a prompt connection gets. The connected time tells two apart. */
export function defaultAgentName(now: number): string {
  return `Agent, ${new Date(now).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

/**
 * Makes the connection and copies its prompt. `copy` is called at once, before anything is
 * awaited, with the prompt still on its way: Safari allows a clipboard write only inside the tap.
 * Resolves with the prompt and whether it reached the clipboard; rejects when the connection
 * could not be made, and then nothing was copied.
 */
export async function copySetupPrompt(deps: {
  connect: (name: string, potId: null) => Promise<{ link: string }>;
  copy: (text: Promise<string>) => Promise<boolean>;
  now: number;
}): Promise<{ prompt: string; copied: boolean }> {
  const made = deps.connect(defaultAgentName(deps.now), null).then(({ link }) => setupPrompt(link));
  const copied = deps.copy(made).catch(() => false);
  const prompt = await made;
  return { prompt, copied: await copied };
}

type ClipboardLike = {
  write?: (items: unknown[]) => Promise<void>;
  writeText?: (text: string) => Promise<void>;
};

/**
 * Writes text that is still on its way to the web clipboard. A ClipboardItem holding a promise
 * keeps the tap's permission (Safari, Chrome); writeText after the wait is the fallback.
 * False when neither worked or the text never came.
 */
export async function writeClipboardLater(
  text: Promise<string>,
  clipboard: ClipboardLike | undefined = (globalThis.navigator as { clipboard?: ClipboardLike } | undefined)?.clipboard,
  Item: (new (items: Record<string, Promise<Blob>>) => unknown) | undefined = (globalThis as { ClipboardItem?: new (items: Record<string, Promise<Blob>>) => unknown }).ClipboardItem,
): Promise<boolean> {
  if (!clipboard) return false;
  if (clipboard.write && Item) {
    try {
      await clipboard.write([new Item({ 'text/plain': text.then((t) => new Blob([t], { type: 'text/plain' })) })]);
      return true;
    } catch { /* try writeText */ }
  }
  if (!clipboard.writeText) return false;
  try {
    await clipboard.writeText(await text);
    return true;
  } catch {
    return false;
  }
}
